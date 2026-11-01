mod library;
pub(crate) use library::{default_provider_permits, RemoteLibrary};
// Opt-in LAN remote. Only explicit playback operations cross this boundary.
// The desktop owns credentials, sources and the single PlaybackSession.
use crate::{
    cover::CoverService,
    lyrics::LyricService,
    playback_session::{PlaybackMode, PlaybackSession, PlaybackSessionError},
};
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, ToSocketAddrs, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{oneshot, Semaphore};

const PORT: u16 = 19653;
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub addresses: Vec<String>,
    pub pairing_code: Option<String>,
}

#[derive(Default)]
pub struct RemoteControl {
    running: Mutex<Option<Running>>,
}
struct Running {
    status: RemoteStatus,
    alive: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl RemoteControl {
    pub fn status(&self) -> RemoteStatus {
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|r| r.alive.load(Ordering::Acquire))
            .map(|r| r.status.clone())
            .unwrap_or_default()
    }

    pub fn set_enabled(
        &self,
        enabled: bool,
        session: Option<Arc<PlaybackSession>>,
        cover: Option<Arc<CoverService>>,
        lyrics: Option<Arc<LyricService>>,
        library: Option<Arc<RemoteLibrary>>,
    ) -> Result<RemoteStatus, &'static str> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !enabled {
            *running = None;
            return Ok(RemoteStatus::default());
        }
        if let Some(r) = running.as_ref().filter(|r| r.alive.load(Ordering::Acquire)) {
            return Ok(r.status.clone());
        }
        let session = session.ok_or("播放核心尚未就绪")?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT))
            .map_err(|_| "遥控端口 19653 被占用或无法监听")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法启动局域网遥控")?;
        let code = uuid::Uuid::new_v4().simple().to_string();
        let alive = Arc::new(AtomicBool::new(true));
        let status = RemoteStatus {
            enabled: true,
            addresses: addresses(PORT),
            pairing_code: Some(code.clone()),
        };
        let data = Arc::new(RemoteState {
            session,
            cover,
            lyrics,
            library,
            code,
            alive: alive.clone(),
            permits: Arc::new(Semaphore::new(8)),
            port: PORT,
        });
        let (stop, stopped) = oneshot::channel();
        let server_alive = alive.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = axum::serve(
                    listener,
                    router(data).into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await;
            }
            server_alive.store(false, Ordering::Release);
        });
        *running = Some(Running {
            status: status.clone(),
            alive,
            stop: Some(stop),
        });
        Ok(status)
    }
}

fn addresses(port: u16) -> Vec<String> {
    let mut result = Vec::new();
    // UDP connect selects the current route; it does not transmit a packet.
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        if socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if lan_ip(addr.ip()) && !addr.ip().is_loopback() {
                    result.push(format!("http://{}:{port}", addr.ip()));
                }
            }
        }
    }
    // A VPN may own the default route. Also list this computer's LAN interfaces.
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if let Ok(addrs) = (name.as_str(), port).to_socket_addrs() {
            for addr in addrs {
                let address = format!("http://{}:{port}", addr.ip());
                if lan_ip(addr.ip()) && !addr.ip().is_loopback() && !result.contains(&address) {
                    result.push(address);
                }
            }
        }
    }
    result.push(format!("http://127.0.0.1:{port}"));
    result
}

struct RemoteState {
    session: Arc<PlaybackSession>,
    cover: Option<Arc<CoverService>>,
    lyrics: Option<Arc<LyricService>>,
    library: Option<Arc<RemoteLibrary>>,
    code: String,
    alive: Arc<AtomicBool>,
    permits: Arc<Semaphore>,
    port: u16,
}

fn router(state: Arc<RemoteState>) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async {
                (
                    [("content-type", "text/html; charset=utf-8")],
                    include_str!("../../src/remote/index.html"),
                )
            }),
        )
        .route(
            "/remote.js",
            get(|| async {
                (
                    [("content-type", "text/javascript; charset=utf-8")],
                    include_str!("../remote-dist/remote.js"),
                )
            }),
        )
        .route(
            "/remote.css",
            get(|| async {
                (
                    [("content-type", "text/css; charset=utf-8")],
                    include_str!("../remote-dist/remote.css"),
                )
            }),
        )
        .route("/api/state", get(snapshot))
        .route("/api/preview", get(preview))
        .route(
            "/api/library",
            post(library::request).layer(DefaultBodyLimit::max(192 * 1024)),
        )
        .route("/api/library-cover", get(library::cover))
        .route("/api/command", post(command))
        .route("/api/lyrics", get(lyrics))
        .route("/api/cover", get(cover))
        .layer(DefaultBodyLimit::max(2048))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(_) => false,
    }
}
fn valid_host(host: &str, port: u16) -> bool {
    host.parse::<SocketAddr>()
        .is_ok_and(|a| a.port() == port && lan_ip(a.ip()))
}
fn authorized(headers: &HeaderMap, code: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|v| {
            v.len() == code.len()
                && v.bytes()
                    .zip(code.bytes())
                    .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                    == 0
        })
}
async fn guard(State(state): State<Arc<RemoteState>>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin_ok = request
        .headers()
        .get("origin")
        .is_none_or(|o| o.to_str().is_ok_and(|o| o == format!("http://{host}")));
    let peer_ok = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| lan_ip(peer.0.ip()));
    let mut response = if !state.alive.load(Ordering::Acquire) {
        error(StatusCode::SERVICE_UNAVAILABLE, "电脑已关闭遥控")
    } else if !peer_ok || !valid_host(host, state.port) || !origin_ok {
        error(StatusCode::FORBIDDEN, "请使用电脑显示的局域网地址")
    } else if request.uri().path().starts_with("/api/")
        && !authorized(request.headers(), &state.code)
    {
        error(
            StatusCode::UNAUTHORIZED,
            "连接码无效，请在电脑上查看新的连接信息",
        )
    } else {
        next.run(request).await
    };
    for (name, value) in [
        ("cache-control", "no-store"),
        ("content-security-policy", CSP),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}
fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"message": message}))).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotQuery {
    known: Option<u64>,
}
async fn snapshot(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<SnapshotQuery>,
) -> Response {
    match tauri::async_runtime::spawn_blocking(move || state.session.snapshot_update(query.known))
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "无法读取播放状态"),
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Play {},
    Pause {},
    Next {},
    Previous {},
    Seek {
        position_ms: u64,
        generation: u64,
    },
    Volume {
        value: f32,
    },
    Muted {
        value: bool,
    },
    Mode {
        value: String,
    },
    Quality {
        value: String,
    },
    MvLyricOffset {
        id: String,
        generation: u64,
        offset_ms: i64,
    },
    PlayTrack {
        id: String,
        #[serde(default, alias = "providerId")]
        provider_id: Option<crate::multi_provider::ProviderId>,
        queue_generation: u64,
    },
}
async fn command(State(state): State<Arc<RemoteState>>, Json(command): Json<Command>) -> Response {
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "操作繁忙，请稍后重试");
    };
    if let Command::PlayTrack {
        ref id,
        provider_id,
        ..
    } = command
    {
        if let Err(err) = library::validate_remote_play_track(state.library.as_deref(), provider_id, id) {
            return (StatusCode::BAD_REQUEST, Json(err)).into_response();
        }
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if !state.alive.load(Ordering::Acquire) {
            return Err(PlaybackSessionError::Superseded);
        }
        let s = &state.session;
        match command {
            Command::Play {} => s.play().map(|value| serde_json::json!(value)),
            Command::Pause {} => s.pause().map(|value| serde_json::json!(value)),
            Command::Next {} => s.next().map(|value| serde_json::json!(value)),
            Command::Previous {} => s.previous().map(|value| serde_json::json!(value)),
            Command::Seek {
                position_ms,
                generation,
            } => s
                .seek_generation(position_ms, generation)
                .map(|value| serde_json::json!(value)),
            Command::Volume { value } if value.is_finite() && (0.0..=1.0).contains(&value) => {
                s.set_volume(value).map(|value| serde_json::json!(value))
            }
            Command::Muted { value } => s.set_muted(value).map(|value| serde_json::json!(value)),
            Command::Quality { value } => crate::playback::PlaybackQuality::parse(&value)
                .map_err(PlaybackSessionError::Playback)
                .and_then(|quality| s.change_quality(quality))
                .map(|value| serde_json::json!(value)),
            Command::MvLyricOffset {
                id,
                generation,
                offset_ms,
            } => {
                if id.contains(':')
                    || crate::multi_provider::identity::track_provider(&id)
                        != Ok(crate::multi_provider::ProviderId::Qqmusic)
                {
                    return Err(PlaybackSessionError::Playback(
                        crate::playback::PlaybackError::InvalidRequest,
                    ));
                }
                s.set_mv_lyric_offset(&id, generation, offset_ms)
                    .map(|value| serde_json::json!(value))
            }
            Command::Mode { value } => PlaybackMode::parse(&value)
                .and_then(|v| s.set_mode(v))
                .map(|value| serde_json::json!(value)),
            Command::PlayTrack {
                id,
                queue_generation,
                ..
            } if id.len() <= 128 => s
                .play_remote_track(&id, queue_generation)
                .map(|value| serde_json::json!(value)),
            _ => Err(PlaybackSessionError::InvalidMode),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(PlaybackSessionError::Superseded)) => {
            error(StatusCode::CONFLICT, "歌曲或队列已变化，请刷新后重试")
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(crate::public_session_error(e)),
        )
            .into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "播放操作未完成，请检查电脑状态",
        ),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrackQuery {
    generation: u64,
    track: String,
}

fn display_track_id(snapshot: &crate::playback_session::PlaybackSessionSnapshot) -> Option<&str> {
    snapshot
        .player
        .current_track
        .as_ref()
        .map(|t| t.id.as_str())
        .or_else(|| {
            snapshot
                .queue
                .selected_index
                .and_then(|index| snapshot.queue.items.get(index))
                .map(|t| t.id.as_str())
        })
}
async fn lyrics(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<TrackQuery>,
) -> Response {
    let snapshot = state.session.snapshot();
    if snapshot.player.generation != query.generation
        || display_track_id(&snapshot) != Some(query.track.as_str())
    {
        return error(StatusCode::CONFLICT, "歌曲已变化");
    }
    if query.track.starts_with("local_") {
        return error(StatusCode::NOT_FOUND, "本地歌曲暂不提供歌词");
    }
    let Some(lyrics) = state.lyrics.clone() else {
        return error(StatusCode::NOT_FOUND, "暂无歌词");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        lyrics.timeline(&query.track, query.generation)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => error(StatusCode::NOT_FOUND, "暂无可用歌词"),
    }
}
async fn preview(State(state): State<Arc<RemoteState>>) -> Response {
    match tauri::async_runtime::spawn_blocking(move || state.session.preview_next_track()).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "无法读取下一首"),
    }
}

