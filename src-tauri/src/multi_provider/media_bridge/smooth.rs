use super::*;
use crate::{
    media_budget::{MediaBudget, Traffic, BURST, MIN_RATE},
    media_cache::{digest_parts, MediaCache},
};
use axum::{body::Bytes, http::HeaderValue};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
    io,
    sync::Weak,
};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};

const BLOCK: u64 = BURST as u64;
const MEMORY_BLOCKS: usize = 256;
const PRELOAD_BYTES: u64 = 512 * 1024;
const PRELOAD_SECONDS: u64 = 8;
const STREAM_CLIENTS: usize = 8;

#[derive(Clone, Copy)]
pub(crate) enum CacheUrlIdentity {
    FullUrl,
    QqOriginal,
}

impl CacheUrlIdentity {
    fn resource(self, url: &url::Url) -> Cow<'_, str> {
        use url::Position;

        let Some(query) = url.query().filter(|_| matches!(self, Self::QqOriginal)) else {
            return Cow::Borrowed(url.as_str());
        };
        let mut retained = Vec::new();
        let mut removed_signature = false;
        for field in query.split('&') {
            if matches!(field.split_once('='), Some(("guid" | "vkey", _))) {
                removed_signature = true;
            } else {
                retained.push(field);
            }
        }
        if !removed_signature {
            return Cow::Borrowed(url.as_str());
        }
        let mut resource = url[..Position::AfterPath].to_owned();
        if !retained.is_empty() {
            resource.push('?');
            resource.push_str(&retained.join("&"));
        }
        resource.push_str(&url[Position::AfterQuery..]);
        Cow::Owned(resource)
    }
}

pub(crate) struct SmoothRuntime {
    pub budget: Arc<MediaBudget>,
    pub cache: Arc<MediaCache>,
    shared: Mutex<HashMap<String, Weak<Blocks>>>,
    requests: Semaphore,
}

impl SmoothRuntime {
    pub fn new(cache: Arc<MediaCache>) -> Self {
        Self {
            budget: cache.budget.clone(),
            cache,
            shared: Mutex::default(),
            requests: Semaphore::new(STREAM_CLIENTS),
        }
    }

    pub fn source(
        self: &Arc<Self>,
        scope: Option<String>,
        generation: u64,
        bitrate: Option<u64>,
        duration_ms: u64,
        cache_url_identity: CacheUrlIdentity,
    ) -> Arc<SmoothSource> {
        Arc::new(SmoothSource {
            runtime: self.clone(),
            scope,
            generation,
            cache_url_identity,
            bitrate: AtomicU64::new(bitrate.unwrap_or(0)),
            duration_ms: AtomicU64::new(duration_ms),
            mode: OnceCell::new(),
            trace: std::sync::OnceLock::new(),
            first_data: std::sync::Once::new(),
            prior: Mutex::new(None),
        })
    }

    fn shared_blocks(&self, key: Option<&str>, generation: u64) -> (Arc<Blocks>, bool) {
        let epoch = self.cache.epoch();
        let make = || Arc::new(Blocks::new(epoch));
        let Some(key) = key else {
            return (make(), false);
        };
        let mut shared = self.shared.lock().unwrap();
        shared.retain(|_, blocks| blocks.strong_count() > 0);
        let key = format!("{key}:{generation}:{epoch}");
        if let Some(blocks) = shared.get(&key).and_then(Weak::upgrade) {
            return (blocks, true);
        }
        let blocks = make();
        shared.insert(key, Arc::downgrade(&blocks));
        (blocks, false)
    }
}

pub(crate) struct SmoothSource {
    pub runtime: Arc<SmoothRuntime>,
    scope: Option<String>,
    generation: u64,
    cache_url_identity: CacheUrlIdentity,
    bitrate: AtomicU64,
    duration_ms: AtomicU64,
    mode: OnceCell<Mode>,
    trace: std::sync::OnceLock<crate::file_logging::PlaybackTrace>,
    first_data: std::sync::Once,
    prior: Mutex<Option<Arc<dyn Send + Sync>>>,
}

enum Mode {
    Ranges(Ranges),
    Sequential(Sequential),
}

struct Ranges {
    length: u64,
    mime: String,
    validator: Option<HeaderValue>,
    disk_key: Option<String>,
    blocks: Arc<Blocks>,
    reused_live: bool,
    retain: std::sync::atomic::AtomicBool,
}

struct Sequential {
    length: Option<u64>,
    mime: String,
    initial: AsyncMutex<Option<reqwest::Response>>,
    readers: Arc<Semaphore>,
    extent: Arc<AtomicU64>,
}

struct Blocks {
    epoch: u64,
    flights: [AsyncMutex<()>; 64],
    memory: Mutex<(u64, BTreeMap<u64, (u64, Bytes)>)>,
}

impl Blocks {
    fn new(epoch: u64) -> Self {
        Self {
            epoch,
            flights: std::array::from_fn(|_| AsyncMutex::new(())),
            memory: Mutex::default(),
        }
    }

    fn read(&self, offset: u64) -> Option<Bytes> {
        let mut memory = self.memory.lock().unwrap();
        memory.0 += 1;
        let used = memory.0;
        let entry = memory.1.get_mut(&offset)?;
        entry.0 = used;
        Some(entry.1.clone())
    }

