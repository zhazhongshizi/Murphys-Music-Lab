use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Condvar, Mutex},
};

use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort};

const MAX_TRACK_ID_BYTES: usize = 128;
const MAX_RAW_LYRIC_BYTES: usize = 512_000;
const MAX_TIMED_LINES: usize = 5_000;
const MAX_LINE_BYTES: usize = 512;
const MAX_BILIBILI_SUBTITLE_MS: u64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricError {
    InvalidRequest,
    ProviderUnavailable,
    NetworkUnavailable,
    UpstreamUnavailable,
    AuthenticationRequired,
    Unavailable,
    UpstreamSchemaChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LyricSource {
    BilibiliSubtitle,
    BilibiliAiSubtitle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub romanization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricTimeline {
    pub generation: u64,
    pub track_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<LyricSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_end_ms: Option<u64>,
    pub lines: Vec<LyricLine>,
}

pub struct LyricService {
    provider: Arc<dyn ProviderRequestPort>,
    shared: Mutex<LyricState>,
    mv_offset: Mutex<Option<(String, u64, i64)>>,
    netease: Option<Arc<crate::multi_provider::netease::NeteaseService>>,
    bilibili: Option<Arc<crate::multi_provider::bilibili::BilibiliService>>,
}

struct LyricState {
    cached: Option<CachedLyrics>,
    in_flight: HashMap<String, Arc<LyricFlight>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedLyrics {
    source: Option<LyricSource>,
    timeline_end_ms: Option<u64>,
    lines: Arc<Vec<LyricLine>>,
}

struct CachedLyrics {
    cache_key: String,
    resolved: ResolvedLyrics,
}

struct LyricFlight {
    result: Mutex<Option<Result<ResolvedLyrics, LyricError>>>,
    wake: Condvar,
    waiters: std::sync::atomic::AtomicUsize,
}

impl LyricService {
    pub fn new(provider: Arc<dyn ProviderRequestPort>) -> Self {
        Self {
            provider,
            mv_offset: Mutex::new(None),
            netease: None,
            bilibili: None,
            shared: Mutex::new(LyricState {
                cached: None,
                in_flight: HashMap::new(),
            }),
        }
    }
    pub fn with_netease(mut self,service:Arc<crate::multi_provider::netease::NeteaseService>)->Self {self.netease=Some(service);self}
    pub fn with_bilibili(
        mut self,
        service: Arc<crate::multi_provider::bilibili::BilibiliService>,
    ) -> Self {
        self.bilibili = Some(service);
        self
    }

    pub fn timeline(&self, track_id: &str, generation: u64) -> Result<LyricTimeline, LyricError> {
        let resolved = self.resolve(track_id)?;
        let is_bilibili = crate::multi_provider::identity::track_provider(track_id)
            == Ok(crate::multi_provider::ProviderId::Bilibili);
        let offset = if is_bilibili {
            0
        } else {
            self.mv_offset
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .filter(|(id, gen, _)| id == track_id && *gen == generation)
                .map_or(0, |(_, _, value)| *value)
        };
        let mut lines = resolved.lines.as_ref().clone();
        if offset != 0 {
            for line in &mut lines {
                line.at_ms = line.at_ms.saturating_add_signed(offset);
            }
            // Negative offsets can collapse early timestamps; keep the latest line at each time.
            let mut merged = BTreeMap::new();
            for line in lines {
                merged.insert(line.at_ms, line);
            }
            lines = merged.into_values().collect();
        }
        Ok(LyricTimeline {
            generation,
            track_id: track_id.to_owned(),
            source: resolved.source,
            timeline_end_ms: resolved.timeline_end_ms,
            lines,
        })
    }

    pub(crate) fn set_mv_offset(&self, id: String, generation: u64, offset: i64) {
        *self
            .mv_offset
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((id, generation, offset));
    }

    fn resolve(&self, track_id: &str) -> Result<ResolvedLyrics, LyricError> {
        validate_track_id(track_id)?;
        if crate::multi_provider::identity::track_provider(track_id)
            == Ok(crate::multi_provider::ProviderId::Bilibili)
        {
            let (bvid, cid) = crate::multi_provider::bilibili::raw_part(track_id)
                .map_err(|_| LyricError::InvalidRequest)?;
            let bilibili = self
                .bilibili
                .as_ref()
                .ok_or(LyricError::ProviderUnavailable)?;
            let session_generation = bilibili.session_generation();
            let cache_key = format!("bilibili:{bvid}:{cid}:{session_generation}");
            return self.resolve_cached(
                &cache_key,
                || bilibili.session_generation() == session_generation,
                || load_bilibili_subtitles(bilibili, bvid, cid),
            );
        }
        if track_id.starts_with("netease:") {
            // Account-scoped reads; do not serve the legacy QQ cache after logout.
            return self.load_lines(track_id).map(|lines| ResolvedLyrics {
                source: None,
                timeline_end_ms: None,
                lines: Arc::new(lines),
            });
        }
        self.resolve_cached(
            track_id,
            || true,
            || {
                self.load_lines(track_id).map(|lines| ResolvedLyrics {
                    source: None,
                    timeline_end_ms: None,
                    lines: Arc::new(lines),
                })
            },
        )
    }

    fn resolve_cached<F>(
        &self,
        cache_key: &str,
        should_cache: impl FnOnce() -> bool,
        loader: F,
    ) -> Result<ResolvedLyrics, LyricError>
    where
        F: FnOnce() -> Result<ResolvedLyrics, LyricError>,
    {
        let (flight, owner) = {
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(cached) = shared
                .cached
                .as_ref()
                .filter(|cached| cached.cache_key == cache_key)
            {
                return Ok(cached.resolved.clone());
            }
            if let Some(flight) = shared.in_flight.get(cache_key) {
                (flight.clone(), false)
            } else {
                let flight = Arc::new(LyricFlight {
                    result: Mutex::new(None),
                    wake: Condvar::new(),
                    waiters: std::sync::atomic::AtomicUsize::new(0),
                });
                shared
                    .in_flight
                    .insert(cache_key.to_owned(), flight.clone());
                (flight, true)
            }
        };

        if owner {
            let result = loader();
            {
                let mut flight_result = flight
                    .result
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *flight_result = Some(result.clone());
            }
            flight.wake.notify_all();

            let cache_valid = result.is_ok() && should_cache();
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if cache_valid {
                if let Ok(resolved) = &result {
                    shared.cached = Some(CachedLyrics {
                        cache_key: cache_key.to_owned(),
                        resolved: resolved.clone(),
                    });
                }
            }
            shared.in_flight.remove(cache_key);
            result
        } else {
            flight
                .waiters
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let mut flight_result = flight
                .result
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while flight_result.is_none() {
                flight_result = flight
                    .wake
                    .wait(flight_result)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            let result = flight_result
                .as_ref()
                .expect("single-flight result must be published")
                .clone();
            flight
                .waiters
                .fetch_sub(1, std::sync::atomic::Ordering::Release);
            result
        }
    }

    fn load_lines(&self, track_id: &str) -> Result<Vec<LyricLine>, LyricError> {
        let reply = if track_id.starts_with("netease:") {
            let n=self.netease.as_ref().ok_or(LyricError::ProviderUnavailable)?;
            let generation=n.ready_generation().map_err(|_|LyricError::AuthenticationRequired)?;
            let song=crate::multi_provider::netease::raw_song(track_id).map_err(|_|LyricError::InvalidRequest)?;
            let v=n.call(generation,"lyrics.get",serde_json::json!({"songId":song})).map_err(|_|LyricError::ProviderUnavailable)?;
            ProviderReply::Success {result:Map::from_iter([
                ("trackId".into(),Value::String(track_id.into())),
                ("lyric".into(),Value::String(v["original"].as_str().unwrap_or("").into())),
                ("translation".into(),Value::String(v["translation"].as_str().unwrap_or("").into())),
                ("romanization".into(),Value::String(v["romanization"].as_str().unwrap_or("").into())),
            ]),warnings:vec![]}
        } else {self
            .provider
            .request(ProviderRequest::read_only(
                "lyrics.get",
                Map::from_iter([("id".to_owned(), Value::String(track_id.to_owned()))]),
            ))
            .map_err(map_provider_error)?};
        let mut result = match reply {
            ProviderReply::Success { result, .. } => result,
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        if result.len() != 4
            || !["trackId", "lyric", "translation", "romanization"]
                .iter()
                .all(|key| result.contains_key(*key))
        {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        let response_track_id = take_string(&mut result, "trackId", MAX_TRACK_ID_BYTES)?;
        if response_track_id.as_str() != track_id {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        let original = take_string(&mut result, "lyric", MAX_RAW_LYRIC_BYTES)?;
        let translation = take_string(&mut result, "translation", MAX_RAW_LYRIC_BYTES)?;
        let romanization = take_string(&mut result, "romanization", MAX_RAW_LYRIC_BYTES)?;
        let original_lines = parse_lrc(&original)?;
        if original_lines.is_empty() {
            return Err(LyricError::Unavailable);
        }
        let translations = parse_lrc(&translation)?;
        let romanizations = parse_lrc(&romanization)?;
        let lines = original_lines
            .into_iter()
            .map(|(at_ms, original)| LyricLine {
                at_ms,
                end_ms: None,
                original,
                translation: translations.get(&at_ms).cloned(),
                romanization: romanizations.get(&at_ms).cloned(),
            })
            .collect();
        Ok(lines)
    }
}

fn load_bilibili_subtitles(
    bilibili: &crate::multi_provider::bilibili::BilibiliService,
    bvid: &str,
    cid: &str,
) -> Result<ResolvedLyrics, LyricError> {
    let value = bilibili
        .subtitles(bvid, cid)
        .map_err(map_bilibili_error)?;
    parse_bilibili_subtitles(bvid, cid, value)
}

fn parse_bilibili_subtitles(
    bvid: &str,
    cid: &str,
    value: Value,
) -> Result<ResolvedLyrics, LyricError> {
    let Some(obj) = value.as_object() else {
        return Err(LyricError::UpstreamSchemaChanged);
    };
    if !matches!(obj.len(), 3 | 4) || (obj.len() == 4 && !obj.contains_key("timelineEndMs")) {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let Some(track) = obj.get("track").and_then(Value::as_object) else {
        return Err(LyricError::UpstreamSchemaChanged);
    };
    if track.len() != 3
        || track.get("kind").and_then(Value::as_str) != Some("videoPart")
        || track.get("bvid").and_then(Value::as_str) != Some(bvid)
        || track.get("cid").and_then(Value::as_str) != Some(cid)
    {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let Some(raw_source) = obj.get("source").and_then(Value::as_str) else {
        return Err(LyricError::UpstreamSchemaChanged);
    };
    let Some(raw_lines) = obj.get("lines").and_then(Value::as_array) else {
        return Err(LyricError::UpstreamSchemaChanged);
    };
    if raw_lines.len() > MAX_TIMED_LINES {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let source = match raw_source {
        "none" => {
            if !raw_lines.is_empty() {
                return Err(LyricError::UpstreamSchemaChanged);
            }
            None
        }
        "manual" | "unknown" => {
            if raw_lines.is_empty() {
                return Err(LyricError::UpstreamSchemaChanged);
            }
            Some(LyricSource::BilibiliSubtitle)
        }
        "ai" => {
            if raw_lines.is_empty() {
                return Err(LyricError::UpstreamSchemaChanged);
            }
            Some(LyricSource::BilibiliAiSubtitle)
        }
        _ => return Err(LyricError::UpstreamSchemaChanged),
    };

    let mut lines = Vec::with_capacity(raw_lines.len());
    let mut prev_at_ms: Option<u64> = None;
    let mut prev_end_ms: Option<u64> = None;
    for item in raw_lines {
        let Some(item_obj) = item.as_object() else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        if item_obj.len() != 3 {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        let Some(at_ms) = item_obj.get("atMs").and_then(Value::as_u64) else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        let Some(end_ms) = item_obj.get("endMs").and_then(Value::as_u64) else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        if end_ms <= at_ms || end_ms > MAX_BILIBILI_SUBTITLE_MS {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        if let (Some(prev_at), Some(prev_end)) = (prev_at_ms, prev_end_ms) {
            if at_ms <= prev_at || prev_end > at_ms {
                return Err(LyricError::UpstreamSchemaChanged);
            }
        }
        let Some(text) = item_obj.get("text").and_then(Value::as_str) else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        if text.is_empty()
            || text.trim().is_empty()
            || text.len() > MAX_LINE_BYTES
            || text.contains(['\r', '\n', '\0'])
        {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        prev_at_ms = Some(at_ms);
        prev_end_ms = Some(end_ms);
        lines.push(LyricLine {
            at_ms,
            end_ms: Some(end_ms),
            original: text.to_owned(),
            translation: None,
            romanization: None,
        });
    }

    let timeline_end_ms = match obj.get("timelineEndMs") {
        None => None,
        Some(raw_timeline_end_ms) => {
            if raw_lines.is_empty() {
                return Err(LyricError::UpstreamSchemaChanged);
            }
            let Some(last_end_ms) = prev_end_ms else {
                return Err(LyricError::UpstreamSchemaChanged);
            };
            let Some(end_ms) = raw_timeline_end_ms.as_u64() else {
                return Err(LyricError::UpstreamSchemaChanged);
            };
            if end_ms > MAX_BILIBILI_SUBTITLE_MS || end_ms < last_end_ms {
                return Err(LyricError::UpstreamSchemaChanged);
            }
            Some(end_ms)
        }
    };

    Ok(ResolvedLyrics {
        source,
        timeline_end_ms,
        lines: Arc::new(lines),
    })
}

fn map_bilibili_error(error: crate::multi_provider::protocol::Error) -> LyricError {
    use crate::multi_provider::{protocol::Error, ErrorCode};
    match error {
        Error::Context => LyricError::InvalidRequest,
        Error::Timeout => LyricError::UpstreamUnavailable,
        Error::Schema | Error::Frame => LyricError::UpstreamSchemaChanged,
        Error::Cooldown => LyricError::NetworkUnavailable,
        Error::Upstream(code) => match code {
            ErrorCode::AuthenticationRequired | ErrorCode::CredentialInvalid => {
                LyricError::AuthenticationRequired
            }
            ErrorCode::NetworkUnavailable | ErrorCode::RateLimited => {
                LyricError::NetworkUnavailable
            }
            ErrorCode::UpstreamSchemaChanged => LyricError::UpstreamSchemaChanged,
            ErrorCode::InvalidParams => LyricError::InvalidRequest,
            ErrorCode::ProviderUnavailable
            | ErrorCode::VerificationRequired
            | ErrorCode::EntitlementDenied
            | ErrorCode::MediaUnavailable
            | ErrorCode::UnsupportedMedia
            | ErrorCode::UnsupportedCapability
            | ErrorCode::PreviewOnly
            | ErrorCode::OutcomeUnknown
            | ErrorCode::VerificationFailed
            | ErrorCode::Cancelled
            | ErrorCode::InternalError => LyricError::UpstreamUnavailable,
        },
        Error::Handshake | Error::Unavailable | Error::Cancelled | Error::Stale | Error::Storage => {
            LyricError::ProviderUnavailable
        }
    }
}

fn take_string(
    result: &mut Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
) -> Result<Zeroizing<String>, LyricError> {
    match result.remove(key) {
        Some(Value::String(value)) if value.len() <= maximum_bytes && !value.contains('\0') => {
            Ok(Zeroizing::new(value))
        }
        _ => Err(LyricError::UpstreamSchemaChanged),
    }
}

fn parse_lrc(raw: &str) -> Result<BTreeMap<u64, String>, LyricError> {
    if raw.is_empty() {
        return Ok(BTreeMap::new());
    }
    let offset_ms = parse_offset(raw)?;
    let mut result = BTreeMap::new();
    for raw_line in raw.lines() {
        let line = raw_line.trim_end_matches('\r');
        let (timestamps, text) = parse_line(line)?;
        if timestamps.is_empty() {
            continue;
        }
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_LINE_BYTES || text.contains(['\r', '\n', '\0']) {
            if text.is_empty() {
                continue;
            }
            return Err(LyricError::UpstreamSchemaChanged);
        }
        for timestamp in timestamps {
            let adjusted = apply_offset(timestamp, offset_ms);
            result.entry(adjusted).or_insert_with(|| text.to_owned());
            if result.len() > MAX_TIMED_LINES {
                return Err(LyricError::UpstreamSchemaChanged);
            }
        }
    }
    Ok(result)
}

fn parse_offset(raw: &str) -> Result<i64, LyricError> {
    let mut offset = 0_i64;
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed
            .strip_prefix("[offset:")
            .and_then(|value| value.strip_suffix(']'))
        else {
            continue;
        };
        offset = value
            .parse::<i64>()
            .map_err(|_| LyricError::UpstreamSchemaChanged)?;
        if !(-3_600_000..=3_600_000).contains(&offset) {
            return Err(LyricError::UpstreamSchemaChanged);
        }
    }
    Ok(offset)
}

fn parse_line(line: &str) -> Result<(Vec<u64>, &str), LyricError> {
    let mut remaining = line;
    let mut timestamps = Vec::new();
    while let Some(after_open) = remaining.strip_prefix('[') {
        let Some(close) = after_open.find(']') else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        let tag = &after_open[..close];
        let Some(timestamp) = parse_timestamp(tag)? else {
            break;
        };
        timestamps.push(timestamp);
        remaining = &after_open[close + 1..];
    }
    Ok((timestamps, remaining))
}

fn parse_timestamp(value: &str) -> Result<Option<u64>, LyricError> {
    let Some((minutes, seconds)) = value.split_once(':') else {
        return Ok(None);
    };
    if minutes.is_empty() || !minutes.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let minutes = minutes
        .parse::<u64>()
        .map_err(|_| LyricError::UpstreamSchemaChanged)?;
    if minutes > 9_999 {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let (whole_seconds, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if whole_seconds.is_empty()
        || whole_seconds.len() > 2
        || !whole_seconds.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > 3
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let whole_seconds = whole_seconds
        .parse::<u64>()
        .map_err(|_| LyricError::UpstreamSchemaChanged)?;
    if whole_seconds >= 60 {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let fraction_ms = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<u64>().unwrap_or_default() * 100,
        2 => fraction.parse::<u64>().unwrap_or_default() * 10,
        3 => fraction.parse::<u64>().unwrap_or_default(),
        _ => unreachable!(),
    };
    let timestamp = minutes
        .checked_mul(60_000)
        .and_then(|value| value.checked_add(whole_seconds * 1_000))
        .and_then(|value| value.checked_add(fraction_ms))
        .ok_or(LyricError::UpstreamSchemaChanged)?;
    Ok(Some(timestamp))
}

fn apply_offset(timestamp: u64, offset_ms: i64) -> u64 {
    if offset_ms >= 0 {
        timestamp.saturating_add(offset_ms as u64)
    } else {
        timestamp.saturating_sub(offset_ms.unsigned_abs())
    }
}

fn validate_track_id(track_id: &str) -> Result<(), LyricError> {
    if crate::multi_provider::identity::track_provider(track_id).is_ok_and(|p|matches!(p,crate::multi_provider::ProviderId::Netease|crate::multi_provider::ProviderId::Bilibili)) {return Ok(());}
    if track_id.is_empty()
        || track_id.len() > MAX_TRACK_ID_BYTES
        || !track_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(LyricError::InvalidRequest);
    }
    Ok(())
}

fn map_provider_error(_error: ProviderError) -> LyricError {
    LyricError::ProviderUnavailable
}

fn map_provider_failure(code: &str) -> LyricError {
    match code {
        "network_unavailable" | "rate_limited" => LyricError::NetworkUnavailable,
        "authentication_required" => LyricError::AuthenticationRequired,
        "upstream_schema_changed" => LyricError::UpstreamSchemaChanged,
        "upstream_unavailable" => LyricError::UpstreamUnavailable,
        _ => LyricError::ProviderUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Mutex,
        },
        thread,
    };

    use serde_json::json;

    use super::*;
    use crate::provider::WarningFrame;

    struct FakeProvider {
        reply: Mutex<Option<Result<ProviderReply, ProviderError>>>,
    }

    impl ProviderRequestPort for FakeProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.reply
                .lock()
                .expect("reply lock")
                .take()
                .expect("reply")
        }
    }

    fn service(result: Value) -> LyricService {
        LyricService::new(Arc::new(FakeProvider {
            reply: Mutex::new(Some(Ok(ProviderReply::Success {
                result: result.as_object().expect("result object").clone(),
                warnings: Vec::<WarningFrame>::new(),
            }))),
        }))
    }

    struct SequencedProvider {
        replies: Mutex<VecDeque<Result<ProviderReply, ProviderError>>>,
        requests: AtomicUsize,
    }

    impl SequencedProvider {
        fn new(replies: Vec<Result<ProviderReply, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                requests: AtomicUsize::new(0),
            })
        }
    }

    impl ProviderRequestPort for SequencedProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.replies
                .lock()
                .expect("sequenced replies")
                .pop_front()
                .expect("sequenced reply")
        }
    }

    struct BlockingProvider {
        track_id: &'static str,
        failure: bool,
        started: mpsc::Sender<()>,
        release: Arc<AtomicBool>,
        requests: AtomicUsize,
    }

    impl ProviderRequestPort for BlockingProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.started.send(()).expect("blocking request observer");
            while !self.release.load(Ordering::Acquire) {
                thread::yield_now();
            }
            if self.failure {
                return Ok(ProviderReply::Failure {
                    code: "upstream_unavailable".to_owned(),
                    retryable: true,
                });
            }
            Ok(ProviderReply::Success {
                result: json!({
                    "trackId": self.track_id,
                    "lyric": "[00:01]原文",
                    "translation": "",
                    "romanization": ""
                })
                .as_object()
                .expect("blocking result")
                .clone(),
                warnings: Vec::new(),
            })
        }
    }

    fn lyric_reply(track_id: &str, original: &str) -> ProviderReply {
        ProviderReply::Success {
            result: json!({
                "trackId": track_id,
                "lyric": format!("[00:01]{original}"),
                "translation": "",
                "romanization": ""
            })
            .as_object()
            .expect("lyric result")
            .clone(),
            warnings: Vec::new(),
        }
    }

    fn wait_for_waiter(service: &LyricService, track_id: &str) {
        for _ in 0..100_000 {
            let flight = service
                .shared
                .lock()
                .expect("lyric state")
                .in_flight
                .get(track_id)
                .cloned()
                .expect("in-flight request");
            if flight.waiters.load(Ordering::Acquire) > 0 {
                return;
            }
            thread::yield_now();
        }
        panic!("single-flight waiter did not register");
    }

    #[test]
    fn mv_offset_is_generation_scoped_and_does_not_modify_raw_cache() {
        let service = service(
            json!({"trackId":"one", "lyric":"[00:00]a\n[00:01]b\n[00:02]c", "translation":"", "romanization":""}),
        );
        service.set_mv_offset("one".into(), 7, -1500);
        let shifted = service.timeline("one", 7).unwrap();
        assert_eq!(
            shifted
                .lines
                .iter()
                .map(|line| line.at_ms)
                .collect::<Vec<_>>(),
            vec![0, 500]
        );
        assert_eq!(shifted.lines[0].original, "b");
        assert_eq!(
            service
                .timeline("one", 8)
                .unwrap()
                .lines
                .iter()
                .map(|line| line.at_ms)
                .collect::<Vec<_>>(),
            vec![0, 1000, 2000]
        );
        service.set_mv_offset("other".into(), 7, 500);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1000);
        service.set_mv_offset("one".into(), 7, 500);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1500);
        service.set_mv_offset("one".into(), 7, 0);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1000);
    }

    #[test]
    fn current_track_cache_reuses_results_and_evicts_as_a_single_slot() {
        let provider = SequencedProvider::new(vec![
            Ok(lyric_reply("one", "第一首")),
            Ok(lyric_reply("two", "第二首")),
            Ok(lyric_reply("one", "第一首再次请求")),
        ]);
        let service = LyricService::new(provider.clone());

        let first = service.timeline("one", 1).expect("first timeline");
        let cached = service.timeline("one", 2).expect("cached timeline");
        let second = service.timeline("two", 3).expect("second timeline");
        let evicted = service.timeline("one", 4).expect("evicted timeline");

        assert_eq!(provider.requests.load(Ordering::SeqCst), 3);
        assert_eq!(first.lines[0].original, "第一首");
        assert_eq!(cached.generation, 2);
        assert_eq!(cached.lines, first.lines);
        assert_eq!(second.lines[0].original, "第二首");
        assert_eq!(evicted.lines[0].original, "第一首再次请求");
    }

    #[test]
    fn same_track_concurrent_requests_share_one_provider_call_before_cache_write() {
        let (started, started_receiver) = mpsc::channel();
        let release = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(BlockingProvider {
            track_id: "one",
            failure: false,
            started,
            release: release.clone(),
            requests: AtomicUsize::new(0),
        });
        let service = Arc::new(LyricService::new(provider.clone()));

        let first_service = service.clone();
        let first = thread::spawn(move || first_service.timeline("one", 1));
        started_receiver
            .recv()
            .expect("first provider call started");

        let (second_ready, second_ready_receiver) = mpsc::channel();
        let second_service = service.clone();
        let second = thread::spawn(move || {
            second_ready.send(()).expect("second thread started");
            second_service.timeline("one", 2)
        });
        second_ready_receiver
            .recv()
            .expect("second request thread started");
        wait_for_waiter(&service, "one");

        release.store(true, Ordering::Release);
        let first = first
            .join()
            .expect("first timeline thread")
            .expect("first timeline");
        let second = second
            .join()
            .expect("second timeline thread")
            .expect("second timeline");

        assert_eq!(provider.requests.load(Ordering::SeqCst), 1);
        assert_eq!(first.lines, second.lines);
        assert_eq!(first.generation, 1);
        assert_eq!(second.generation, 2);
    }

    #[test]
    fn same_track_concurrent_failures_share_one_provider_call_without_caching() {
        let (started, started_receiver) = mpsc::channel();
        let release = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(BlockingProvider {
            track_id: "one",
            failure: true,
            started,
            release: release.clone(),
            requests: AtomicUsize::new(0),
        });
        let service = Arc::new(LyricService::new(provider.clone()));

        let first_service = service.clone();
        let first = thread::spawn(move || first_service.timeline("one", 1));
        started_receiver
            .recv()
            .expect("first provider call started");

        let (second_ready, second_ready_receiver) = mpsc::channel();
        let second_service = service.clone();
        let second = thread::spawn(move || {
            second_ready.send(()).expect("second thread started");
            second_service.timeline("one", 2)
        });
        second_ready_receiver
            .recv()
            .expect("second request thread started");
        wait_for_waiter(&service, "one");

        release.store(true, Ordering::Release);
        assert_eq!(
            first.join().expect("first timeline thread"),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(
            second.join().expect("second timeline thread"),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 1);

        assert_eq!(
            service.timeline("one", 3),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failed_results_are_shared_but_not_cached() {
        let provider = SequencedProvider::new(vec![
            Ok(ProviderReply::Failure {
                code: "upstream_unavailable".to_owned(),
                retryable: true,
            }),
            Ok(ProviderReply::Failure {
                code: "upstream_unavailable".to_owned(),
                retryable: true,
            }),
        ]);
        let service = LyricService::new(provider.clone());

        assert_eq!(
            service.timeline("one", 1),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(
            service.timeline("one", 2),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn parses_sorts_offsets_and_aligns_variants_without_exposing_raw_lrc() {
        let timeline = service(json!({
            "trackId": "song-mid-1",
            "lyric": "[offset:100]\n[00:02.50]第二句\n[00:01][00:03.005]第一句",
            "translation": "[00:01.00]First line\n[00:02.500]Second line",
            "romanization": "[00:01]di yi ju"
        }))
        .timeline("song-mid-1", 7)
        .expect("timeline");

        assert_eq!(timeline.generation, 7);
        assert_eq!(timeline.lines.len(), 3);
        assert_eq!(timeline.lines[0].at_ms, 1_100);
        assert_eq!(timeline.lines[0].original, "第一句");
        assert_eq!(timeline.lines[0].translation, None);
        assert_eq!(timeline.lines[2].at_ms, 3_105);
        let json = serde_json::to_string(&timeline).expect("timeline json");
        assert!(!json.contains("offset:"));
        assert!(!json.contains("lyric"));
    }

    #[test]
    fn variants_align_when_their_own_offsets_match_the_original_timeline() {
        let timeline = service(json!({
            "trackId": "song-mid-1",
            "lyric": "[00:01]原文",
            "translation": "[offset:100]\n[00:00.900]Translation",
            "romanization": "[00:01.000]yuan wen"
        }))
        .timeline("song-mid-1", 1)
        .expect("timeline");
        assert_eq!(
            timeline.lines[0].translation.as_deref(),
            Some("Translation")
        );
        assert_eq!(timeline.lines[0].romanization.as_deref(), Some("yuan wen"));
    }

    #[test]
    fn mismatched_track_unknown_fields_and_malformed_lrc_are_rejected() {
        for value in [
            json!({"trackId":"other","lyric":"[00:01]x","translation":"","romanization":""}),
            json!({"trackId":"song-mid-1","lyric":"[00:61]x","translation":"","romanization":""}),
            json!({"trackId":"song-mid-1","lyric":"[00:01]x","translation":"","romanization":"","url":"SENTINEL"}),
        ] {
            assert_eq!(
                service(value).timeline("song-mid-1", 1),
                Err(LyricError::UpstreamSchemaChanged)
            );
        }
    }

    #[test]
    fn upstream_unavailable_is_mapped_to_transient_error() {
        assert_eq!(
            map_provider_failure("upstream_unavailable"),
            LyricError::UpstreamUnavailable
        );
    }

    #[test]
    fn missing_timed_original_is_a_stable_unavailable_result() {
        assert_eq!(
            service(json!({
                "trackId": "song-mid-1",
                "lyric": "[ar:artist]metadata only",
                "translation": "",
                "romanization": ""
            }))
            .timeline("song-mid-1", 1),
            Err(LyricError::Unavailable)
        );
    }

    #[test]
    fn bilibili_subtitle_parsing_validates_sources_intervals_utf8_bytes_and_schema() {
        let manual = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "123",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"},
                "source": "manual",
                "lines": [
                    {"atMs": 500, "endMs": 2000, "text": "第一句"},
                    {"atMs": 2000, "endMs": 4500, "text": "第二句"}
                ]
            }),
        )
        .expect("manual subtitles");
        assert_eq!(manual.source, Some(LyricSource::BilibiliSubtitle));
        assert_eq!(manual.lines.len(), 2);
        assert_eq!(manual.lines[0].end_ms, Some(2000));

        let unknown = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "123",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"},
                "source": "unknown",
                "lines": [{"atMs": 0, "endMs": 1000, "text": "未知来源"}]
            }),
        )
        .expect("unknown source maps to generic BilibiliSubtitle");
        assert_eq!(unknown.source, Some(LyricSource::BilibiliSubtitle));

        let ai = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "124",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "124"},
                "source": "ai",
                "lines": [{"atMs": 100, "endMs": 900, "text": "AI 字幕"}]
            }),
        )
        .expect("ai subtitles");
        assert_eq!(ai.source, Some(LyricSource::BilibiliAiSubtitle));

        let empty = parse_bilibili_subtitles(
            "BV17x411w7KE",
            "123",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KE", "cid": "123"},
                "source": "none",
                "lines": []
            }),
        )
        .expect("none with empty lines");
        assert_eq!(empty.source, None);
        assert!(empty.lines.is_empty());

        let too_many_lines: Vec<_> = (0..=MAX_TIMED_LINES)
            .map(|i| json!({"atMs": i * 2 + 1, "endMs": i * 2 + 2, "text": "line"}))
            .collect();
        let over_512_utf8_bytes = "汉".repeat(171); // 171 * 3 = 513 bytes
        assert!(over_512_utf8_bytes.len() > MAX_LINE_BYTES);

        for invalid in [
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "none", "lines": [{"atMs": 0, "endMs": 100, "text": "x"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": []}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "ai", "lines": []}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "unknown", "lines": []}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "bogus", "lines": [{"atMs": 0, "endMs": 100, "text": "x"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "124"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": "x"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 100, "endMs": 100, "text": "x"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 86_400_001, "text": "x"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 100, "endMs": 300, "text": "a"}, {"atMs": 250, "endMs": 400, "text": "b"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 100, "endMs": 200, "text": "a"}, {"atMs": 100, "endMs": 300, "text": "b"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": "   "}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": over_512_utf8_bytes}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": "a\nb"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": "a\rb"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": [{"atMs": 0, "endMs": 100, "text": "a\0b"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "123"}, "source": "manual", "lines": too_many_lines}),
        ] {
            assert_eq!(
                parse_bilibili_subtitles("BV17x411w7KC", "123", invalid.clone()),
                Err(LyricError::UpstreamSchemaChanged),
                "expected UpstreamSchemaChanged for {invalid}"
            );
        }
    }

    #[test]
    fn bilibili_error_mapping_covers_auth_network_timeout_and_schema() {
        use crate::multi_provider::{protocol::Error, ErrorCode};
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::AuthenticationRequired)),
            LyricError::AuthenticationRequired
        );
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::CredentialInvalid)),
            LyricError::AuthenticationRequired
        );
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::NetworkUnavailable)),
            LyricError::NetworkUnavailable
        );
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::RateLimited)),
            LyricError::NetworkUnavailable
        );
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::VerificationRequired)),
            LyricError::UpstreamUnavailable
        );
        assert_eq!(
            map_bilibili_error(Error::Timeout),
            LyricError::UpstreamUnavailable
        );
        assert_eq!(
            map_bilibili_error(Error::Upstream(ErrorCode::UpstreamSchemaChanged)),
            LyricError::UpstreamSchemaChanged
        );
        assert_eq!(
            map_bilibili_error(Error::Schema),
            LyricError::UpstreamSchemaChanged
        );
        assert_eq!(
            map_bilibili_error(Error::Unavailable),
            LyricError::ProviderUnavailable
        );
    }

    #[test]
    fn bilibili_cache_and_single_flight_key_by_bvid_cid_and_session_generation_without_caching_errors() {
        let svc = Arc::new(service(json!({})));
        let calls = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = mpsc::channel();
        let release = Arc::new(AtomicBool::new(false));

        let svc_a = svc.clone();
        let calls_a = calls.clone();
        let release_a = release.clone();
        let t1 = thread::spawn(move || {
            svc_a.resolve_cached("bilibili:BV17x411w7KC:123:1", || true, || {
                calls_a.fetch_add(1, Ordering::SeqCst);
                started.send(()).unwrap();
                while !release_a.load(Ordering::Acquire) {
                    thread::yield_now();
                }
                Ok(ResolvedLyrics {
                    source: Some(LyricSource::BilibiliSubtitle),
                    timeline_end_ms: None,
                    lines: Arc::new(vec![LyricLine {
                        at_ms: 100,
                        end_ms: Some(900),
                        original: "line".into(),
                        translation: None,
                        romanization: None,
                    }]),
                })
            })
        });
        started_rx.recv().unwrap();

        let svc_b = svc.clone();
        let calls_b = calls.clone();
        let t2 = thread::spawn(move || {
            svc_b.resolve_cached("bilibili:BV17x411w7KC:123:1", || true, || {
                calls_b.fetch_add(1, Ordering::SeqCst);
                unreachable!("concurrent identical key must share single-flight")
            })
        });
        wait_for_waiter(&svc, "bilibili:BV17x411w7KC:123:1");
        release.store(true, Ordering::Release);

        assert_eq!(t1.join().unwrap().unwrap().lines.len(), 1);
        assert_eq!(t2.join().unwrap().unwrap().lines.len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Cache hit on same (bvid, cid, session_generation).
        let cached = svc
            .resolve_cached("bilibili:BV17x411w7KC:123:1", || true, || unreachable!("cached"))
            .unwrap();
        assert_eq!(cached.source, Some(LyricSource::BilibiliSubtitle));

        // Errors are never cached and do not evict or poison subsequent attempts.
        let err = svc.resolve_cached("bilibili:BV17x411w7KC:124:1", || true, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(LyricError::UpstreamUnavailable)
        });
        assert_eq!(err.err(), Some(LyricError::UpstreamUnavailable));
        let retry = svc
            .resolve_cached("bilibili:BV17x411w7KC:124:1", || true, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(ResolvedLyrics {
                    source: None,
                    timeline_end_ms: None,
                    lines: Arc::new(Vec::new()),
                })
            })
            .unwrap();
        assert_eq!(retry.source, None);
        assert!(retry.lines.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // Session generation change invalidates the cached empty result.
        let new_session = svc
            .resolve_cached("bilibili:BV17x411w7KC:124:2", || true, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(ResolvedLyrics {
                    source: Some(LyricSource::BilibiliAiSubtitle),
                    timeline_end_ms: None,
                    lines: Arc::new(vec![LyricLine {
                        at_ms: 500,
                        end_ms: Some(1500),
                        original: "restored".into(),
                        translation: None,
                        romanization: None,
                    }]),
                })
            })
            .unwrap();
        assert_eq!(new_session.source, Some(LyricSource::BilibiliAiSubtitle));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn bilibili_timeline_serializes_end_ms_source_and_empty_lines_cleanly() {
        let positive = LyricTimeline {
            generation: 5,
            track_id: "bilibili:video:BV17x411w7KC:123".into(),
            source: Some(LyricSource::BilibiliAiSubtitle),
            timeline_end_ms: None,
            lines: vec![LyricLine {
                at_ms: 1200,
                end_ms: Some(3400),
                original: "AI 字幕".into(),
                translation: None,
                romanization: None,
            }],
        };
        let encoded = serde_json::to_value(&positive).expect("serialize timeline");
        assert_eq!(
            encoded,
            json!({
                "generation": 5,
                "trackId": "bilibili:video:BV17x411w7KC:123",
                "source": "bilibiliAiSubtitle",
                "lines": [{
                    "atMs": 1200,
                    "endMs": 3400,
                    "original": "AI 字幕"
                }]
            })
        );
        assert!(encoded.get("timelineEndMs").is_none());

        let truncated = LyricTimeline {
            generation: 7,
            track_id: "bilibili:video:BV17x411w7KC:127".into(),
            source: Some(LyricSource::BilibiliSubtitle),
            timeline_end_ms: Some(3_000_000),
            lines: vec![LyricLine {
                at_ms: 1200,
                end_ms: Some(3400),
                original: "截断字幕".into(),
                translation: None,
                romanization: None,
            }],
        };
        let truncated_encoded = serde_json::to_value(&truncated).expect("serialize truncated");
        assert_eq!(
            truncated_encoded,
            json!({
                "generation": 7,
                "trackId": "bilibili:video:BV17x411w7KC:127",
                "source": "bilibiliSubtitle",
                "timelineEndMs": 3_000_000,
                "lines": [{
                    "atMs": 1200,
                    "endMs": 3400,
                    "original": "截断字幕"
                }]
            })
        );

        let qq_timeline = service(json!({
            "trackId": "song-mid-1",
            "lyric": "[00:01.00]QQ 歌词",
            "translation": "",
            "romanization": ""
        }))
        .timeline("song-mid-1", 8)
        .expect("qq timeline");
        assert_eq!(qq_timeline.timeline_end_ms, None);
        assert!(serde_json::to_value(&qq_timeline)
            .expect("serialize qq")
            .get("timelineEndMs")
            .is_none());

        let empty = LyricTimeline {
            generation: 6,
            track_id: "bilibili:video:BV17x411w7KE:123".into(),
            source: None,
            timeline_end_ms: None,
            lines: Vec::new(),
        };
        let empty_encoded = serde_json::to_value(&empty).expect("serialize empty");
        assert_eq!(
            empty_encoded,
            json!({
                "generation": 6,
                "trackId": "bilibili:video:BV17x411w7KE:123",
                "lines": []
            })
        );
    }

    #[test]
    fn bilibili_subtitle_parsing_validates_timeline_end_ms_bounds_and_unknown_keys() {
        let truncated = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "127",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"},
                "source": "manual",
                "timelineEndMs": 3_000_000,
                "lines": [
                    {"atMs": 500, "endMs": 2000, "text": "第一句"},
                    {"atMs": 2000, "endMs": 4500, "text": "最后一句"}
                ]
            }),
        )
        .expect("valid truncated timelineEndMs");
        assert_eq!(truncated.source, Some(LyricSource::BilibiliSubtitle));
        assert_eq!(truncated.timeline_end_ms, Some(3_000_000));

        let exact_end = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "127",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"},
                "source": "manual",
                "timelineEndMs": 4500,
                "lines": [
                    {"atMs": 500, "endMs": 2000, "text": "第一句"},
                    {"atMs": 2000, "endMs": 4500, "text": "最后一句"}
                ]
            }),
        )
        .expect("timelineEndMs equal to last.endMs");
        assert_eq!(exact_end.timeline_end_ms, Some(4500));

        let max_end = parse_bilibili_subtitles(
            "BV17x411w7KC",
            "127",
            json!({
                "track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"},
                "source": "ai",
                "timelineEndMs": 86_400_000,
                "lines": [
                    {"atMs": 500, "endMs": 2000, "text": "第一句"}
                ]
            }),
        )
        .expect("timelineEndMs at MAX_BILIBILI_SUBTITLE_MS");
        assert_eq!(max_end.timeline_end_ms, Some(86_400_000));

        for invalid in [
            // timelineEndMs on empty lines
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "none", "timelineEndMs": 1000, "lines": []}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": 1000, "lines": []}),
            // timelineEndMs < last.endMs
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": 4499, "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
            // timelineEndMs > 86_400_000
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": 86_400_001, "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
            // non-u64 timelineEndMs
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": null, "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": "4500", "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
            // unknown extra keys (with or without timelineEndMs)
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "extra": 1, "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
            json!({"track": {"kind": "videoPart", "bvid": "BV17x411w7KC", "cid": "127"}, "source": "manual", "timelineEndMs": 5000, "extra": 1, "lines": [{"atMs": 2000, "endMs": 4500, "text": "最后一句"}]}),
        ] {
            assert_eq!(
                parse_bilibili_subtitles("BV17x411w7KC", "127", invalid.clone()),
                Err(LyricError::UpstreamSchemaChanged),
                "expected UpstreamSchemaChanged for {invalid}"
            );
        }
    }
}