async fn cover(State(state): State<Arc<RemoteState>>, Query(query): Query<TrackQuery>) -> Response {
    let snapshot = state.session.snapshot();
    if snapshot.player.generation != query.generation
        || !snapshot
            .queue
            .items
            .iter()
            .any(|item| item.id == query.track)
    {
        return error(StatusCode::CONFLICT, "歌曲已变化");
    }
    let key = snapshot
        .queue
        .items
        .iter()
        .find(|q| q.id == query.track)
        .and_then(|q| q.cover_cache_key.clone());
    let (Some(key), Some(cover)) = (key, state.cover.clone()) else {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        cover.get(&key)
    })
    .await
    {
        Ok(Ok(value)) => ([("content-type", value.mime_type)], value.bytes).into_response(),
        _ => error(StatusCode::NOT_FOUND, "暂无封面"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_requires_literal_local_address_and_matching_port() {
        for host in ["192.168.1.8:19653", "10.0.0.1:19653", "127.0.0.1:19653"] {
            assert!(valid_host(host, PORT));
        }
        for host in [
            "evil.example:19653",
            "192.168.1.8:80",
            "8.8.8.8:19653",
            "192.168.1.8",
            "0.0.0.0:19653",
        ] {
            assert!(!valid_host(host, PORT));
        }
    }
    #[test]
    fn authorization_requires_exact_bearer_secret() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "secret"));
        h.insert("authorization", HeaderValue::from_static("Bearer secret"));
        assert!(authorized(&h, "secret"));
        assert!(!authorized(&h, "secrex"));
        assert!(!authorized(&h, "secret-extra"));
    }
    #[test]
    fn command_whitelist_rejects_arbitrary_methods_and_extra_fields() {
        for body in [
            r#"{"action":"authLogout"}"#,
            r#"{"action":"play","url":"http://example.com"}"#,
            r#"{"action":"playTrack","id":"one"}"#,
        ] {
            assert!(serde_json::from_str::<Command>(body).is_err());
        }
        assert!(serde_json::from_str::<Command>(
            r#"{"action":"seek","position_ms":1000,"generation":1}"#
        )
        .is_ok());
    }
    #[test]
    fn closing_service_revokes_existing_connections() {
        let alive = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = oneshot::channel();
        drop(Running {
            status: RemoteStatus::default(),
            alive: alive.clone(),
            stop: Some(tx),
        });
        assert!(!alive.load(Ordering::Acquire));
        assert!(rx.try_recv().is_ok());
    }

    static HTTP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn http_boundary_authenticates_and_controls_the_shared_session() {
        let _lock = HTTP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        use crate::{
            playback::PlaybackController,
            player::{PlayerCommand, PlayerEngine, PlayerError, PlayerSnapshot, PlayerState},
            provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort},
            queue::QueueService,
        };
        struct NoProvider;
        struct CatalogProvider;
        impl ProviderRequestPort for CatalogProvider {
            fn request(&self, _: ProviderRequest) -> Result<ProviderReply, ProviderError> {
                Ok(ProviderReply::Success { warnings: vec![], result: serde_json::json!({
                    "page": 1, "hasMore": false,
                    "items": [{"id":"remote-song", "title":"Remote song", "subtitle":"", "artists":[{"id":"artist1","name":"Artist"}], "album":{"id":"album1","title":"Album","publishDate":""}, "durationMs":20000,
                        "qualityCandidates":[{"quality":"flac","available":false,"requiresSubscription":false},{"quality":"320k","available":true,"requiresSubscription":false},{"quality":"128k","available":true,"requiresSubscription":false}],
                        "availability":{"status":"unknown","requiresSubscription":false}}]
                }).as_object().unwrap().clone() })
            }
        }
        impl ProviderRequestPort for NoProvider {
            fn request(&self, _: ProviderRequest) -> Result<ProviderReply, ProviderError> {
                panic!("remote transport must not call provider");
            }
        }
        struct TestPlayer(PlayerSnapshot);
        impl PlayerEngine for TestPlayer {
            fn snapshot(&self) -> PlayerSnapshot {
                self.0.clone()
            }
            fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
                match command {
                    PlayerCommand::Pause => self.0.state = PlayerState::Paused,
                    PlayerCommand::SetVolume { volume } => self.0.volume = volume.get(),
                    _ => {}
                }
                Ok(())
            }
        }
        let root = std::env::temp_dir().join(format!("qmg-remote-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
        queue
            .persistence
            .record_listening(
                "stats-song",
                "Statistics song",
                "Artist",
                1000,
                true,
                crate::personal::now_ms(),
            )
            .unwrap();
        let session = Arc::new(PlaybackSession::new(
            queue.clone(),
            Arc::new(PlaybackController::new(
                Arc::new(NoProvider),
                Box::new(TestPlayer(PlayerSnapshot::idle())),
            )),
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let alive = Arc::new(AtomicBool::new(true));
        let data = Arc::new(RemoteState {
            session: session.clone(),
            cover: None,
            lyrics: None,
            library: Some(Arc::new(RemoteLibrary {
                local: Some(Arc::new(crate::local_music::LocalMusicService::new(
                    root.join("local-music"),
                ))),
                catalog: Some(Arc::new(crate::catalog::CatalogService::new(Arc::new(
                    CatalogProvider,
                )))),
                library: None,
                queue: Some(queue.clone()),
                auth: Arc::new(std::sync::RwLock::new(crate::AuthSnapshot::signed_out())),
                tracks: Mutex::new(std::collections::HashMap::new()),
                covers: Mutex::new(std::collections::HashSet::new()),
                registry: None,
                netease: None,
                bilibili: None,
                provider_tracks: Mutex::new(std::collections::HashMap::new()),
                provider_permits: default_provider_permits(),
            })),
            code: "test-only-secret".into(),
            alive: alive.clone(),
            permits: Arc::new(Semaphore::new(8)),
            port,
        });
        let (stop, stopped) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(
                listener,
                router(data).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}");
        let page = client.get(&url).send().unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.headers().contains_key("content-security-policy"));
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .send()
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("wrong")
                .send()
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("test-only-secret")
                .header("Origin", "http://evil.example")
                .send()
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("test-only-secret")
                .header("Host", format!("evil.example:{port}"))
                .send()
                .unwrap()
                .status(),
            403
        );
        let response = client
            .get(format!("{url}/api/state"))
            .bearer_auth("test-only-secret")
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        let snapshot: serde_json::Value = serde_json::from_str(&response.text().unwrap()).unwrap();
        assert!(snapshot["queue"].is_object());
        assert!(!snapshot.to_string().contains("secret"));
        let query = format!("{url}/api/state?known={}", snapshot["queue"]["generation"]);
        let delta: serde_json::Value = serde_json::from_str(
            &client
                .get(query)
                .bearer_auth("test-only-secret")
                .send()
                .unwrap()
                .text()
                .unwrap(),
        )
        .unwrap();
        assert!(delta["queue"].is_null());
        let send = |body: &str| {
            client
                .post(format!("{url}/api/command"))
                .bearer_auth("test-only-secret")
                .header("Content-Type", "application/json")
                .body(body.to_owned())
                .send()
                .unwrap()
        };
        let catalog = |body: &str| {
            client
                .post(format!("{url}/api/library"))
                .bearer_auth("test-only-secret")
                .header("Content-Type", "application/json")
                .body(body.to_owned())
                .send()
                .unwrap()
        };
        let auth = catalog(r#"{"command":"auth_status"}"#);
        assert_eq!(auth.status(), 200);
        assert_eq!(auth.text().unwrap(), r#"{"state":"signedOut"}"#);
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue","id":"unseen"}"#).status(),
            400
        );
        assert_eq!(catalog(r#"{"command":"auth_logout"}"#).status(), 422);
        assert_eq!(
            catalog(r#"{"command":"local_music_delete","trackId":"local_fake"}"#).status(),
            422
        );
        let local = catalog(r#"{"command":"local_music_list"}"#);
        assert_eq!(local.status(), 200);
        let local: serde_json::Value = serde_json::from_str(&local.text().unwrap()).unwrap();
        assert_eq!(local, serde_json::json!({"tracks":[],"warningCount":0}));
        let volume = send(r#"{"action":"volume","value":0.37}"#);
        assert_eq!(volume.status(), 200);
        let volume: serde_json::Value = serde_json::from_str(&volume.text().unwrap()).unwrap();
        assert!((volume["volume"].as_f64().unwrap() - 0.37).abs() < 0.001);
        let preview = client
            .get(format!("{url}/api/preview"))
            .bearer_auth("test-only-secret")
            .send()
            .unwrap();
        assert_eq!(preview.status(), 200);
        assert_eq!(preview.text().unwrap(), "null");
        let page = catalog(
            r#"{"command":"catalog_search_songs","keyword":"Remote","page":1,"pageSize":20,"generation":42}"#,
        );
        assert_eq!(page.status(), 200);
        let page: serde_json::Value = serde_json::from_str(&page.text().unwrap()).unwrap();
        assert_eq!(page["generation"], 42);
        assert_eq!(page["items"][0]["id"], "remote-song");
        let queued = catalog(r#"{"command":"queue_enqueue","id":"remote-song"}"#);
        assert_eq!(queued.status(), 200);
        let queued: serde_json::Value = serde_json::from_str(&queued.text().unwrap()).unwrap();
        assert_eq!(queued["items"][0]["title"], "Remote song");
        assert_eq!(session.snapshot().queue.items[0].id, "remote-song");
        let next = catalog(r#"{"command":"queue_enqueue_next","id":"remote-song"}"#);
        assert_eq!(next.status(), 200);
        assert!(next.text().unwrap().contains("Remote song"));
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_next","id":"unseen"}"#).status(),
            400
        );
        let queue_before = session.snapshot().queue;
        assert_eq!(
            catalog(r#"{"command":"queue_replace","ids":["remote-song","unseen"]}"#).status(),
            400
        );
        assert_eq!(session.snapshot().queue, queue_before);
        assert_eq!(
            catalog(r#"{"command":"queue_replace","ids":["remote-song"]}"#).status(),
            200
        );
        assert!((session.snapshot().player.volume - 0.37).abs() < 0.001);
        let before_batch = session.snapshot().queue;
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_many","ids":["remote-song","unseen"]}"#).status(),
            400
        );
        assert_eq!(session.snapshot().queue, before_batch);
        assert_eq!(
            catalog(r#"{"command":"personal_library","request":{"action":"statistics"}}"#).status(),
            200
        );
        assert_eq!(
            catalog(r#"{"command":"personal_library","request":{"action":"listeningAnalytics","startDate":"2026-01-01","endDate":"2026-12-31"}}"#).status(),
            200
        );
        assert_eq!(
            catalog(
                r#"{"command":"personal_library","request":{"action":"memoryTapes","before":null}}"#
            )
            .status(),
            200
        );
        let tape_list = queue
            .persistence
            .memory_tapes(None, crate::personal::now_ms())
            .unwrap();
        let tape_month = tape_list["items"][0]["month"].as_str().unwrap();
        let tape_detail=serde_json::json!({"command":"personal_library","request":{"action":"memoryTape","month":tape_month,"offset":0}}).to_string();
        assert_eq!(catalog(&tape_detail).status(), 200);
        let stats_before = queue.persistence.listening_report().unwrap();
        let replay=serde_json::json!({"command":"personal_library","request":{"action":"memoryTapeEnqueue","month":tape_month,"ids":["stats-song"]}}).to_string();
        assert_eq!(catalog(&replay).status(), 200);
        assert_eq!(queue.persistence.listening_report().unwrap(), stats_before);
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_many","ids":["remote-song","stats-song"]}"#)
                .status(),
            200
        );
        assert_eq!(session.snapshot().queue.items.len(), 2);
        assert_eq!(
            catalog(
                r#"{"command":"personal_library","request":{"action":"saveQueue","name":"work"}}"#
            )
            .status(),
            200
        );
        let preview = catalog(
            r#"{"command":"personal_library","request":{"action":"previewQueue","name":"work"}}"#,
        );
        assert_eq!(preview.status(), 200);
        let preview: serde_json::Value = serde_json::from_str(&preview.text().unwrap()).unwrap();
        assert_eq!(preview["items"].as_array().unwrap().len(), 2);
        assert_eq!(catalog(r#"{"command":"personal_library","request":{"action":"renameQueue","name":"work","target":"commute"}}"#).status(),200);
        assert_eq!(catalog(r#"{"command":"personal_library","request":{"action":"deleteQueue","name":"commute"}}"#).status(),200);
        assert_eq!(
            catalog(r#"{"command":"personal_library","request":{"action":"undoDeleteQueue"}}"#)
                .status(),
            200
        );
        assert_eq!(send(r#"{"action":"volume","value":2}"#).status(), 400);
        assert_eq!(
            send(r#"{"action":"seek","generation":999,"position_ms":100}"#).status(),
            409
        );
        assert_eq!(send(r#"{"action":"authLogout"}"#).status(), 422);
        assert_eq!(
            send(&format!(
                r#"{{"action":"play","extra":"{}"}}"#,
                "x".repeat(3000)
            ))
            .status(),
            413
        );
        alive.store(false, Ordering::Release);
        assert_eq!(send(r#"{"action":"volume","value":0.9}"#).status(), 503);
        assert!((session.snapshot().player.volume - 0.37).abs() < 0.001);
        let _ = stop.send(());
        drop(client);
        tauri::async_runtime::block_on(task).unwrap();
        drop(session);
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_multi_provider_stage_f_boundaries_and_regressions() {
        let _lock = HTTP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        use crate::{
            library::LibraryService,
            multi_provider::{
                bilibili::{self, BilibiliService},
                netease::{self, NeteaseService},
                protocol::Error,
                registry::ProviderRegistry,
                secrets::{Prepared, Store},
                OnlineProviderId,
            },
            playback::PlaybackController,
            player::{PlayerCommand, PlayerEngine, PlayerError, PlayerSnapshot},
            provider::{
                ProviderError, ProviderLaunch, ProviderReply, ProviderRequest, ProviderRequestPort,
            },
            queue::QueueService,
        };
        use serde_json::json;
        use std::path::Path;
        use zeroize::Zeroizing;

        #[derive(Default)]
        struct MemStore(Arc<Mutex<Option<Vec<u8>>>>);
        struct MemPending(Arc<Mutex<Option<Vec<u8>>>>, Vec<u8>);
        impl Prepared for MemPending {
            fn commit(self: Box<Self>) -> Result<(), Error> {
                *self.0.lock().unwrap() = Some(self.1);
                Ok(())
            }
        }
        impl Store for MemStore {
            fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
                Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
            }
            fn prepare(&self, b: &[u8]) -> Result<Box<dyn Prepared>, Error> {
                Ok(Box::new(MemPending(self.0.clone(), b.to_vec())))
            }
            fn delete(&self) -> Result<(), Error> {
                *self.0.lock().unwrap() = None;
                Ok(())
            }
        }

        struct QqCatalogAndLikeProvider;
        impl ProviderRequestPort for QqCatalogAndLikeProvider {
            fn request(&self, req: ProviderRequest) -> Result<ProviderReply, ProviderError> {
                match req.method() {
                    "search.songs" | "library.liked" => Ok(ProviderReply::Success {
                        warnings: vec![],
                        result: json!({
                            "page": 1,
                            "hasMore": false,
                            "items": [{
                                "id": "qq-song-1",
                                "title": "QQ Song",
                                "subtitle": "",
                                "artists": [{"id": "artist1", "name": "QQ Artist"}],
                                "album": {"id": "album1", "title": "QQ Album", "publishDate": ""},
                                "durationMs": 180000,
                                "qualityCandidates": [
                                    {"quality": "flac", "available": false, "requiresSubscription": false},
                                    {"quality": "320k", "available": true, "requiresSubscription": false},
                                    {"quality": "128k", "available": true, "requiresSubscription": false}
                                ],
                                "availability": {"status": "unknown", "requiresSubscription": false}
                            }]
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    }),
                    "song.like" | "song.unlike" => Ok(ProviderReply::Success {
                        warnings: vec![],
                        result: json!({
                            "status": "applied",
                            "affectedCount": 1
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    }),
                    _ => Err(ProviderError::Unavailable),
                }
            }
        }

        struct IdlePlayer(PlayerSnapshot);
        impl PlayerEngine for IdlePlayer {
            fn snapshot(&self) -> PlayerSnapshot {
                self.0.clone()
            }
            fn handle(&mut self, _: PlayerCommand) -> Result<(), PlayerError> {
                Ok(())
            }
        }

        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let node = repo_root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe");
        let temp_root =
            std::env::temp_dir().join(format!("qmg-remote-stage-f-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_root).unwrap();

        // 1) Verify disabled, restoring, and credential_invalid states never start a process and classify errors accurately.
        let boot_marker = temp_root.join("boot-count.txt");
        let synthetic_script = temp_root.join("synthetic-provider.mjs");
        std::fs::write(
            &synthetic_script,
            r#"
import fs from 'node:fs';
import readline from 'node:readline';
const [,, provider, mode, marker] = process.argv;
if (marker) {
  const prev = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
  fs.writeFileSync(marker, String(prev + 1));
}
const c = JSON.parse(fs.readFileSync('contracts/protocol-v2.constants.json', 'utf8'));
const methods = Object.entries(c.methods).filter(([, s]) => s.providers.includes(provider)).map(([m]) => m);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const r = JSON.parse(line);
  if (r.method === 'system.handshake') {
    process.stdout.write(JSON.stringify({ v: 2, id: r.id, ok: true, warnings: [], result: {
      protocolVersion: 2,
      provider: { id: provider, name: c.providerNames[provider], version: '0.1.0' },
      maxLineBytes: 1048576,
      capabilities: c.capabilities[provider],
      implementedMethods: methods
    }}) + '\n');
    return;
  }
  if (r.method === 'auth.credential.restore') {
    if (mode === 'credential_invalid') {
      process.stdout.write(JSON.stringify({ v: 2, id: r.id, ok: false, error: { code: 'credential_invalid', retryable: false } }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({ v: 2, id: r.id, ok: true, warnings: [], result: { account: { id: '123', displayName: 'Synthetic' } } }) + '\n');
    return;
  }
  if (r.method === 'search.songs' && mode === 'sensitive_leak') {
    process.stdout.write(JSON.stringify({ v: 2, id: r.id, ok: true, warnings: [], result: {
      page: 1, pageSize: 20, total: 1, hasMore: false,
      cookie: 'MUSIC_U=SECRET_COOKIE',
      refreshToken: 'SECRET_REFRESH',
      sessionId: 'SECRET_QR_SESSION',
      imageBase64: 'SECRET_QR_IMAGE',
      generation: 99,
      url: 'https://m801.music.126.net/SECRET.mp3',
      rawUpstream: { secret: 'RAW_UPSTREAM_SECRET' },
      items: [{ id: '1', title: 'Song', artist: 'Artist', album: 'Album', durationMs: 1000, mediaMid: '1', availability: 'unknown', url: 'https://m801.music.126.net/SECRET.mp3' }]
    }}) + '\n');
    return;
  }
  if (r.method === 'search.songs' && mode === 'slow_search') {
    if (marker) fs.writeFileSync(marker + '.inflight', '1');
    await new Promise(resolve => setTimeout(resolve, 180));
    process.stdout.write(JSON.stringify({ v: 2, id: r.id, ok: true, warnings: [], result: {
      page: 1, pageSize: 20, total: 1, hasMore: false,
      items: [{ id: '99', title: 'Late Song', artist: 'Artist', album: 'Album', durationMs: 1000, mediaMid: '99', availability: 'unknown' }]
    }}) + '\n');
    return;
  }
});
"#,
        )
        .unwrap();

        let make_reg = |id: OnlineProviderId, mode: &str, marker: &Path| {
            let mut r = match id {
                OnlineProviderId::Netease => netease::registration(repo_root, &node).unwrap(),
                OnlineProviderId::Bilibili => bilibili::registration(repo_root, &node).unwrap(),
                _ => unreachable!(),
            };
            let provider_name = match id {
                OnlineProviderId::Netease => "netease",
                OnlineProviderId::Bilibili => "bilibili",
                _ => unreachable!(),
            };
            r.launch = ProviderLaunch::new(&node)
                .unwrap()
                .args([
                    synthetic_script.as_os_str().to_os_string(),
                    provider_name.into(),
                    mode.into(),
                    marker.as_os_str().to_os_string(),
                ])
                .current_dir(repo_root)
                .unwrap();
            r
        };

        let store_ne = Arc::new(MemStore::default());
        let mut gating_reg = ProviderRegistry::default();
        gating_reg
            .register(
                make_reg(OnlineProviderId::Netease, "credential_invalid", &boot_marker),
                store_ne.clone(),
            )
            .unwrap();
        let gating_reg = Arc::new(gating_reg);
        let gating_ne = Arc::new(NeteaseService::new(gating_reg.clone()));
        let queue_gating =
            Arc::new(QueueService::open(&temp_root.join("gating.sqlite3")).unwrap());
        let session_gating = Arc::new(PlaybackSession::new(
            queue_gating.clone(),
            Arc::new(PlaybackController::new(
                Arc::new(QqCatalogAndLikeProvider),
                Box::new(IdlePlayer(PlayerSnapshot::idle())),
            )),
        ));
        let lib_gating = Arc::new(RemoteLibrary {
            catalog: None,
            library: None,
            queue: Some(queue_gating.clone()),
            local: None,
            auth: Arc::new(std::sync::RwLock::new(crate::AuthSnapshot::signed_out())),
            tracks: Mutex::new(std::collections::HashMap::new()),
            covers: Mutex::new(std::collections::HashSet::new()),
            registry: Some(gating_reg.clone()),
            netease: Some(gating_ne),
            bilibili: None,
            provider_tracks: Mutex::new(std::collections::HashMap::new()),
            provider_permits: default_provider_permits(),
        });

        // 1a) disabled state: never starts a process, returns authentication_required (not credential_invalid).
        let snap_disabled = lib_gating
            .execute(
                 library::LibraryRequest::ProviderStatus {
                    provider_id: OnlineProviderId::Netease,
                },
                &session_gating,
            )
            .unwrap();
        assert_eq!(snap_disabled["state"], "disabled");
        assert!(snap_disabled.get("error").is_none());
        assert!(!boot_marker.exists());

        let err_disabled = lib_gating
            .execute(
                library::LibraryRequest::ProviderRead {
                    provider_id: OnlineProviderId::Netease,
                    method: "search.songs".into(),
                    params: json!({"keyword": "test", "page": 1, "pageSize": 20}),
                },
                &session_gating,
            )
            .unwrap_err();
        assert_eq!(err_disabled.code, "authentication_required");
        assert!(!err_disabled.retryable);
        assert!(!boot_marker.exists());

        let err_play_disabled = library::validate_remote_play_track(
            Some(&lib_gating),
            Some( crate::multi_provider::ProviderId::Netease),
            "netease:track:1",
        )
        .unwrap_err();
        assert_eq!(err_play_disabled.code, "authentication_required");
        assert!(!boot_marker.exists());

        // 1b) restoring state: never starts a process, returns provider_unavailable (retryable), never credential_invalid.
        gating_reg
            .set_restoring_for_test(OnlineProviderId::Netease)
            .unwrap();
        let snap_restoring = lib_gating
            .execute(
                library::LibraryRequest::ProviderStatus {
                    provider_id: OnlineProviderId::Netease,
                },
                &session_gating,
            )
            .unwrap();
        assert_eq!(snap_restoring["state"], "restoring");
        assert!(!boot_marker.exists());

        let err_restoring = lib_gating
            .execute(
                library::LibraryRequest::ProviderRead {
                    provider_id: OnlineProviderId::Netease,
                    method: "search.songs".into(),
                    params: json!({"keyword": "test", "page": 1, "pageSize": 20}),
                },
                &session_gating,
            )
            .unwrap_err();
        assert_eq!(err_restoring.code, "provider_unavailable");
        assert!(err_restoring.retryable);
        assert!(!boot_marker.exists());

        let err_play_restoring = library::validate_remote_play_track(
            Some(&lib_gating),
            Some(crate::multi_provider::ProviderId::Netease),
            "netease:track:1",
        )
        .unwrap_err();
        assert_eq!(err_play_restoring.code, "provider_unavailable");
        assert!(!boot_marker.exists());

        // Reset from restoring to disabled, then trigger desktop restore that fails with credential_invalid,
        // remove boot_marker, and prove Remote requests in credential_invalid state never start a process.
        gating_reg.sign_out(OnlineProviderId::Netease).unwrap();
        *store_ne.0.lock().unwrap() = Some(
            serde_json::to_vec(&json!({
                "version": 1,
                "providerId": "netease",
                "payload": "SYNTHETIC_TEST_ONLY"
            }))
            .unwrap(),
        );
        assert!(gating_reg.restore(OnlineProviderId::Netease).is_err());
        let _ = std::fs::remove_file(&boot_marker);

        // 1c) credential_invalid state: never starts a process, returns credential_invalid.
        let snap_cred = lib_gating
            .execute(
                library::LibraryRequest::ProviderStatus {
                    provider_id: OnlineProviderId::Netease,
                },
                &session_gating,
            )
            .unwrap();
        assert_eq!(snap_cred["state"], "disabled");
        assert_eq!(snap_cred["error"], "credential_invalid");
        assert!(!boot_marker.exists());

        let err_cred = lib_gating
            .execute(
                library::LibraryRequest::ProviderRead {
                    provider_id: OnlineProviderId::Netease,
                    method: "search.songs".into(),
                    params: json!({"keyword": "test", "page": 1, "pageSize": 20}),
                },
                &session_gating,
            )
            .unwrap_err();
        assert_eq!(err_cred.code, "credential_invalid");
        assert!(!err_cred.retryable);
        assert!(!boot_marker.exists());

        let err_play_cred = library::validate_remote_play_track(
            Some(&lib_gating),
            Some(crate::multi_provider::ProviderId::Netease),
            "netease:track:1",
        )
        .unwrap_err();
        assert_eq!(err_play_cred.code, "credential_invalid");
        assert!(!boot_marker.exists());
        drop(session_gating);
        drop(queue_gating);

        // 2) Synthetic provider with sensitive fields is rejected and never leaks fields.
        let leak_marker = temp_root.join("leak-boot.txt");
        let leak_store = Arc::new(MemStore::default());
        *leak_store.0.lock().unwrap() = Some(
            serde_json::to_vec(&json!({
                "version": 1,
                "providerId": "netease",
                "payload": "SYNTHETIC_TEST_ONLY"
            }))
            .unwrap(),
        );
        let mut leak_reg = ProviderRegistry::default();
        leak_reg
            .register(
                make_reg(OnlineProviderId::Netease, "sensitive_leak", &leak_marker),
                leak_store,
            )
            .unwrap();
        assert!(leak_reg.restore(OnlineProviderId::Netease).unwrap());
        let leak_reg = Arc::new(leak_reg);
        let leak_ne = Arc::new(NeteaseService::new(leak_reg.clone()));
        let queue_leak = Arc::new(QueueService::open(&temp_root.join("leak.sqlite3")).unwrap());
        let session_leak = Arc::new(PlaybackSession::new(
            queue_leak.clone(),
            Arc::new(PlaybackController::new(
                Arc::new(QqCatalogAndLikeProvider),
                Box::new(IdlePlayer(PlayerSnapshot::idle())),
            )),
        ));
        let lib_leak = Arc::new(RemoteLibrary {
            catalog: None,
            library: None,
            queue: Some(queue_leak.clone()),
            local: None,
            auth: Arc::new(std::sync::RwLock::new(crate::AuthSnapshot::signed_out())),
            tracks: Mutex::new(std::collections::HashMap::new()),
            covers: Mutex::new(std::collections::HashSet::new()),
            registry: Some(leak_reg.clone()),
            netease: Some(leak_ne),
            bilibili: None,
            provider_tracks: Mutex::new(std::collections::HashMap::new()),
            provider_permits: default_provider_permits(),
        });
        let leak_err = lib_leak
            .execute(
                library::LibraryRequest::ProviderRead {
                    provider_id: OnlineProviderId::Netease,
                    method: "search.songs".into(),
                    params: json!({"keyword": "leak", "page": 1, "pageSize": 20}),
                },
                &session_leak,
            )
            .unwrap_err();
        let leak_json = serde_json::to_string(&leak_err).unwrap();
        for forbidden in [
            "SECRET_COOKIE",
            "SECRET_REFRESH",
            "SECRET_QR_SESSION",
            "SECRET_QR_IMAGE",
            "SECRET.mp3",
            "RAW_UPSTREAM_SECRET",
            "cookie",
            "refreshToken",
            "sessionId",
            "imageBase64",
        ] {
            assert!(!leak_json.contains(forbidden), "leaked {forbidden}");
        }
        // Also verify ensure_public_remote_payload directly rejects any synthetic object containing sensitive keys.
        for synthetic_bad in [
            json!({"cookie": "MUSIC_U=1"}),
            json!({"refreshToken": "ref"}),
            json!({"sessionId": "qr-1"}),
            json!({"imageBase64": "AA=="}),
            json!({"generation": 1}),
            json!({"url": "https://example.com/a.mp3"}),
            json!({"backupUrls": ["https://example.com/b.mp3"]}),
            json!({"rawUpstream": {"code": 200}}),
            json!({"mediaMid": "1"}),
            json!({"ownerId": "42"}),
        ] {
            assert!(library::ensure_public_remote_payload(&synthetic_bad).is_err());
        }
        leak_reg.shutdown().unwrap();
        drop(session_leak);
        drop(queue_leak);

        // 3) Late in-flight request after sign-out is rejected and never admits tracks.
        let slow_marker = temp_root.join("slow-boot.txt");
        let slow_store = Arc::new(MemStore::default());
        *slow_store.0.lock().unwrap() = Some(
            serde_json::to_vec(&json!({
                "version": 1,
                "providerId": "netease",
                "payload": "SYNTHETIC_TEST_ONLY"
            }))
            .unwrap(),
        );
        let mut slow_reg = ProviderRegistry::default();
        slow_reg
            .register(
                make_reg(OnlineProviderId::Netease, "slow_search", &slow_marker),
                slow_store,
            )
            .unwrap();
        assert!(slow_reg.restore(OnlineProviderId::Netease).unwrap());
        let slow_reg = Arc::new(slow_reg);
        let slow_ne = Arc::new(NeteaseService::new(slow_reg.clone()));
        let queue_slow = Arc::new(QueueService::open(&temp_root.join("slow.sqlite3")).unwrap());
        let session_slow = Arc::new(PlaybackSession::new(
            queue_slow.clone(),
            Arc::new(PlaybackController::new(
                Arc::new(QqCatalogAndLikeProvider),
                Box::new(IdlePlayer(PlayerSnapshot::idle())),
            )),
        ));
        let lib_slow = Arc::new(RemoteLibrary {
            catalog: None,
            library: None,
            queue: Some(queue_slow.clone()),
            local: None,
            auth: Arc::new(std::sync::RwLock::new(crate::AuthSnapshot::signed_out())),
            tracks: Mutex::new(std::collections::HashMap::new()),
            covers: Mutex::new(std::collections::HashSet::new()),
            registry: Some(slow_reg.clone()),
            netease: Some(slow_ne),
            bilibili: None,
            provider_tracks: Mutex::new(std::collections::HashMap::new()),
            provider_permits: default_provider_permits(),
        });
        let lib_slow_bg = lib_slow.clone();
        let session_slow_bg = session_slow.clone();
        let inflight = std::thread::spawn(move || {
            lib_slow_bg.execute(
                library::LibraryRequest::ProviderRead {
                    provider_id: OnlineProviderId::Netease,
                    method: "search.songs".into(),
                    params: json!({"keyword": "slow", "page": 1, "pageSize": 20}),
                },
                &session_slow_bg,
            )
        });
        let inflight_flag = temp_root.join("slow-boot.txt.inflight");
        for _ in 0..100 {
            if inflight_flag.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(inflight_flag.exists());
        slow_reg.sign_out(OnlineProviderId::Netease).unwrap();
        let late_err = inflight.join().unwrap().unwrap_err();
        assert_eq!(late_err.code, "cancelled");
        assert!(lib_slow
            .provider_tracks
            .lock()
            .unwrap()
            .get("netease:track:99")
            .is_none());
        drop(session_slow);
        drop(queue_slow);

        // 4) Full HTTP end-to-end test with NetEase + Bilibili + QQ + Local on the shared Remote router.
        let mut reg = ProviderRegistry::default();
        let mut r_ne = netease::registration(repo_root, &node).unwrap();
        r_ne.launch = ProviderLaunch::new(&node)
            .unwrap()
            .args([repo_root
                .join("providers/node/netease/tests/fixture-entry.mjs")
                .into_os_string()])
            .current_dir(repo_root)
            .unwrap();
        let mem_ne = Arc::new(MemStore::default());
        *mem_ne.0.lock().unwrap() = Some(
            serde_json::to_vec(&json!({
                "version": 1,
                "providerId": "netease",
                "payload": "SYNTHETIC_TEST_ONLY"
            }))
            .unwrap(),
        );
        reg.register(r_ne, mem_ne.clone()).unwrap();

        let mut r_bi = bilibili::registration(repo_root, &node).unwrap();
        r_bi.launch = ProviderLaunch::new(&node)
            .unwrap()
            .args([
                repo_root
                    .join("providers/node/bilibili/tests/fixture-entry.mjs")
                    .into_os_string(),
                "120".into(),
            ])
            .current_dir(repo_root)
            .unwrap();
        let mem_bi = Arc::new(MemStore::default());
        *mem_bi.0.lock().unwrap() = Some(
            serde_json::to_vec(&json!({
                "version": 1,
                "providerId": "bilibili",
                "payload": "SYNTHETIC_TEST_ONLY"
            }))
            .unwrap(),
        );
        reg.register(r_bi, mem_bi.clone()).unwrap();

        assert!(reg.restore(OnlineProviderId::Netease).unwrap());
        assert!(reg.restore(OnlineProviderId::Bilibili).unwrap());
        let reg = Arc::new(reg);
        let ne = Arc::new(NeteaseService::new(reg.clone()));
        let bi = Arc::new(BilibiliService::new(reg.clone()));

        let qq_provider = Arc::new(QqCatalogAndLikeProvider);
        let queue = Arc::new(QueueService::open(&temp_root.join("state.sqlite3")).unwrap());
        let session = Arc::new(PlaybackSession::new(
            queue.clone(),
            Arc::new(
                PlaybackController::new(
                    qq_provider.clone(),
                    Box::new(IdlePlayer(PlayerSnapshot::idle())),
                )
                .with_netease(ne.clone())
                .with_bilibili(bi.clone())
                .with_bridge_fixture(),
            ),
        ));
        let remote_lib = Arc::new(RemoteLibrary {
            local: Some(Arc::new(crate::local_music::LocalMusicService::new(
                temp_root.join("local-music"),
            ))),
            catalog: Some(Arc::new(crate::catalog::CatalogService::new(
                qq_provider.clone(),
            ))),
            library: Some(Arc::new(LibraryService::new(qq_provider))),
            queue: Some(queue.clone()),
            auth: Arc::new(std::sync::RwLock::new(
                crate::AuthSnapshot::authenticated(None),
            )),
            tracks: Mutex::new(std::collections::HashMap::new()),
            covers: Mutex::new(std::collections::HashSet::new()),
            registry: Some(reg.clone()),
            netease: Some(ne.clone()),
            bilibili: Some(bi.clone()),
            provider_tracks: Mutex::new(std::collections::HashMap::new()),
            provider_permits: default_provider_permits(),
        });

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let alive = Arc::new(AtomicBool::new(true));
        let data = Arc::new(RemoteState {
            session: session.clone(),
            cover: None,
            lyrics: None,
            library: Some(remote_lib.clone()),
            code: "stage-f-secret".into(),
            alive: alive.clone(),
            permits: Arc::new(Semaphore::new(8)),
            port,
        });
        let (stop, stopped) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(
                listener,
                router(data).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });

        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}");
        let parse_json = |res: reqwest::blocking::Response| -> serde_json::Value {
            serde_json::from_str(&res.text().unwrap()).unwrap()
        };
        let post_lib = |body: serde_json::Value| {
            client
                .post(format!("{url}/api/library"))
                .bearer_auth("stage-f-secret")
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .unwrap()
        };
        let post_cmd = |body: serde_json::Value| {
            client
                .post(format!("{url}/api/command"))
                .bearer_auth("stage-f-secret")
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .unwrap()
        };

        // Unpaired requests are rejected; paired requests can access whitelisted endpoints.
        assert_eq!(
            client
                .post(format!("{url}/api/library"))
                .header("Content-Type", "application/json")
                .body(r#"{"command":"provider_status","providerId":"netease"}"#)
                .send()
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(format!("{url}/api/command"))
                .header("Content-Type", "application/json")
                .body(r#"{"action":"play"}"#)
                .send()
                .unwrap()
                .status(),
            401
        );
        let status_ne = parse_json(post_lib(json!({
            "command": "provider_status",
            "providerId": "netease"
        })));
        assert_eq!(status_ne["providerId"], "netease");
        assert_eq!(status_ne["state"], "ready");
        assert_eq!(status_ne["account"]["id"], "123");
        assert!(status_ne.get("generation").is_none());

        // Write methods and login/auth methods are rejected on Remote.
        for forbidden_method in [
            "library.setLiked",
            "library.setSubscribed",
            "library.addItems",
            "library.removeItems",
            "library.verify",
            "library.likeIds",
            "auth.qr.start",
            "auth.qr.poll",
            "auth.qr.cancel",
            "auth.credential.restore",
            "auth.credential.check",
            "auth.logout",
            "playback.resolve",
            "lyrics.get",
        ] {
            let res = post_lib(json!({
                "command": "provider_read",
                "providerId": "netease",
                "method": forbidden_method,
                "params": {}
            }));
            assert_eq!(res.status(), 400, "method={forbidden_method}");
            let err = parse_json(res);
            assert_eq!(err["code"], "unsupported_capability");
        }

        // Legacy endpoints passed new-platform IDs (with ':') or missing providerId are rejected.
        for legacy_bad in [
            json!({"command": "library_set_liked", "songIds": ["netease:track:1"], "liked": true}),
            json!({"command": "library_set_liked", "songIds": ["bilibili:video:BV17x411w7KC:124"], "liked": true}),
            json!({"command": "catalog_song_artists", "songId": "netease:track:1"}),
            json!({"command": "catalog_playlist_songs", "playlistId": "netease:playlist:2", "editableId": null, "page": 1, "pageSize": 20, "generation": 1}),
            json!({"command": "catalog_album_detail", "albumId": "netease:album:1"}),
            json!({"command": "catalog_artist_detail", "artistId": "bilibili:uploader:1"}),
            json!({"command": "personal_library", "request": {"action": "bookmark", "kind": "album", "id": "netease:playlist:2", "title": "Playlist", "saved": true}}),
            json!({"command": "queue_enqueue", "id": "netease:track:1"}),
            json!({"command": "queue_enqueue_next", "id": "bilibili:video:BV17x411w7KC:124"}),
            json!({"command": "queue_enqueue_many", "ids": ["netease:track:1"]}),
            json!({"command": "queue_replace", "ids": ["bilibili:video:BV17x411w7KC:124"]}),
            json!({"command": "queue_enqueue", "providerId": "bilibili", "id": "BV17x411w7KC"}),
            json!({"command": "queue_enqueue", "providerId": "bilibili", "id": "bilibili:video:BV17x411w7KC"}),
            json!({"command": "queue_enqueue", "providerId": "netease", "id": "bilibili:video:BV17x411w7KC:124"}),
        ] {
            let res = post_lib(legacy_bad.clone());
            assert_eq!(res.status(), 400, "payload={legacy_bad}");
        }
        assert_eq!(
            post_cmd(json!({
                "action": "playTrack",
                "id": "netease:track:1",
                "queue_generation": 0
            }))
            .status(),
            400
        );
        assert_eq!(
            post_cmd(json!({
                "action": "playTrack",
                "providerId": "bilibili",
                "id": "BV17x411w7KC",
                "queue_generation": 0
            }))
            .status(),
            400
        );
        assert_eq!(
            post_cmd(json!({
                "action": "mvLyricOffset",
                "id": "netease:track:1",
                "generation": 0,
                "offset_ms": 100
            }))
            .status(),
            400
        );

        // Read NetEase songs, playlists, container tracks, and Bilibili videos & video parts.
        let ne_songs = parse_json(post_lib(json!({
            "command": "provider_read",
            "providerId": "netease",
            "method": "search.songs",
            "params": {"keyword": "fixture", "page": 1, "pageSize": 20}
        })));
        assert_eq!(ne_songs["items"][0]["id"], "netease:track:1");
        assert!(ne_songs["items"][0].get("mediaMid").is_none());
        assert!(ne_songs["items"][0].get("coverCacheKey").is_none());

        let ne_containers = parse_json(post_lib(json!({
            "command": "provider_read",
            "providerId": "netease",
            "method": "library.containers",
            "params": {"kind": "created", "page": 1, "pageSize": 20}
        })));
        assert_eq!(ne_containers["items"][0]["id"], "netease:playlist:2");
        assert!(ne_containers["items"][0].get("ownerId").is_none());

        let bi_videos = parse_json(post_lib(json!({
            "command": "provider_read",
            "providerId": "bilibili",
            "method": "search.videos",
            "params": {"keyword": "fixture", "page": 1, "pageSize": 20}
        })));
        assert_eq!(bi_videos["items"][0]["bvid"], "BV17x411w7KC");

        let bi_parts = parse_json(post_lib(json!({
            "command": "provider_read",
            "providerId": "bilibili",
            "method": "video.parts",
            "params": {"bvid": "BV17x411w7KC", "page": 1, "pageSize": 20}
        })));
        assert_eq!(
            bi_parts["items"][1]["id"],
            "bilibili:video:BV17x411w7KC:124"
        );
        assert_eq!(bi_parts["items"][1]["video"]["partNumber"], 2);

        // Search QQ song so it is admitted to legacy QQ tracks.
        let qq_songs = parse_json(post_lib(json!({
            "command": "catalog_search_songs",
            "keyword": "QQ",
            "page": 1,
            "pageSize": 20,
            "generation": 1
        })));
        assert_eq!(qq_songs["items"][0]["id"], "qq-song-1");

        // Enqueue QQ song (legacy without providerId), NetEase song (explicit providerId), and Bilibili part (explicit providerId).
        assert_eq!(
            post_lib(json!({
                "command": "queue_enqueue",
                "id": "qq-song-1"
            }))
            .status(),
            200
        );
        assert_eq!(
            post_lib(json!({
                "command": "queue_enqueue",
                "providerId": "netease",
                "id": "netease:track:1"
            }))
            .status(),
            200
        );
        assert_eq!(
            post_lib(json!({
                "command": "queue_enqueue_next",
                "providerId": "bilibili",
                "id": "bilibili:video:BV17x411w7KC:124"
            }))
            .status(),
            200
        );

        // Enqueueing an admitted track from an older generation is rejected with cancelled.
        remote_lib.provider_tracks.lock().unwrap().insert(
            "netease:track:99999999".into(),
            (
                0,
                crate::queue::QueueTrack {
                    video: None,
                    id: "netease:track:99999999".into(),
                    media_mid: None,
                    title: "Old Epoch Song".into(),
                    artist: "Artist".into(),
                    album: "Album".into(),
                    duration_ms: 1000,
                    cover_cache_key: None,
                },
            ),
        );
        let old_gen_res = post_lib(json!({
            "command": "queue_enqueue",
            "providerId": "netease",
            "id": "netease:track:99999999"
        }));
        assert_eq!(old_gen_res.status(), 400);
        assert_eq!(parse_json(old_gen_res)["code"], "cancelled");

        // Mixed queue snapshot echoes providerId and Bilibili video part metadata without media URLs.
        let state_res = parse_json(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("stage-f-secret")
                .send()
                .unwrap(),
        );
        let q_items = state_res["queue"]["items"].as_array().unwrap();
        assert_eq!(q_items.len(), 3);
        assert_eq!(q_items[0]["id"], "qq-song-1");
        assert_eq!(q_items[0]["providerId"], "qqmusic");
        let bi_item = q_items
            .iter()
            .find(|i| i["id"] == "bilibili:video:BV17x411w7KC:124")
            .unwrap();
        assert_eq!(bi_item["providerId"], "bilibili");
        assert_eq!(bi_item["video"]["title"], "视频原题");
        assert_eq!(bi_item["video"]["partTitle"], "第二 P 原题");
        assert_eq!(bi_item["video"]["partNumber"], 2);
        let ne_item = q_items
            .iter()
            .find(|i| i["id"] == "netease:track:1")
            .unwrap();
        assert_eq!(ne_item["providerId"], "netease");
        assert!(ne_item.get("coverCacheKey").is_none());
        assert!(!state_res.to_string().contains("https://"));

        // QQ like and local collection (personal_library) regression tests.
        let qq_like_res = post_lib(json!({
            "command": "library_set_liked",
            "songIds": ["qq-song-1"],
            "liked": true
        }));
        assert_eq!(qq_like_res.status(), 200);

        assert_eq!(
            post_lib(json!({
                "command": "personal_library",
                "request": {
                    "action": "bookmark",
                    "kind": "album",
                    "id": "album1",
                    "title": "QQ Album",
                    "saved": true
                }
            }))
            .status(),
            200
        );
        assert_eq!(
            post_lib(json!({
                "command": "personal_library",
                "request": {
                    "action": "saveQueue",
                    "name": "mixed-remote"
                }
            }))
            .status(),
            200
        );
        let preview_mixed = parse_json(post_lib(json!({
            "command": "personal_library",
            "request": {
                "action": "previewQueue",
                "name": "mixed-remote"
            }
        })));
        assert_eq!(preview_mixed["items"].as_array().unwrap().len(), 3);

        // Per-source independent rate limiting:
        // 1) Saturating NetEase per-source read permits rate-limits NetEase while Bilibili still succeeds.
        let held_ne = remote_lib
            .provider_permits
            .get(&OnlineProviderId::Netease)
            .unwrap()
            .clone()
            .try_acquire_many_owned(2)
            .unwrap();
        let ne_throttled = post_lib(json!({
            "command": "provider_read",
            "providerId": "netease",
            "method": "search.songs",
            "params": {"keyword": "fixture", "page": 1, "pageSize": 20}
        }));
        assert_eq!(ne_throttled.status(), 400);
        assert_eq!(parse_json(ne_throttled)["code"], "rate_limited");
        let bi_unaffected = post_lib(json!({
            "command": "provider_read",
            "providerId": "bilibili",
            "method": "search.videos",
            "params": {"keyword": "fixture", "page": 1, "pageSize": 20}
        }));
        assert_eq!(bi_unaffected.status(), 200);
        drop(held_ne);

        // 2) Upstream rate_limited on NetEase puts only NetEase into cooldown while Bilibili remains ready and readable.
        let ne_upstream_rl = post_lib(json!({
            "command": "provider_read",
            "providerId": "netease",
            "method": "search.songs",
            "params": {"keyword": "rate-limit", "page": 1, "pageSize": 20}
        }));
        assert_eq!(ne_upstream_rl.status(), 400);
        assert_eq!(parse_json(ne_upstream_rl)["code"], "rate_limited");
        let bi_still_ok = post_lib(json!({
            "command": "provider_read",
            "providerId": "bilibili",
            "method": "video.parts",
            "params": {"bvid": "BV17x411w7KC", "page": 1, "pageSize": 20}
        }));
        assert_eq!(bi_still_ok.status(), 200);

        let _ = stop.send(());
        drop(client);
        tauri::async_runtime::block_on(task).unwrap();
        reg.shutdown().unwrap();
        slow_reg.shutdown().unwrap();
        gating_reg.shutdown().unwrap();
        drop(remote_lib);
        drop(lib_slow);
        drop(lib_gating);
        drop(reg);
        drop(slow_reg);
        drop(gating_reg);
        drop(session);
        drop(queue);
        let _ = std::fs::remove_dir_all(temp_root);
    }
}