    fn insert(&self, offset: u64, bytes: Bytes) {
        let mut memory = self.memory.lock().unwrap();
        memory.0 += 1;
        let used = memory.0;
        memory.1.insert(offset, (used, bytes));
        if memory.1.len() > MEMORY_BLOCKS {
            if let Some((&drop, _)) = memory.1.iter().min_by_key(|(_, (used, _))| used) {
                memory.1.remove(&drop);
            }
        }
    }

    fn buffered_until(&self, byte: u64) -> u64 {
        let memory = self.memory.lock().unwrap();
        let mut end = byte / BLOCK * BLOCK;
        while let Some((_, bytes)) = memory.1.get(&end) {
            end += bytes.len() as u64;
        }
        end.max(byte)
    }
}

fn strong_etag(headers: &HeaderMap) -> Option<HeaderValue> {
    let tag = headers.get(header::ETAG)?;
    let text = tag.to_str().ok()?;
    let opaque = text.strip_prefix('"')?.strip_suffix('"')?;
    (!opaque.contains('"')).then(|| tag.clone())
}

fn storage_allowed(headers: &HeaderMap) -> bool {
    headers.get_all(header::CACHE_CONTROL).iter().all(|value| {
        value.to_str().is_ok_and(|value| {
            !value.split(',').any(|directive| {
                directive
                    .trim()
                    .split('=')
                    .next()
                    .is_some_and(|name| name.trim().eq_ignore_ascii_case("no-store"))
            })
        })
    }) && !headers.contains_key(header::VARY)
        && !headers.contains_key(header::SET_COOKIE)
}

fn encoding_is_identity(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_ENCODING)
        .is_none_or(|encoding| encoding == "identity")
}

