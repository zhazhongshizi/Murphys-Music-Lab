//! Private loopback streaming bridge. Source URLs never enter public DTOs.
use crate::{
    network_policy::{
        is_allowed_resolved_address, DnsResolver, RemoteUrlPurpose, SystemDnsResolver,
    },
    player::{private_bridge_url, private_bridge_manifest_url, RemoteMediaUrl},
};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, Request, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::StreamExt;
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::watch;

pub(crate) const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

#[derive(Default)]
pub struct Metrics {
    pub get: AtomicU64,
    pub head: AtomicU64,
    pub range: AtomicU64,
    pub bytes: AtomicU64,
}
struct Source {
    url: url::Url,
    client: reqwest::Client,
    backups: Vec<(url::Url, reqwest::Client)>,
    selected: tokio::sync::Mutex<Option<usize>>,
    revoked: watch::Sender<bool>,
    metrics: Arc<Metrics>,
    referer: &'static str,
    length: Mutex<Option<u64>>,
    guard: Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
    manifest: Mutex<Option<String>>,
}
pub struct MediaBridge {
    address: SocketAddr,
    token: uuid::Uuid,
    source: Arc<Source>,
    server: tauri::async_runtime::JoinHandle<()>,
    guard_task: tauri::async_runtime::JoinHandle<()>,
}

pub fn validate_bilibili_url(value: &str) -> Result<url::Url, &'static str> {
    if value.len() > 8192 {
        return Err("invalid_media_url");
    }
    let u = url::Url::parse(value).map_err(|_| "invalid_media_url")?;
    let host = u.host_str().ok_or("invalid_media_url")?;
    if u.scheme() != "https"
        || u.port_or_known_default() != Some(443)
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || !(host.ends_with(".bilivideo.com")
            || host.ends_with(".bilivideo.cn")
            || host == "upos-hz-mirrorakam.akamaized.net")
    {
        return Err("invalid_media_url");
    }
    Ok(u)
}
impl MediaBridge {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::start(url::Url::parse("http://127.0.0.1:9/unused-test-media").unwrap(),reqwest::Client::new()).unwrap()
    }
    pub fn netease(value: &str) -> Result<Self, &'static str> {
        let url = validate_netease_url(value)?;
        let host = url.host_str().ok_or("invalid_media_url")?;
        let ips = SystemDnsResolver.resolve(host, 443).map_err(|_| "media_dns_failed")?;
        if ips.is_empty() || ips.iter().any(|ip| !is_allowed_resolved_address(*ip, RemoteUrlPurpose::Media)) {
            return Err("media_dns_denied");
        }
        let addrs: Vec<_> = ips.into_iter().map(|ip| SocketAddr::new(ip,443)).collect();
        let client = reqwest::Client::builder().no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(20))
            .resolve_to_addrs(host,&addrs).build().map_err(|_| "media_client_failed")?;
        Self::start_with_referer(url,client,"https://music.163.com/")
    }
    pub fn bilibili(value: &str) -> Result<Self, &'static str> {
        Self::bilibili_candidates(&[value])
    }
    pub fn bilibili_candidates(values: &[&str]) -> Result<Self, &'static str> {
        if values.is_empty() || values.len() > 9 { return Err("invalid_media_url"); }
        // Validate every candidate before attempting DNS; even an unused backup
        // cannot smuggle a private host, Cookie or redirect into the bridge.
        let urls: Vec<_> = values.iter().map(|u| validate_bilibili_url(u)).collect::<Result<_, _>>()?;
        let mut candidates = Vec::new();
        for url in urls {
            let host = url.host_str().ok_or("invalid_media_url")?;
            let Ok(ips) = SystemDnsResolver.resolve(host, 443) else { continue; };
            if ips.iter().any(|ip| !is_allowed_resolved_address(*ip, RemoteUrlPurpose::Media)) { return Err("media_dns_denied"); }
            if ips.is_empty() { continue; }
            let addrs: Vec<_> = ips.into_iter().map(|ip| SocketAddr::new(ip, 443)).collect();
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(20))
                .resolve_to_addrs(host, &addrs).build().map_err(|_| "media_client_failed")?;
            candidates.push((url, client));
        }
        if candidates.is_empty() { return Err("media_dns_failed"); }
        let (url, client) = candidates.remove(0);
        Self::start_candidates(url, client, "https://www.bilibili.com/", candidates)
    }
    #[cfg(test)]
    fn start(url: url::Url, client: reqwest::Client) -> Result<Self, &'static str> {
        Self::start_with_referer(url, client, "https://www.bilibili.com/")
    }
    fn start_with_referer(url: url::Url, client: reqwest::Client, referer: &'static str) -> Result<Self, &'static str> {
        Self::start_candidates(url, client, referer, Vec::new())
    }
    fn start_candidates(url: url::Url, client: reqwest::Client, referer: &'static str, backups: Vec<(url::Url, reqwest::Client)>) -> Result<Self, &'static str> {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "bridge_bind_failed")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "bridge_bind_failed")?;
        let address = listener.local_addr().map_err(|_| "bridge_bind_failed")?;
        let token = uuid::Uuid::new_v4();
        let (revoked, _) = watch::channel(false);
        let source = Arc::new(Source {
            url,
            client,
            backups,
            selected: tokio::sync::Mutex::new(None),
            revoked,
            metrics: Arc::new(Metrics::default()),
            referer,
            length: Mutex::new(None),
            guard: Mutex::new(None),
            manifest: Mutex::new(None),
        });
        let router = Router::new()
            .route(&format!("/media/{}", token.simple()), any(serve))
            .route(&format!("/media/{}/manifest.mpd", token.simple()), any(serve_manifest))
            .with_state(source.clone());
        let server = tauri::async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = axum::serve(listener, router).await;
            }
        });
        let weak=Arc::downgrade(&source);
        let guard_task=tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let Some(s)=weak.upgrade() else {break;};
                if !source_allowed(&s) {s.revoked.send_replace(true);break;}
            }
        });
        Ok(Self {
            address,
            token,
            source,
            server,
            guard_task,
        })
    }
    pub fn native_url(&self) -> RemoteMediaUrl {
        if self.source.manifest.lock().unwrap().is_some() {
            private_bridge_manifest_url(self.address.port(), self.token)
        } else { private_bridge_url(self.address.port(), self.token) }
    }
    pub fn set_dash(&self, initialization: &str, index_range: &str, bitrate: u64, duration_ms: u64) -> Result<(), &'static str> {
        fn range(s: &str) -> Option<(u64,u64)> {
            if s.len()>17 || !s.bytes().all(|b|b.is_ascii_digit()||b==b'-') {return None;}
            let (start,end)=s.split_once('-')?; let (start,end)=(start.parse().ok()?,end.parse().ok()?);
            (start<=end && end-start<1048576 && end<2097152).then_some((start,end))
        }
        let (start,end)=range(initialization).ok_or("invalid_dash_index")?;
        let (index_start,_)=range(index_range).ok_or("invalid_dash_index")?;
        if start!=0 || end>=index_start || bitrate==0 || bitrate>100000000 || duration_ms==0 || duration_ms>86400000 {return Err("invalid_dash_index");}
        // Numeric data and a local opaque handle only. No titles, external URLs,
        // XML supplied by upstream, account headers or renderer input enter MPD.
        let duration=format!("PT{}.{:03}S",duration_ms/1000,duration_ms%1000);
        let manifest=format!(r#"<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT1.5S" mediaPresentationDuration="{duration}"><Period start="PT0S" duration="{duration}"><AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1"><Representation id="aac" codecs="mp4a.40.2" bandwidth="{bitrate}"><BaseURL>/media/{}</BaseURL><SegmentBase indexRange="{index_range}" indexRangeExact="true"><Initialization range="{initialization}"/></SegmentBase></Representation></AdaptationSet></Period></MPD>"#,self.token.simple());
        *self.source.manifest.lock().unwrap()=Some(manifest); Ok(())
    }
    /// Loopback-only verification endpoint. Do not publish it to renderer/Remote.
    pub fn local_url_for_checks(&self) -> String {
        format!("http://{}/media/{}", self.address, self.token.simple())
    }
    pub fn metrics(&self) -> Arc<Metrics> {
        self.source.metrics.clone()
    }
    pub fn revoke(&self) {
        self.source.revoked.send_replace(true);
    }
    pub fn bind_account(&self, guard: Arc<dyn Fn()->bool+Send+Sync>) {
        *self.source.guard.lock().unwrap()=Some(guard);
    }
}
pub fn validate_netease_url(value: &str) -> Result<url::Url, &'static str> {
    if value.len()>8192 { return Err("invalid_media_url"); }
    let u=url::Url::parse(value).map_err(|_| "invalid_media_url")?;
    if u.scheme()!="https" || u.port_or_known_default()!=Some(443) || !u.username().is_empty()
        || u.password().is_some() || u.fragment().is_some()
        || !u.host_str().is_some_and(|h| h.ends_with(".music.126.net")) {
        return Err("invalid_media_url");
    }
    Ok(u)
}
impl Drop for MediaBridge {
    fn drop(&mut self) {
        self.revoke();
        self.server.abort();
        self.guard_task.abort();
    }
}
fn response(code: StatusCode) -> Response {
    Response::builder()
        .status(code)
        .body(Body::empty())
        .unwrap()
}
async fn serve_manifest(State(source): State<Arc<Source>>, request: Request<Body>) -> Response {
    if !source_allowed(&source) {return response(StatusCode::NOT_FOUND);}
    if !matches!(*request.method(),Method::GET|Method::HEAD) {return response(StatusCode::METHOD_NOT_ALLOWED);}
    let manifest=source.manifest.lock().unwrap().clone();
    let Some(manifest)=manifest else{return response(StatusCode::NOT_FOUND);};
    Response::builder().header(header::CONTENT_TYPE,"application/dash+xml").header(header::CACHE_CONTROL,"no-store")
        .header(header::CONTENT_LENGTH,manifest.len()).body(if request.method()==Method::HEAD{Body::empty()}else{Body::from(manifest)}).unwrap()
}
fn valid_range(value: &str) -> bool {
    let Some(value) = value.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = value.split_once('-') else {
        return false;
    };
    if start.is_empty() {
        return end.parse::<u64>().is_ok_and(|n| n > 0) && end.bytes().all(|b| b.is_ascii_digit());
    }
    let Ok(a) = start.parse::<u64>() else {
        return false;
    };
    start.bytes().all(|b| b.is_ascii_digit())
        && (end.is_empty()
            || end.bytes().all(|b| b.is_ascii_digit()) && end.parse::<u64>().is_ok_and(|b| b >= a))
}
fn valid_content_range(headers: &HeaderMap, status: StatusCode) -> bool {
    let Some(value) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(value) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, total)) = value.split_once('/') else {
        return false;
    };
    let Ok(total) = total.parse::<u64>() else {
        return false;
    };
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return range == "*";
    }
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    let (Ok(start), Ok(end)) = (start.parse::<u64>(), end.parse::<u64>()) else {
        return false;
    };
    start <= end
        && end < total
        && headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_none_or(|n| n == end - start + 1)
}
async fn serve(State(source): State<Arc<Source>>, request: Request<Body>) -> Response {
    if !source_allowed(&source) {
        return response(StatusCode::NOT_FOUND);
    }
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return response(StatusCode::METHOD_NOT_ALLOWED);
    }
    if let Some(range) = request.headers().get(header::RANGE) {
        if !range.to_str().is_ok_and(valid_range) {
            return response(StatusCode::BAD_REQUEST);
        }
        // Some Bilibili CDNs omit Content-Range on 416. Once HEAD/206 has
        // established the object length, synthesize the standards-compliant
        // unsatisfied range locally without requesting bytes beyond that object.
        if let Some(length) = *source.length.lock().unwrap() {
            let start = range
                .to_str()
                .ok()
                .and_then(|v| v.strip_prefix("bytes="))
                .and_then(|v| v.split_once('-'))
                .and_then(|(start, _)| start.parse::<u64>().ok());
            if length == 0 || start.is_some_and(|start| start >= length) {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .header(header::CONTENT_LENGTH, "0")
                    .body(Body::empty())
                    .unwrap();
            }
        }
        source.metrics.range.fetch_add(1, Ordering::Relaxed);
    }
    if method == Method::HEAD {
        source.metrics.head.fetch_add(1, Ordering::Relaxed);
    } else {
        source.metrics.get.fetch_add(1, Ordering::Relaxed);
    }
    let mut cancelled = source.revoked.subscribe();
    if *cancelled.borrow() {
        return response(StatusCode::NOT_FOUND);
    }
    // Serialize candidate selection through response headers. Once a GET has
    // succeeded, every Range request stays on that exact object. Stream failure
    // after this point goes to the existing once-per-intent re-resolution path.
    let mut selected = tokio::select! { s=source.selected.lock()=>s, _=cancelled.changed()=>return response(StatusCode::NOT_FOUND) };
    let indexes: Vec<_> = selected.map_or_else(|| (0..=source.backups.len()).collect(), |i| vec![i]);
    let mut response_and_index = None;
    for index in indexes {
        let (url, client) = if index == 0 { (&source.url, &source.client) } else { let (u,c) = &source.backups[index-1]; (u,c) };
        let mut req = client.request(method.clone(), url.clone()).header(header::USER_AGENT, UA)
            .header(header::REFERER, source.referer).header(header::ACCEPT_ENCODING, "identity");
        if let Some(range) = request.headers().get(header::RANGE) { req = req.header(header::RANGE, range); }
        let result = tokio::select! {r=req.send()=>r, _=cancelled.changed()=>return response(StatusCode::NOT_FOUND)};
        match result {
            // Try each validated same-stream candidate at most once for 5xx,
            // only before a successful GET pins the object. Redirects, policy
            // errors and 416 retain their existing fail-closed/range semantics.
            Ok(r) if selected.is_none() && r.status().is_server_error() => continue,
            Ok(r) => { response_and_index = Some((r,index)); break; }
            Err(_) if selected.is_none() => continue,
            Err(_) => return response(StatusCode::BAD_GATEWAY),
        }
    }
    let Some((upstream, index)) = response_and_index else { return response(StatusCode::BAD_GATEWAY); };
    if !source_allowed(&source) {
        return response(StatusCode::NOT_FOUND);
    }
    let status = upstream.status();
    #[cfg(feature = "manual-spikes")]
    eprintln!("[provider-bridge] method={} range={} status={} content_range={} length={} accept_ranges={}", method,
        request.headers().get(header::RANGE).and_then(|v|v.to_str().ok()).unwrap_or("none"), status.as_u16(),
        upstream.headers().get(header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).unwrap_or("none"),
        upstream.headers().get(header::CONTENT_LENGTH).and_then(|v|v.to_str().ok()).unwrap_or("none"),
        upstream.headers().get(header::ACCEPT_RANGES).and_then(|v|v.to_str().ok()).unwrap_or("none"));
    if ![
        StatusCode::OK,
        StatusCode::PARTIAL_CONTENT,
        StatusCode::RANGE_NOT_SATISFIABLE,
    ]
    .contains(&status)
    {
        return response(StatusCode::BAD_GATEWAY);
    }
    if status != StatusCode::OK && !valid_content_range(upstream.headers(), status) {
        return response(StatusCode::BAD_GATEWAY);
    }
    let length = if status == StatusCode::OK {
        upstream
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
    } else if status == StatusCode::PARTIAL_CONTENT {
        upstream
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split_once('/'))
            .and_then(|(_, total)| total.parse::<u64>().ok())
    } else {
        None
    };
    if let Some(length) = length {
        *source.length.lock().unwrap() = Some(length);
    }
    if status != StatusCode::RANGE_NOT_SATISFIABLE {
        let kind = upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("");
        if !["audio/mp4", "video/mp4", "audio/mpeg", "audio/flac", "audio/x-flac", "application/octet-stream"].contains(&kind) {
            return response(StatusCode::BAD_GATEWAY);
        }
    }
    if method == Method::GET && status != StatusCode::RANGE_NOT_SATISFIABLE { *selected = Some(index); }
    drop(selected);
    let mut out = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    // A valid 206 proves byte-range support even when this CDN omits the hint.
    // Keep that capability visible to the native seekable HTTP media source.
    if status == StatusCode::PARTIAL_CONTENT && !upstream.headers().contains_key(header::ACCEPT_RANGES) {
        out = out.header(header::ACCEPT_RANGES, "bytes");
    }
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::CONTENT_LENGTH,
        header::ACCEPT_RANGES,
    ] {
        if status == StatusCode::RANGE_NOT_SATISFIABLE && name == header::CONTENT_LENGTH {
            continue;
        }
        if let Some(value) = upstream.headers().get(&name) {
            if name == header::CONTENT_TYPE && source.referer == "https://www.bilibili.com/"
                && value.to_str().is_ok_and(|s|s.split(';').next()==Some("application/octet-stream")) {
                // Bilibili resolution selects AAC-in-MP4 exclusively; the
                // generic CDN content type need not hide that from decoders.
                out = out.header(name, "audio/mp4");
                continue;
            }
            out = out.header(name, value);
        }
    }
    let body = if method == Method::HEAD || status == StatusCode::RANGE_NOT_SATISFIABLE {
        // For 416, don't forward a remote error body with a different Content-Length.
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            out = out.header(header::CONTENT_LENGTH, "0");
        }
        Body::empty()
    } else {
        let metrics = source.metrics.clone();
        let stream = upstream
            .bytes_stream()
            .map(move |chunk| {
                if let Ok(ref bytes) = chunk {
                    metrics
                        .bytes
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                }
                chunk
            })
            .take_until(async move {
                if !*cancelled.borrow() {
                    let _ = cancelled.changed().await;
                }
            });
        Body::from_stream(stream)
    };
    out.body(body).unwrap()
}
fn source_allowed(s:&Source)->bool {
    !*s.revoked.borrow() && s.guard.lock().unwrap().as_ref().is_none_or(|f|f())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dash_manifest_has_only_local_audio_and_validated_numeric_index_and_is_revocable() {
        tauri::async_runtime::block_on(async {
            let bridge=MediaBridge::fixture();
            for (init,index) in [("0-9\"/>","10-20"),("1-9","10-20"),("0-20","10-30"),("0-9","10-3000000")] {
                assert!(bridge.set_dash(init,index,192000,7200000).is_err());
            }
            bridge.set_dash("0-907","908-1047",192000,7200000).unwrap();
            let url=format!("{}/manifest.mpd",bridge.local_url_for_checks());
            let client=reqwest::Client::builder().no_proxy().build().unwrap();
            let r=client.get(&url).send().await.unwrap(); assert_eq!(r.headers()[header::CONTENT_TYPE],"application/dash+xml");
            let xml=r.text().await.unwrap();
            assert!(xml.contains("PT7200.000S"));assert!(xml.contains("mp4a.40.2"));assert!(xml.contains("indexRange=\"908-1047\""));
            assert!(xml.contains(&format!("<BaseURL>/media/{}</BaseURL>",bridge.token.simple())));
            assert!(!xml.contains("https://"));assert!(!xml.contains("Cookie"));
            bridge.revoke();assert_eq!(client.get(&url).send().await.unwrap().status(),404);
        });
    }
    #[test]
    fn primary_network_failure_uses_backup_then_pins_all_ranges() {
        tauri::async_runtime::block_on(async {
            let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let dead_address = dead.local_addr().unwrap(); drop(dead);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let hit = Arc::new(AtomicU64::new(0)); let counter = hit.clone();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, Router::new().route("/audio", any(move |request: Request<Body>| {
                    let counter = counter.clone(); async move {
                        assert!(request.headers().get(header::COOKIE).is_none());
                        if counter.fetch_add(1, Ordering::SeqCst) > 0 { return response(StatusCode::BAD_GATEWAY); }
                        Response::builder().header(header::CONTENT_TYPE, "audio/mp4").header(header::CONTENT_LENGTH, "6").body(Body::from("abcdef")).unwrap()
                    }
                }))).await.unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap();
            let bridge = MediaBridge::start_candidates(
                url::Url::parse(&format!("http://{dead_address}/primary")).unwrap(), client.clone(), "https://www.bilibili.com/",
                vec![(url::Url::parse(&format!("http://{address}/audio")).unwrap(), client.clone()),
                     (url::Url::parse(&format!("http://{address}/unused")).unwrap(), client.clone())]).unwrap();
            let url = bridge.local_url_for_checks();
            assert_eq!(client.get(&url).send().await.unwrap().text().await.unwrap(), "abcdef");
            assert_eq!(*bridge.source.selected.lock().await, Some(1));
            // Candidate 1 now fails. Its delivered bytes prohibit moving to 2.
            assert_eq!(client.get(&url).header(header::RANGE, "bytes=2-").send().await.unwrap().status(), 502);
            assert_eq!(*bridge.source.selected.lock().await, Some(1));
            assert_eq!(hit.load(Ordering::SeqCst), 2);
            drop(bridge); server.abort();
        });
    }
    #[test]
    fn http_5xx_candidates_are_bounded_before_delivery_and_never_splice_after_success() {
        tauri::async_runtime::block_on(async {
            for primary_status in [500, 501, 502, 503, 504, 599] {
                let (bridge, hits, server) = http_fallback_fixture(primary_status, 200).await;
                let client = reqwest::Client::builder().no_proxy().build().unwrap();
                let url = bridge.local_url_for_checks();
                assert_eq!(client.get(&url).send().await.unwrap().text().await.unwrap(), "abcdef");
                assert_eq!(*bridge.source.selected.lock().await, Some(1));
                assert_eq!(client.get(&url).header(header::RANGE,"bytes=2-").send().await.unwrap().status(), 502);
                assert_eq!(hits.iter().map(|v|v.load(Ordering::SeqCst)).collect::<Vec<_>>(), vec![1,2,0]);
                assert_eq!(*bridge.source.selected.lock().await, Some(1));
                drop(bridge); server.abort();
            }
            let (bridge, hits, server) = http_fallback_fixture(503, 503).await;
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            assert_eq!(client.get(bridge.local_url_for_checks()).send().await.unwrap().status(),502);
            assert_eq!(hits.iter().map(|v|v.load(Ordering::SeqCst)).collect::<Vec<_>>(),vec![1,1,1]);
            assert_eq!(*bridge.source.selected.lock().await,None);
            drop(bridge); server.abort();
        });
    }
    #[test]
    fn fallback_does_not_bypass_redirect_policy_or_416_semantics() {
        tauri::async_runtime::block_on(async {
            // 200 fixture deliberately has an invalid MIME type; policy errors
            // cannot be disguised as a transient server failure either.
            for primary_status in [200,302,403,416] {
                let (bridge,hits,server)=http_fallback_fixture(primary_status,200).await;
                let client=reqwest::Client::builder().no_proxy().build().unwrap();
                let r=client.get(bridge.local_url_for_checks()).send().await.unwrap();
                assert_eq!(r.status().as_u16(),if primary_status==416 {416}else{502});
                assert_eq!(hits.iter().map(|v|v.load(Ordering::SeqCst)).collect::<Vec<_>>(),vec![1,0,0]);
                drop(bridge); server.abort();
            }
        });
    }
    async fn http_fallback_fixture(primary_status: u16, backup_status: u16) -> (MediaBridge, Arc<[AtomicU64;3]>, tauri::async_runtime::JoinHandle<()>) {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let hits=Arc::new([AtomicU64::new(0),AtomicU64::new(0),AtomicU64::new(0)]);let counters=hits.clone();
        let server=tauri::async_runtime::spawn(async move {
            axum::serve(listener,Router::new().route("/{name}",any(move |axum::extract::Path(name):axum::extract::Path<String>,request:Request<Body>| {
                let hits=counters.clone();async move {
                    assert!(request.headers().get(header::COOKIE).is_none());
                    let index=match name.as_str(){"primary"=>0,"backup"=>1,_=>2};
                    let previous=hits[index].fetch_add(1,Ordering::SeqCst);
                    let code=if index==0 {primary_status}else if previous>0 {503}else{backup_status};
                    let body=if code==200 {"abcdef"}else{""};
                    let mut r=Response::builder().status(code).header(header::CONTENT_LENGTH,body.len())
                        .header(header::CONTENT_TYPE,if index==0 {"text/html"}else{"audio/mp4"});
                    if code==302 {r=r.header(header::LOCATION,"/backup");}
                    if code==416 {r=r.header(header::CONTENT_RANGE,"bytes */6");}
                    r.body(Body::from(body)).unwrap()
                }
            }))).await.unwrap();
        });
        let client=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let urls:Vec<_>=["primary","backup","last"].iter().map(|p|url::Url::parse(&format!("http://{address}/{p}")).unwrap()).collect();
        let bridge=MediaBridge::start_candidates(urls[0].clone(),client.clone(),"https://www.bilibili.com/",vec![(urls[1].clone(),client.clone()),(urls[2].clone(),client)]).unwrap();
        (bridge,hits,server)
    }
    #[test]
    fn media_probe_policy_and_ranges() {
        for value in ["https://m801.music.126.net/a.mp3","https://m701.music.126.net/a.flac"] {assert!(validate_netease_url(value).is_ok());}
        for value in ["http://m801.music.126.net/a","https://music.126.net.evil.test/a","https://127.0.0.1/a","https://user@m801.music.126.net/a"] {assert!(validate_netease_url(value).is_err());}
        for value in [
            "http://upos.bilivideo.com/a",
            "https://bilivideo.com.evil.test/a",
            "https://127.0.0.1/a",
            "https://user@upos.bilivideo.com/a",
            "https://upos.bilivideo.com:444/a",
        ] {
            assert!(validate_bilibili_url(value).is_err());
        }
        assert!(validate_bilibili_url("https://upos.bilivideo.com/a?token=fixture").is_ok());
        for value in ["bytes=0-99", "bytes=100-", "bytes=-100"] {
            assert!(valid_range(value));
        }
        for value in [
            "bytes=9-1",
            "bytes=0-1,2-3",
            "bytes=-0",
            "bytes=+1-3",
            "bytes=0-18446744073709551616",
        ] {
            assert!(!valid_range(value));
        }
        assert!(RemoteMediaUrl::parse("http://127.0.0.1:1/media/token").is_err());
    }
    #[test]
    fn media_probe_http_and_revocation() {
        tauri::async_runtime::block_on(async {
            let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = upstream.local_addr().unwrap();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(
                    upstream,
                    Router::new().route(
                        "/audio",
                        any(|request: Request<Body>| async move {
                            assert!(!request.headers().contains_key(header::COOKIE));
                            assert!(!request.headers().contains_key(header::AUTHORIZATION));
                            assert_eq!(
                                request.headers()[header::REFERER],
                                "https://www.bilibili.com/"
                            );
                            let (status, range, body) = match request
                                .headers()
                                .get(header::RANGE)
                                .and_then(|v| v.to_str().ok())
                            {
                                Some("bytes=0-1") => (206, Some("bytes 0-1/6"), "ab"),
                                Some("bytes=99-") => (416, Some("bytes */6"), ""),
                                _ => (200, None, "abcdef"),
                            };
                            let mut out = Response::builder()
                                .status(status)
                                .header(header::CONTENT_TYPE, "audio/mp4")
                                .header(header::CONTENT_LENGTH, body.len());
                            if let Some(range) = range {
                                out = out.header(header::CONTENT_RANGE, range);
                            }
                            out.body(if request.method() == Method::HEAD {
                                Body::empty()
                            } else {
                                Body::from(body)
                            })
                            .unwrap()
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let bridge = MediaBridge::start(
                url::Url::parse(&format!("http://{address}/audio")).unwrap(),
                client.clone(),
            )
            .unwrap();
            let url = bridge.local_url_for_checks();
            assert_eq!(
                client.head(&url).send().await.unwrap().headers()[header::CONTENT_LENGTH],
                "6"
            );
            assert_eq!(
                client.get(&url).send().await.unwrap().text().await.unwrap(),
                "abcdef"
            );
            let partial = client
                .get(&url)
                .header(header::RANGE, "bytes=0-1")
                .header(header::COOKIE, "SYNTHETIC")
                .send()
                .await
                .unwrap();
            assert_eq!(partial.status(), 206);
            assert_eq!(partial.headers()[header::ACCEPT_RANGES], "bytes");
            assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 0-1/6");
            assert_eq!(partial.text().await.unwrap(), "ab");
            assert_eq!(
                client
                    .get(&url)
                    .header(header::RANGE, "bytes=99-")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                416
            );
            assert_eq!(
                client
                    .get(&url)
                    .header(header::RANGE, "bytes=9-1")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                400
            );
            assert_eq!(client.post(&url).send().await.unwrap().status(), 405);
            assert_eq!(
                client
                    .get(format!("http://{}/media/wrong", bridge.address))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
            bridge.revoke();
            assert_eq!(client.get(&url).send().await.unwrap().status(), 404);
            drop(bridge);
            server.abort();
        });
    }

    #[test]
    fn media_probe_slow_stream_cancels_without_buffering_complete_media() {
        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/slow",
                        any(|| async {
                            let chunks = futures_util::stream::unfold(0u32, |index| async move {
                                tokio::time::sleep(Duration::from_millis(30)).await;
                                Some((Ok::<_, std::io::Error>(vec![7u8; 1024]), index + 1))
                            });
                            Response::builder()
                                .header(header::CONTENT_TYPE, "audio/mp4")
                                .body(Body::from_stream(chunks))
                                .unwrap()
                        }),
                    ),
                )
                .await
                .unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let bridge = MediaBridge::start(
                url::Url::parse(&format!("http://{address}/slow")).unwrap(),
                client.clone(),
            )
            .unwrap();
            let response = tokio::time::timeout(
                Duration::from_secs(2),
                client.get(bridge.local_url_for_checks()).send(),
            )
            .await
            .unwrap()
            .unwrap();
            let mut body = response.bytes_stream();
            assert!(!tokio::time::timeout(Duration::from_secs(2), body.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .is_empty());
            bridge.revoke();
            tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(chunk) = body.next().await {
                    if chunk.is_err() {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            drop(bridge);
            server.abort();
        });
    }
}