fn content_range(headers: &HeaderMap) -> Option<(u64, u64, u64)> {
    let value = headers
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn bounds(range: &HeaderValue, length: u64) -> Option<(u64, u64)> {
    let (start, end) = range
        .to_str()
        .ok()?
        .strip_prefix("bytes=")?
        .split_once('-')?;
    if start.is_empty() {
        return Some((length.saturating_sub(end.parse().ok()?), length));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length
    } else {
        end.parse::<u64>().ok()?.saturating_add(1).min(length)
    };
    Some((start, end))
}

fn range_header(start: u64, end: u64) -> HeaderValue {
    HeaderValue::from_str(&format!("bytes={start}-{end}")).unwrap()
}

impl SmoothSource {
    pub(super) fn set_trace(&self, trace: crate::file_logging::PlaybackTrace) {
        let _ = self.trace.set(trace);
    }

    fn note_first_data(&self, origin: &'static str) {
        self.first_data.call_once(|| {
            if let Some(trace) = self.trace.get() {
                trace.mark("first_data", origin);
            }
        });
    }

    #[cfg(feature = "manual-spikes")]
    pub(super) fn probe_properties(&self) -> Option<(bool, bool, bool)> {
        Some(match self.mode.get()? {
            Mode::Ranges(ranges) => (true, ranges.validator.is_some(), ranges.disk_key.is_some()),
            Mode::Sequential(_) => (false, false, false),
        })
    }
    pub fn hold_prior(&self, prior: Arc<dyn Send + Sync>) {
        *self.prior.lock().unwrap() = Some(prior);
    }

    pub fn release_prior(&self) {
        self.prior.lock().unwrap().take();
    }

    pub fn set_duration(&self, duration_ms: u64) {
        self.duration_ms.store(duration_ms, Ordering::Relaxed);
    }

    pub fn bytes_per_second(&self) -> Option<u64> {
        let rate = self.bitrate.load(Ordering::Relaxed) / 8;
        if rate > 0 {
            return Some(rate);
        }
        let duration = self.duration_ms.load(Ordering::Relaxed);
        let length = match self.mode.get()? {
            Mode::Ranges(ranges) => ranges.length,
            Mode::Sequential(stream) => stream.length?,
        };
        length
            .saturating_mul(1000)
            .checked_div(duration)
            .filter(|rate| *rate > 0)
    }

    pub fn buffered_until(&self, byte: u64) -> Option<u64> {
        match self.mode.get()? {
            Mode::Ranges(ranges) => Some(ranges.blocks.buffered_until(byte)),
            Mode::Sequential(stream) => Some(stream.extent.load(Ordering::Relaxed)),
        }
    }

    fn foreground_rate(&self) {
        self.runtime.budget.set_bitrate(
            self.bytes_per_second()
                .unwrap_or(MIN_RATE / 2)
                .saturating_mul(8),
        );
    }

    async fn mode(&self, source: &Source, traffic: Traffic) -> Result<&Mode, StatusCode> {
        self.mode
            .get_or_try_init(|| async {
                // Validate the effective byte representation online on every fresh
                // playback authorization, including a completely cached recording.
                let _permit = self.runtime.requests.acquire().await.unwrap();
                self.runtime.budget.reserve(1, traffic).await;
                let span = self.trace.get().map(|trace| trace.begin("cdn_probe"));
                let response = fetch(source, Method::GET, Some(range_header(0, 0)), None).await;
                if let Some(span) = span {
                    span.finish(match &response {
                        Ok((upstream, _)) if upstream.status() == StatusCode::PARTIAL_CONTENT => "range_headers",
                        Ok((upstream, _)) if upstream.status() == StatusCode::OK => "stream_headers",
                        _ => "failed",
                    });
                }
                let (mut upstream, index) = response?;
                let headers = upstream.headers();
                let mime = media_type(source, headers)
                    .ok_or(StatusCode::BAD_GATEWAY)?
                    .to_owned();
                if !encoding_is_identity(headers) {
                    return Err(StatusCode::BAD_GATEWAY);
                }
                if upstream.status() == StatusCode::OK {
                    let length = upstream.content_length();
                    return Ok(Mode::Sequential(Sequential {
                        length,
                        mime,
                        initial: AsyncMutex::new(Some(upstream)),
                        readers: Arc::new(Semaphore::new(1)),
                        extent: Arc::default(),
                    }));
                }
                let Some((0, 0, length)) = content_range(headers) else {
                    return Err(StatusCode::BAD_GATEWAY);
                };
                let validator = strong_etag(headers);
                let url = if index == 0 {
                    &source.url
                } else {
                    &source.backups[index - 1].0
                };
                let retain = storage_allowed(headers);
                let disk_key = self
                    .scope
                    .as_deref()
                    .filter(|_| retain)
                    .zip(validator.as_ref().and_then(|value| value.to_str().ok()))
                    .map(|(scope, tag)| {
                        // QQ rotates its original-audio signatures independently
                        // of the recording. Only the cache identity drops them.
                        let resource = self.cache_url_identity.resource(url);
                        digest_parts(&[scope, &resource, &mime, tag, &length.to_string()])
                    });
                let probe_traffic = if matches!(traffic, Traffic::Preload) {
                    Traffic::PreloadProbe
                } else {
                    Traffic::Probe
                };
                self.read_exact(&mut upstream, 1, probe_traffic).await?;
                let (blocks, reused_live) = self
                    .runtime
                    .shared_blocks(disk_key.as_deref(), self.generation);
                *source.length.lock().unwrap() = Some(length);
                Ok(Mode::Ranges(Ranges {
                    length,
                    mime,
                    validator,
                    disk_key,
                    blocks,
                    reused_live,
                    retain: std::sync::atomic::AtomicBool::new(retain),
                }))
            })
            .await
    }

    async fn read_exact(
        &self,
        upstream: &mut reqwest::Response,
        len: usize,
        traffic: Traffic,
    ) -> Result<Bytes, StatusCode> {
        let mut bytes = Vec::with_capacity(len);
        while let Some(chunk) = upstream
            .chunk()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
        {
            self.runtime.budget.record(traffic, chunk.len());
            if chunk.len() > len - bytes.len() {
                return Err(StatusCode::BAD_GATEWAY);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() == len {
            Ok(Bytes::from(bytes))
        } else {
            Err(StatusCode::BAD_GATEWAY)
        }
    }

    async fn block(
        &self,
        source: &Source,
        ranges: &Ranges,
        offset: u64,
        traffic: Traffic,
    ) -> Result<Bytes, StatusCode> {
        if !source_allowed(source) {
            return Err(StatusCode::NOT_FOUND);
        }
        let stripe = (offset / BLOCK) as usize % ranges.blocks.flights.len();
        let _flight = ranges.blocks.flights[stripe].lock().await;
        let length = (ranges.length - offset).min(BLOCK) as usize;
        if let Some(bytes) = ranges
            .blocks
            .read(offset)
            .filter(|_| ranges.retain.load(Ordering::Relaxed))
        {
            self.runtime
                .budget
                .totals
                .cache
                .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            self.note_first_data("memory");
            return Ok(bytes);
        }
        if let Some(key) = ranges
            .disk_key
            .clone()
            .filter(|_| ranges.retain.load(Ordering::Relaxed))
        {
            let cache = self.runtime.cache.clone();
            let bytes = tokio::task::spawn_blocking(move || cache.read(&key, offset, length))
                .await
                .ok()
                .flatten();
            if let Some(bytes) = bytes {
                let totals = &self.runtime.budget.totals;
                totals
                    .cache
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                if matches!(traffic, Traffic::Audio) {
                    totals
                        .disk_cache
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                }
                let bytes = Bytes::from(bytes);
                ranges.blocks.insert(offset, bytes.clone());
                self.note_first_data("disk");
                return Ok(bytes);
            }
        }
        let end = offset + length as u64 - 1;
        let _permit = self.runtime.requests.acquire().await.unwrap();
        self.runtime.budget.reserve(length, traffic).await;
        let (mut upstream, _) = fetch(
            source,
            Method::GET,
            Some(range_header(offset, end)),
            ranges.validator.clone(),
        )
        .await?;
        if upstream.status() != StatusCode::PARTIAL_CONTENT
            || content_range(upstream.headers()) != Some((offset, end, ranges.length))
            || media_type(source, upstream.headers()) != Some(ranges.mime.as_str())
            || !encoding_is_identity(upstream.headers())
            || ranges.validator.is_some()
                && upstream.headers().contains_key(header::ETAG)
                && strong_etag(upstream.headers()) != ranges.validator
        {
            return Err(StatusCode::BAD_GATEWAY);
        }
        let may_store = storage_allowed(upstream.headers());
        if !may_store {
            ranges.retain.store(false, Ordering::Relaxed);
        }
        let bytes = self.read_exact(&mut upstream, length, traffic).await?;
        drop(_permit);
        source
            .metrics
            .bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if !source_allowed(source) {
            return Err(StatusCode::NOT_FOUND);
        }
        let retain = ranges.retain.load(Ordering::Relaxed);
        self.note_first_data("network");
        if retain {
            ranges.blocks.insert(offset, bytes.clone());
        }
        if let Some(key) = ranges.disk_key.clone().filter(|_| retain) {
            let epoch = ranges.blocks.epoch;
            let data = bytes.clone();
            let cache = self.runtime.cache.clone();
            // Publish outside decoder and session locks. A clear increments the
            // epoch, including while this write is waiting on the blocking pool.
            let _ = tokio::task::spawn_blocking(move || {
                cache.write(
                    &key,
                    offset,
                    &data,
                    epoch,
                    matches!(traffic, Traffic::Preload),
                );
            })
            .await;
        }
        Ok(bytes)
    }

    pub(super) async fn preload(&self, source: &Source) -> bool {
        let mut revoked = source.revoked.subscribe();
        tokio::select! {
            result = self.preload_allowed(source) => result.is_ok(),
            _ = revoked.changed() => false,
        }
    }

    async fn preload_allowed(&self, source: &Source) -> Result<(), StatusCode> {
        let ranges = match self.mode(source, Traffic::Preload).await? {
            Mode::Ranges(ranges) => ranges,
            Mode::Sequential(sequence) => {
                sequence.initial.lock().await.take();
                return Err(StatusCode::OK);
            }
        };
        // A speculative resolve gets its own handle. Without a validator for
        // promotion, downloading the beginning cannot help a fresh playback.
        if ranges.disk_key.is_none() || !ranges.retain.load(Ordering::Relaxed) {
            return Err(StatusCode::OK);
        }
        let index = *source.dash_index.lock().unwrap();
        let index = index.map(|(start, end)| (start / BLOCK * BLOCK, ranges.length.min(end + 1)));
        let rate = self.bytes_per_second().unwrap_or(16_000);
        let prefix = rate
            .saturating_mul(PRELOAD_SECONDS)
            .min(PRELOAD_BYTES)
            .div_ceil(BLOCK)
            * BLOCK;
        let mut offsets: Vec<_> = (0..ranges.length.min(prefix)).step_by(BURST).collect();
        if let Some((start, end)) = index {
            let index_offsets = (start..end).step_by(BURST);
            offsets = index_offsets.chain(offsets).collect();
            offsets.sort_unstable();
            offsets.dedup();
        }
        for offset in offsets.into_iter().take((PRELOAD_BYTES / BLOCK) as usize) {
            self.block(source, ranges, offset, Traffic::Preload).await?;
        }
        Ok(())
    }

    pub(super) async fn serve(
        self: &Arc<Self>,
        source: &Arc<Source>,
        method: &Method,
        range: Option<&HeaderValue>,
    ) -> Response {
        let mut revoked = source.revoked.subscribe();
        tokio::select! {
            result = self.prepare(source, method, range) => result.unwrap_or_else(response),
            _ = revoked.changed() => response(StatusCode::NOT_FOUND),
        }
    }

    async fn prepare(
        self: &Arc<Self>,
        source: &Arc<Source>,
        method: &Method,
        range: Option<&HeaderValue>,
    ) -> Result<Response, StatusCode> {
        let mode = self.mode(source, Traffic::Probe).await?;
        if !matches!(mode, Mode::Ranges(ranges) if ranges.reused_live) {
            self.release_prior();
        }
        if !source_allowed(source) {
            return Err(StatusCode::NOT_FOUND);
        }
        self.foreground_rate();
        match mode {
            Mode::Ranges(ranges) => {
                let length = ranges.length;
                let Some((start, end)) = range.map_or(Some((0, length)), |r| bounds(r, length))
                else {
                    return Ok(Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                        .header(header::CONTENT_LENGTH, "0")
                        .body(Body::empty())
                        .unwrap());
                };
                let mut builder = Response::builder()
                    .header(header::CONTENT_TYPE, &ranges.mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CACHE_CONTROL, "no-store")
                    .header(header::CONTENT_LENGTH, end - start);
                if range.is_some() {
                    builder = builder.status(StatusCode::PARTIAL_CONTENT).header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{}/{length}", end - 1),
                    );
                }
                let body = if *method == Method::HEAD {
                    Body::empty()
                } else {
                    self.range_body(source, start, end)
                };
                Ok(builder.body(body).unwrap())
            }
            Mode::Sequential(sequence) => {
                let mut builder = Response::builder()
                    .header(header::CACHE_CONTROL, "no-store")
                    .header(header::CONTENT_TYPE, &sequence.mime);
                if let Some(length) = sequence.length {
                    builder = builder.header(header::CONTENT_LENGTH, length);
                }
                if *method == Method::HEAD {
                    return Ok(builder.body(Body::empty()).unwrap());
                }
                let permit = sequence.readers.clone().acquire_owned().await.unwrap();
                let mut initial = sequence.initial.lock().await;
                let upstream = if let Some(first) = initial.take() {
                    first
                } else {
                    self.runtime.budget.reserve(BURST, Traffic::Audio).await;
                    let (response, _) = fetch(source, Method::GET, None, None).await?;
                    if response.status() != StatusCode::OK
                        || response.content_length() != sequence.length
                        || !encoding_is_identity(response.headers())
                        || media_type(source, response.headers()) != Some(sequence.mime.as_str())
                    {
                        return Err(StatusCode::BAD_GATEWAY);
                    }
                    response
                };
                sequence.extent.store(0, Ordering::Relaxed);
                Ok(builder
                    .body(self.sequential_body(source, sequence, upstream, permit))
                    .unwrap())
            }
        }
    }

    fn range_body(self: &Arc<Self>, source: &Arc<Source>, start: u64, end: u64) -> Body {
        let smooth = self.clone();
        let source = source.clone();
        let block_start = start / BLOCK * BLOCK;
        let parallel = self
            .bytes_per_second()
            .filter(|&rate| rate > 32_000)
            .map_or(1, |rate| {
                // Cover 400 ms of playback in flight to leave room for CDN latency
                // and cache I/O. Every request still reserves bytes from the shared budget.
                (rate.saturating_mul(2) / 5)
                    .div_ceil(BLOCK)
                    .clamp(3, STREAM_CLIENTS as u64) as usize
            });
        let read = move |offset| {
            let (smooth, source) = (smooth.clone(), source.clone());
            async move {
                let mut revoked = source.revoked.subscribe();
                let Some(Mode::Ranges(ranges)) = smooth.mode.get() else {
                    return Err(stream_error());
                };
                let bytes = tokio::select! {
                    result = smooth.block(&source, ranges, offset, Traffic::Audio) => result.map_err(|_| stream_error())?,
                    _ = revoked.changed() => return Err(stream_error()),
                };
                if !source_allowed(&source) {
                    return Err(stream_error());
                }
                let from = start.saturating_sub(offset) as usize;
                let to = (end - offset).min(bytes.len() as u64) as usize;
                Ok(bytes.slice(from..to))
            }
        };
        let offsets = (block_start..end).step_by(BURST);
        let first = futures_util::stream::iter(offsets.clone().take(1)).then(read.clone());
        let remainder = futures_util::stream::iter(offsets.skip(1))
            .map(read)
            .buffered(parallel);
        Body::from_stream(first.chain(remainder))
    }

    fn sequential_body(
        &self,
        source: &Arc<Source>,
        sequence: &Sequential,
        upstream: reqwest::Response,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Body {
        let budget = self.runtime.budget.clone();
        let extent = sequence.extent.clone();
        let source = source.clone();
        let cancel = source.revoked.subscribe();
        let length = sequence.length;
        let stream = futures_util::stream::try_unfold(
            (upstream, Bytes::new(), cancel, permit),
            move |(mut upstream, mut pending, mut revoked, permit)| {
                let (budget, extent, source) = (budget.clone(), extent.clone(), source.clone());
                async move {
                    if !source_allowed(&source) {
                        return Err(stream_error());
                    }
                    if length.is_some_and(|length| extent.load(Ordering::Relaxed) >= length) {
                        return Ok(None);
                    }
                    let bytes = tokio::select! {
                        next = async {
                            budget.reserve(BURST, Traffic::Audio).await;
                            let mut output = Vec::with_capacity(BURST);
                            while output.len() < BURST {
                                if pending.is_empty() {
                                    let Some(chunk) = upstream.chunk().await.map_err(|_| stream_error())? else { break; };
                                    pending = chunk;
                                }
                                let count = pending.len().min(BURST - output.len());
                                output.extend_from_slice(&pending.split_to(count));
                            }
                            Ok::<_, io::Error>((!output.is_empty()).then(|| Bytes::from(output)))
                        } => next?,
                        _ = revoked.changed() => return Err(stream_error()),
                    };
                    let Some(bytes) = bytes else {
                        return Ok(None);
                    };
                    budget.record(Traffic::Audio, bytes.len());
                    if let Some(smooth) = &source.smooth {
                        smooth.note_first_data("network");
                    }
                    source
                        .metrics
                        .bytes
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    extent.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    Ok(Some((bytes, (upstream, pending, revoked, permit))))
                }
            },
        );
        Body::from_stream(stream)
    }
}

fn stream_error() -> io::Error {
    io::Error::other("media transfer interrupted")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use std::{path::PathBuf, time::Instant};

    #[derive(Clone)]
    struct Fixture {
        bytes: Bytes,
        sends: Arc<Mutex<Vec<(Instant, usize)>>>,
        requests: Arc<Mutex<Vec<Option<String>>>>,
        authorized_query: Arc<Mutex<Option<String>>>,
        etag: Arc<AtomicU64>,
        ignore_range: bool,
        latency: Duration,
    }

    async fn upstream(State(fixture): State<Fixture>, request: Request<Body>) -> Response {
        let length = fixture.bytes.len() as u64;
        let range = request.headers().get(header::RANGE);
        fixture
            .requests
            .lock()
            .unwrap()
            .push(range.and_then(|r| r.to_str().ok()).map(str::to_owned));
        if fixture
            .authorized_query
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|query| request.uri().query() != Some(query.as_str()))
        {
            return response(StatusCode::FORBIDDEN);
        }
        tokio::time::sleep(fixture.latency).await;
        let etag = format!("\"fixture-{}\"", fixture.etag.load(Ordering::Relaxed));
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, "audio/mpeg")
            .header(header::ETAG, etag);
        let body = match range.filter(|_| !fixture.ignore_range) {
            Some(range) => {
                let Some((start, end)) = bounds(range, length) else {
                    return response
                        .status(416)
                        .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                        .body(Body::empty())
                        .unwrap();
                };
                response = response.status(206).header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{}/{length}", end - 1),
                );
                fixture.bytes.slice(start as usize..end as usize)
            }
            None => fixture.bytes,
        };
        fixture
            .sends
            .lock()
            .unwrap()
            .push((Instant::now(), body.len()));
        response
            .header(header::CONTENT_LENGTH, body.len())
            .body(Body::from(body))
            .unwrap()
    }

    async fn fixture(
        bytes: usize,
        ignore_range: bool,
        latency_ms: u64,
    ) -> (Fixture, url::Url, tauri::async_runtime::JoinHandle<()>) {
        let fixture = Fixture {
            bytes: Bytes::from((0..bytes).map(|i| (i % 251) as u8).collect::<Vec<_>>()),
            sends: Arc::default(),
            requests: Arc::default(),
            authorized_query: Arc::default(),
            etag: Arc::new(AtomicU64::new(1)),
            ignore_range,
            latency: Duration::from_millis(latency_ms),
        };
        let app = Router::new()
            .route("/sample", any(upstream))
            .with_state(fixture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url =
            url::Url::parse(&format!("http://{}/sample", listener.local_addr().unwrap())).unwrap();
        let server =
            tauri::async_runtime::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (fixture, url, server)
    }

    fn runtime(root: PathBuf) -> Arc<SmoothRuntime> {
        let budget = Arc::new(MediaBudget::default());
        Arc::new(SmoothRuntime::new(Arc::new(MediaCache::open(root, budget))))
    }

    fn bridge(url: &url::Url, runtime: Option<&Arc<SmoothRuntime>>, bits: u64) -> MediaBridge {
        bridge_with_identity(url, runtime, bits, CacheUrlIdentity::FullUrl)
    }

    fn bridge_with_identity(
        url: &url::Url,
        runtime: Option<&Arc<SmoothRuntime>>,
        bits: u64,
        identity: CacheUrlIdentity,
    ) -> MediaBridge {
        let smooth = runtime.map(|runtime| {
            runtime.source(
                runtime
                    .cache
                    .scope("fixture", "account", "track", "representation"),
                1,
                Some(bits),
                60_000,
                identity,
            )
        });
        MediaBridge::start_with_options(
            url.clone(),
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "https://y.qq.com/",
            Vec::new(),
            smooth,
        )
        .unwrap()
    }

    #[test]
    fn qq_original_cache_identity_removes_only_exact_signature_parameters() {
        let url = url::Url::parse(
            "https://isure.stream.qqmusic.qq.com/sample?guid=first&mode=A%2fb+z&vkey=old&Mode=X&mode=Y&%76key=kept&empty=&guid=second",
        ).unwrap();
        assert_eq!(
            CacheUrlIdentity::QqOriginal.resource(&url),
            "https://isure.stream.qqmusic.qq.com/sample?mode=A%2fb+z&Mode=X&mode=Y&%76key=kept&empty="
        );
        assert_eq!(CacheUrlIdentity::FullUrl.resource(&url), url.as_str());
        let signed =
            url::Url::parse("https://isure.stream.qqmusic.qq.com/sample?guid=a&vkey=b").unwrap();
        assert_eq!(
            CacheUrlIdentity::QqOriginal.resource(&signed),
            "https://isure.stream.qqmusic.qq.com/sample"
        );
    }

    #[test]
    fn qq_signed_replay_requires_current_authorization_and_representation() {
        tauri::async_runtime::block_on(async {
            let length = BURST + 23;
            let (upstream, url, server) = fixture(length, false, 0).await;
            let root = std::env::temp_dir().join(format!("qmg-qq-replay-{}", uuid::Uuid::new_v4()));
            let open = |runtime: &Arc<SmoothRuntime>, query: &str| {
                let mut signed = url.clone();
                signed.set_query(Some(query));
                bridge_with_identity(
                    &signed,
                    Some(runtime),
                    128_000,
                    CacheUrlIdentity::QqOriginal,
                )
            };
            let set_query = |query: &str| {
                *upstream.authorized_query.lock().unwrap() = Some(query.to_owned());
            };
            let first = "guid=g1&vkey=s1&format=mp3";
            let second = "guid=g2&vkey=s2&format=mp3";
            let original = runtime(root.clone());
            set_query(first);
            let cold = open(&original, first);
            assert_eq!(download(&cold, None).await.0, upstream.bytes);
            assert_eq!(sample("qq_signed_first", &upstream, 0).0, length + 1);
            drop(cold);
            drop(original);

            let reopened = runtime(root);
            let counters = &reopened.budget.totals;
            set_query(second);
            let warm = open(&reopened, second);
            assert_eq!(download(&warm, None).await.0, upstream.bytes);
            assert_eq!(sample("qq_signed_warm", &upstream, 0).0, 1);
            assert_eq!(counters.probe.load(Ordering::Relaxed), 1);
            assert_eq!(counters.audio.load(Ordering::Relaxed), 0);
            assert_eq!(counters.disk_cache.load(Ordering::Relaxed), length as u64);
            drop(warm);

            // The app account guard and the CDN probe must both allow a read,
            // even while the original blocks are present on disk.
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let revoked = open(&reopened, second);
            revoked.bind_account(Arc::new(|| false));
            assert_eq!(
                client
                    .get(revoked.local_url_for_checks())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
            let denied = open(&reopened, first);
            let response = client
                .get(denied.local_url_for_checks())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            assert!(response.bytes().await.unwrap().is_empty());
            assert_eq!(sample("qq_signed_denied", &upstream, 0).0, 0);
            assert_eq!(counters.disk_cache.load(Ordering::Relaxed), length as u64);

            upstream.etag.fetch_add(1, Ordering::Relaxed);
            let changed_version = open(&reopened, second);
            assert_eq!(download(&changed_version, None).await.0, upstream.bytes);
            assert_eq!(sample("qq_signed_new_etag", &upstream, 0).0, length + 1);
            assert_eq!(counters.disk_cache.load(Ordering::Relaxed), length as u64);

            let unknown = "guid=g3&vkey=s3&format=other";
            set_query(unknown);
            let changed_query = open(&reopened, unknown);
            assert_eq!(download(&changed_query, None).await.0, upstream.bytes);
            assert_eq!(sample("qq_signed_new_query", &upstream, 0).0, length + 1);
            assert_eq!(counters.disk_cache.load(Ordering::Relaxed), length as u64);
            assert_eq!(counters.audio.load(Ordering::Relaxed), 2 * length as u64);
            reopened.cache.clear();
            server.abort();
        });
    }

    async fn download(bridge: &MediaBridge, range: Option<&str>) -> (Bytes, u128) {
        let start = Instant::now();
        let mut request = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(bridge.local_url_for_checks());
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        let mut response = request.send().await.unwrap().error_for_status().unwrap();
        let first = response.chunk().await.unwrap().unwrap();
        let elapsed = start.elapsed().as_millis();
        let mut bytes = first.to_vec();
        while let Some(chunk) = response.chunk().await.unwrap() {
            bytes.extend_from_slice(&chunk);
        }
        (Bytes::from(bytes), elapsed)
    }

    fn sample(label: &str, fixture: &Fixture, first_byte: u128) -> (usize, usize, usize) {
        let mut sends = fixture.sends.lock().unwrap();
        let samples = std::mem::take(&mut *sends);
        let peak = |ms| {
            samples
                .iter()
                .map(|(begin, _)| {
                    samples
                        .iter()
                        .filter(|(time, _)| {
                            time >= begin && *time < *begin + Duration::from_millis(ms)
                        })
                        .map(|(_, bytes)| bytes)
                        .sum::<usize>()
                })
                .max()
                .unwrap_or(0)
        };
        let sent = samples.iter().map(|(_, bytes)| bytes).sum::<usize>();
        let quarter = peak(250);
        let second = peak(1000);
        println!("smooth_measure {label} sent={sent} peak250={quarter} peak1000={second} first_byte_ms={first_byte}");
        (sent, quarter, second)
    }

    #[test]
    fn cold_preloaded_and_reopened_range_matrix() {
        tauri::async_runtime::block_on(async {
            for (label, rate, length, latency) in [
                ("qq_128k", 128_000, 160 * 1024, 0),
                ("netease_320k_slow", 320_000, 352 * 1024, 120),
                ("qq_flac", 950_000, 640 * 1024, 0),
                ("bilibili_aac", 192_000, 224 * 1024, 0),
            ] {
                let (upstream, url, server) = fixture(length, false, latency).await;
                let root = std::env::temp_dir()
                    .join(format!("qmg-media-fixture-{}", uuid::Uuid::new_v4()));
                let old = bridge(&url, None, rate);
                let (bytes, first) = download(&old, None).await;
                assert_eq!(bytes, upstream.bytes);
                assert_eq!(sample(&format!("{label}_old"), &upstream, first).0, length);
                let smooth = runtime(root.clone());
                let cold = bridge(&url, Some(&smooth), rate);
                let (bytes, first) = download(&cold, None).await;
                assert_eq!(bytes, upstream.bytes);
                let (sent, quarter, second) = sample(&format!("{label}_cold"), &upstream, first);
                assert_eq!(sent, length + 1);
                let budget = MIN_RATE.max(rate / 4) as usize;
                // Server send times include the local scheduler and provisioned RTT.
                // Allow scheduling jitter where adjacent responses cross a window edge.
                assert!(quarter <= budget / 4 + BURST + BURST / 4);
                assert!(second <= budget + BURST + BURST / 4);
                drop(cold);
                drop(smooth);
                let reopened = runtime(root.clone());
                let hot = bridge(&url, Some(&reopened), rate);
                let (bytes, first) = download(&hot, None).await;
                assert_eq!(bytes, upstream.bytes);
                assert_eq!(sample(&format!("{label}_restart"), &upstream, first).0, 1);
                let probe = reopened.budget.totals.probe.load(Ordering::Relaxed);
                assert_eq!(probe, 1);
                let _ = reopened.cache.clear();
                // Keep the preload source alive through fresh playback authorization.
                let preload = bridge(&url, Some(&reopened), rate);
                upstream.etag.fetch_add(1, Ordering::Relaxed);
                assert!(preload.preload().await);
                let preloaded = sample(&format!("{label}_prefetch"), &upstream, 0).0;
                let promoted = bridge(&url, Some(&reopened), rate);
                let (bytes, first) = download(&promoted, None).await;
                assert_eq!(bytes, upstream.bytes);
                let resumed = sample(&format!("{label}_promoted"), &upstream, first).0;
                assert!(preloaded > 1 && resumed < length);
                assert_eq!(preloaded + resumed, length + 2);
                let _ = reopened.cache.clear();
                server.abort();
            }
        });
    }

    #[test]
    fn high_bitrate_cold_playback_keeps_up_with_200ms_range_latency() {
        tauri::async_runtime::block_on(async {
            const BITS_PER_SECOND: u64 = 2_000_000;
            const LENGTH: usize = 64 * BURST;
            let (upstream, url, server) = fixture(LENGTH, false, 200).await;
            let root = std::env::temp_dir()
                .join(format!("qmg-media-fixture-{}", uuid::Uuid::new_v4()));
            let runtime = runtime(root.clone());
            let bridge = bridge(&url, Some(&runtime), BITS_PER_SECOND);
            let start = Instant::now();
            let (bytes, first_ms) = download(&bridge, None).await;
            let elapsed = start.elapsed();
            let delivery = elapsed - Duration::from_millis(first_ms as u64);
            let (sent, quarter, second) = sample("high_bitrate_200ms_cold", &upstream, first_ms);
            println!("total_ms={} delivery_ms={}", elapsed.as_millis(), delivery.as_millis());
            assert_eq!(bytes, upstream.bytes);
            assert_eq!(sent, LENGTH + 1);
            assert_eq!(upstream.requests.lock().unwrap().len(), LENGTH / BURST + 1);
            assert!(runtime.cache.status().used_bytes >= LENGTH as u64);
            let playback_time = Duration::from_secs_f64((LENGTH - BURST) as f64 / (BITS_PER_SECOND / 8) as f64);
            assert!(delivery < playback_time, "delivery {delivery:?}, playback {playback_time:?}");
            let budget = (BITS_PER_SECOND / 4) as usize;
            assert!(quarter <= budget / 4 + BURST + BURST / 4);
            assert!(second <= budget + BURST + BURST / 4);
            server.abort();
            runtime.cache.clear();
            drop(bridge);
            drop(runtime);
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn overlapping_ranges_seek_and_revocation_share_only_verified_blocks() {
        tauri::async_runtime::block_on(async {
            let (upstream, url, server) = fixture(4 * BURST, false, 30).await;
            let root =
                std::env::temp_dir().join(format!("qmg-media-fixture-{}", uuid::Uuid::new_v4()));
            let runtime = runtime(root);
            let bridge = bridge(&url, Some(&runtime), 320_000);
            let allowed = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let account = allowed.clone();
            bridge.bind_account(Arc::new(move || account.load(Ordering::Relaxed)));
            let (one, two) = tokio::join!(
                download(&bridge, Some("bytes=4-17000")),
                download(&bridge, Some("bytes=12-20000"))
            );
            assert_eq!(one.0, upstream.bytes.slice(4..17001));
            assert_eq!(two.0, upstream.bytes.slice(12..20001));
            assert_eq!(
                download(&bridge, Some("bytes=-17")).await.0,
                upstream.bytes.slice(4 * BURST - 17..)
            );
            assert_eq!(upstream.requests.lock().unwrap().len(), 4);
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let url = bridge.local_url_for_checks();
            let head = client.head(&url).send().await.unwrap();
            assert_eq!(
                head.headers()[header::CONTENT_LENGTH],
                (4 * BURST).to_string()
            );
            let unsatisfiable = client
                .get(&url)
                .header(header::RANGE, "bytes=999999-")
                .send()
                .await
                .unwrap();
            assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            allowed.store(false, Ordering::Relaxed);
            assert_eq!(
                client.get(&url).send().await.unwrap().status(),
                StatusCode::NOT_FOUND
            );
            assert_eq!(upstream.requests.lock().unwrap().len(), 4);
            runtime.cache.clear();
            server.abort();
        });
    }

    #[test]
    fn ignored_range_uses_one_sequential_response_and_reports_upstream_burst() {
        tauri::async_runtime::block_on(async {
            let (upstream, url, server) = fixture(96 * 1024, true, 0).await;
            let root =
                std::env::temp_dir().join(format!("qmg-media-fixture-{}", uuid::Uuid::new_v4()));
            let runtime = runtime(root);
            let old = bridge(&url, None, 128_000);
            let (bytes, first) = download(&old, Some("bytes=0-")).await;
            assert_eq!(bytes, upstream.bytes);
            sample("ignored_200_old", &upstream, first);
            let smooth = bridge(&url, Some(&runtime), 128_000);
            let start = Instant::now();
            let (bytes, first) = download(&smooth, Some("bytes=0-")).await;
            assert_eq!(bytes, upstream.bytes);
            assert_eq!(
                sample("ignored_200_smooth", &upstream, first).0,
                upstream.bytes.len()
            );
            assert!(start.elapsed() >= Duration::from_millis(1000));
            assert_eq!(upstream.requests.lock().unwrap().len(), 2);
            assert_eq!(runtime.cache.status().used_bytes, 0);
            server.abort();
        });
    }
}
