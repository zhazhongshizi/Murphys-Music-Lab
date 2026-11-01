use super::*;
use crate::{
    catalog::{CatalogService, CatalogSongPage},
    library::LibraryService,
    queue::{QueueService, QueueTrack},
};
use std::{collections::HashMap, sync::RwLock};

pub(crate) struct RemoteLibrary {
    pub catalog: Option<Arc<CatalogService>>,
    pub library: Option<Arc<LibraryService>>,
    pub queue: Option<Arc<QueueService>>,
    pub local: Option<Arc<crate::local_music::LocalMusicService>>,
    pub auth: Arc<RwLock<crate::AuthSnapshot>>,
    pub tracks: Mutex<HashMap<String, QueueTrack>>,
    pub covers: Mutex<std::collections::HashSet<(String, String)>>,
    pub registry: Option<Arc<crate::multi_provider::registry::ProviderRegistry>>,
    pub netease: Option<Arc<crate::multi_provider::netease::NeteaseService>>,
    pub bilibili: Option<Arc<crate::multi_provider::bilibili::BilibiliService>>,
    pub provider_tracks: Mutex<HashMap<String, (u64, QueueTrack)>>,
    pub provider_permits: HashMap<crate::multi_provider::OnlineProviderId, Arc<Semaphore>>,
}

pub(crate) fn default_provider_permits(
) -> HashMap<crate::multi_provider::OnlineProviderId, Arc<Semaphore>> {
    HashMap::from([
        (
            crate::multi_provider::OnlineProviderId::Netease,
            Arc::new(Semaphore::new(2)),
        ),
        (
            crate::multi_provider::OnlineProviderId::Bilibili,
            Arc::new(Semaphore::new(2)),
        ),
    ])
}

#[derive(Deserialize)]
#[serde(tag = "command", deny_unknown_fields)]
pub(crate) enum LibraryRequest {
    #[serde(rename = "personal_library")]
    Personal {
        request: crate::personal::PersonalRequest,
    },
    #[serde(rename = "auth_status")]
    Auth {},
    #[serde(rename = "provider_status", rename_all = "camelCase")]
    ProviderStatus {
        provider_id: crate::multi_provider::OnlineProviderId,
    },
    #[serde(rename = "provider_read", rename_all = "camelCase")]
    ProviderRead {
        provider_id: crate::multi_provider::OnlineProviderId,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    #[serde(rename = "radar_start")]
    RadarStart {},
    #[serde(rename = "catalog_discover_new_songs")]
    Discover { area: u8, generation: u64 },
    #[serde(rename = "catalog_search_suggestions")]
    Suggestions { keyword: String, generation: u64 },
    #[serde(rename = "catalog_recommend_songs")]
    RecommendSongs {
        kind: crate::catalog::RecommendationKind,
        page: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_recommend_playlists", rename_all = "camelCase")]
    RecommendPlaylists {
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_search_songs", rename_all = "camelCase")]
    Search {
        keyword: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "library_liked_songs", rename_all = "camelCase")]
    Liked {
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "library_set_liked", rename_all = "camelCase")]
    SetLiked { song_ids: Vec<String>, liked: bool },
    #[serde(rename = "queue_enqueue", rename_all = "camelCase")]
    Enqueue {
        id: String,
        #[serde(default)]
        provider_id: Option<crate::multi_provider::ProviderId>,
    },
    #[serde(rename = "queue_enqueue_next", rename_all = "camelCase")]
    EnqueueNext {
        id: String,
        #[serde(default)]
        provider_id: Option<crate::multi_provider::ProviderId>,
    },
    #[serde(rename = "queue_enqueue_many", rename_all = "camelCase")]
    EnqueueMany {
        ids: Vec<String>,
        #[serde(default)]
        provider_id: Option<crate::multi_provider::ProviderId>,
    },
    #[serde(rename = "queue_replace", rename_all = "camelCase")]
    Replace {
        ids: Vec<String>,
        #[serde(default)]
        provider_id: Option<crate::multi_provider::ProviderId>,
    },
    #[serde(rename = "library_playlists", rename_all = "camelCase")]
    Playlists {
        kind: crate::library::PlaylistKind,
        page: u32,
        page_size: u32,
    },
    #[serde(rename = "catalog_playlist_songs", rename_all = "camelCase")]
    PlaylistSongs {
        playlist_id: String,
        editable_id: Option<String>,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_search_entities", rename_all = "camelCase")]
    SearchEntities {
        kind: crate::catalog::CatalogSearchKind,
        keyword: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_album_detail", rename_all = "camelCase")]
    AlbumDetail { album_id: String },
    #[serde(rename = "catalog_album_songs", rename_all = "camelCase")]
    AlbumSongs {
        album_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_artist_detail", rename_all = "camelCase")]
    ArtistDetail { artist_id: String },
    #[serde(rename = "catalog_song_artists", rename_all = "camelCase")]
    SongArtists { song_id: String },
    #[serde(rename = "catalog_artist_songs", rename_all = "camelCase")]
    ArtistSongs {
        artist_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_artist_albums", rename_all = "camelCase")]
    ArtistAlbums {
        artist_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "local_music_list")]
    Local {},
}

fn remote_write_allowed(command: &LibraryRequest) -> bool {
    match command {
        LibraryRequest::SetLiked { song_ids, .. } => song_ids.iter().all(|id| {
            crate::multi_provider::identity::track_provider(id)
                == Ok(crate::multi_provider::ProviderId::Qqmusic)
        }),
        _ => true,
    }
}

pub(crate) fn valid_remote_queue_id(
    provider_id: Option<crate::multi_provider::ProviderId>,
    id: &str,
) -> bool {
    use crate::multi_provider::{
        identity::{track_provider, TrackRef},
        ProviderId,
    };
    match provider_id {
        None => {
            !id.contains(':')
                && matches!(
                    track_provider(id),
                    Ok(ProviderId::Qqmusic | ProviderId::Local)
                )
        }
        Some(provider) => TrackRef::new(provider, id.to_string()).is_ok(),
    }
}

fn legacy_id_rejected(command: &LibraryRequest) -> bool {
    match command {
        LibraryRequest::SetLiked { song_ids, .. } => song_ids.iter().any(|id| {
            crate::multi_provider::identity::track_provider(id)
                != Ok(crate::multi_provider::ProviderId::Qqmusic)
        }),
        LibraryRequest::SongArtists { song_id } => {
            song_id.contains(':')
                || crate::multi_provider::identity::track_provider(song_id)
                    != Ok(crate::multi_provider::ProviderId::Qqmusic)
        }
        LibraryRequest::PlaylistSongs {
            playlist_id,
            editable_id,
            ..
        } => {
            playlist_id.contains(':')
                || editable_id.as_deref().is_some_and(|id| id.contains(':'))
        }
        LibraryRequest::AlbumDetail { album_id }
        | LibraryRequest::AlbumSongs { album_id, .. } => album_id.contains(':'),
        LibraryRequest::ArtistDetail { artist_id }
        | LibraryRequest::ArtistSongs { artist_id, .. }
        | LibraryRequest::ArtistAlbums { artist_id, .. } => artist_id.contains(':'),
        LibraryRequest::Personal {
            request:
                crate::personal::PersonalRequest::Bookmark { id, .. }
                | crate::personal::PersonalRequest::PinBookmark { id, .. },
        } => id.contains(':'),
        LibraryRequest::Enqueue { id, provider_id }
        | LibraryRequest::EnqueueNext { id, provider_id } => {
            !valid_remote_queue_id(*provider_id, id)
        }
        LibraryRequest::EnqueueMany { ids, provider_id }
        | LibraryRequest::Replace { ids, provider_id } => {
            ids.iter().any(|id| !valid_remote_queue_id(*provider_id, id))
        }
        _ => false,
    }
}

pub(crate) fn remote_provider_read_allowed(
    provider_id: crate::multi_provider::OnlineProviderId,
    method: &str,
) -> bool {
    match provider_id {
        crate::multi_provider::OnlineProviderId::Netease => matches!(
            method,
            "search.songs"
                | "search.playlists"
                | "song.detail"
                | "library.containers"
                | "library.container"
                | "library.tracks"
                | "library.likes"
        ),
        crate::multi_provider::OnlineProviderId::Bilibili => matches!(
            method,
            "search.videos"
                | "video.resolve"
                | "video.parts"
                | "library.containers"
                | "library.container"
                | "library.videos"
        ),
        crate::multi_provider::OnlineProviderId::Qqmusic => false,
    }
}

fn ensure_provider_capability(
    provider_id: crate::multi_provider::OnlineProviderId,
    method: &str,
    capabilities: &crate::multi_provider::ProviderCapabilities,
) -> Result<(), crate::PublicError> {
    use crate::multi_provider::{LibraryKind, OnlineProviderId, SearchKind};
    let allowed = match (provider_id, method) {
        (OnlineProviderId::Netease, "search.songs") => {
            capabilities.search_kinds.contains(&SearchKind::Songs)
        }
        (OnlineProviderId::Netease, "search.playlists") => {
            capabilities.search_kinds.contains(&SearchKind::Playlists)
        }
        (OnlineProviderId::Netease, "song.detail") => true,
        (OnlineProviderId::Netease, "library.likes") => {
            capabilities.library_kinds.contains(&LibraryKind::Likes)
        }
        (
            OnlineProviderId::Netease,
            "library.containers" | "library.container" | "library.tracks",
        ) => capabilities
            .library_kinds
            .iter()
            .any(|k| matches!(k, LibraryKind::Created | LibraryKind::Favorite)),
        (
            OnlineProviderId::Bilibili,
            "search.videos" | "video.resolve" | "video.parts",
        ) => capabilities.search_kinds.contains(&SearchKind::Videos),
        (
            OnlineProviderId::Bilibili,
            "library.containers" | "library.container" | "library.videos",
        ) => capabilities
            .library_kinds
            .iter()
            .any(|k| matches!(k, LibraryKind::Created | LibraryKind::Favorite)),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(crate::PublicError::provider(
            "unsupported_capability",
            false,
            "当前来源不支持此读取能力",
        ))
    }
}

pub(crate) fn map_provider_error(
    err: crate::multi_provider::protocol::Error,
) -> crate::PublicError {
    use crate::multi_provider::{protocol::Error, ErrorCode};
    match err {
        Error::Upstream(code) => match code {
            ErrorCode::InvalidParams => {
                crate::PublicError::provider("invalid_params", false, "请求参数无效")
            }
            ErrorCode::AuthenticationRequired => {
                crate::PublicError::provider("authentication_required", false, "请在桌面端登录")
            }
            ErrorCode::CredentialInvalid => crate::PublicError::provider(
                "credential_invalid",
                false,
                "登录状态已失效，请在桌面端重新扫码登录",
            ),
            ErrorCode::VerificationRequired => crate::PublicError::provider(
                "verification_required",
                false,
                "平台要求风险验证，请在桌面端处理后重试",
            ),
            ErrorCode::VerificationFailed => crate::PublicError::provider(
                "verification_failed",
                false,
                "写后核对未通过，请在桌面端确认",
            ),
            ErrorCode::RateLimited => crate::PublicError::provider(
                "rate_limited",
                true,
                "当前来源请求过于频繁，请稍后重试",
            ),
            ErrorCode::EntitlementDenied => crate::PublicError::provider(
                "entitlement_denied",
                false,
                "当前账号没有此内容的访问权限",
            ),
            ErrorCode::PreviewOnly => {
                crate::PublicError::provider("preview_only", false, "当前内容仅提供试听片段")
            }
            ErrorCode::MediaUnavailable => {
                crate::PublicError::provider("media_unavailable", false, "当前内容暂不可用")
            }
            ErrorCode::UnsupportedMedia => {
                crate::PublicError::provider("unsupported_media", false, "不支持当前媒体格式")
            }
            ErrorCode::UnsupportedCapability => {
                crate::PublicError::provider("unsupported_capability", false, "远端不支持此操作")
            }
            ErrorCode::OutcomeUnknown => crate::PublicError::provider(
                "outcome_unknown",
                false,
                "操作结果待核对，未自动重复提交",
            ),
            ErrorCode::Cancelled => crate::PublicError::provider(
                "cancelled",
                false,
                "来源会话已变化，旧代次请求已取消",
            ),
            ErrorCode::NetworkUnavailable => crate::PublicError::provider(
                "network_unavailable",
                true,
                "网络连接不可用，请稍后重试",
            ),
            ErrorCode::ProviderUnavailable => crate::PublicError::provider(
                "provider_unavailable",
                true,
                "来源服务暂不可用，请稍后重试",
            ),
            ErrorCode::UpstreamSchemaChanged => crate::PublicError::provider(
                "upstream_schema_changed",
                false,
                "上游返回格式已变化",
            ),
            ErrorCode::InternalError => crate::PublicError::provider(
                "internal_error",
                false,
                "来源内部处理异常",
            ),
        },
        Error::Cooldown => crate::PublicError::provider(
            "rate_limited",
            true,
            "当前来源请求过于频繁，请稍后重试",
        ),
        Error::Cancelled | Error::Stale => crate::PublicError::provider(
            "cancelled",
            false,
            "来源会话已变化，旧代次请求已取消",
        ),
        Error::Schema | Error::Frame | Error::Handshake => crate::PublicError::provider(
            "upstream_schema_changed",
            false,
            "来源返回格式无效",
        ),
        Error::Timeout
        | Error::Unavailable
        | Error::Storage
        | Error::Context => crate::PublicError::provider(
            "provider_unavailable",
            true,
            "来源正在恢复或暂不可用，请稍后重试",
        ),
    }
}

pub(crate) fn ensure_public_remote_payload(
    value: &serde_json::Value,
) -> Result<(), crate::PublicError> {
    const FORBIDDEN_KEYS: &[&str] = &[
        "cookie",
        "cookies",
        "credential",
        "payload",
        "refreshToken",
        "ac_time_value",
        "SESSDATA",
        "bili_jct",
        "MUSIC_U",
        "sessionId",
        "imageBase64",
        "pollAfterMs",
        "expiresAtMs",
        "generation",
        "url",
        "backupUrls",
        "headers",
        "dash",
        "mediaMid",
        "ownerId",
        "rawUpstream",
        "upstream",
    ];
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if FORBIDDEN_KEYS.contains(&k.as_str()) {
                    return Err(crate::PublicError::provider(
                        "upstream_schema_changed",
                        false,
                        "返回字段不在公开白名单内",
                    ));
                }
                ensure_public_remote_payload(v)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => {
            for item in items {
                ensure_public_remote_payload(item)?;
            }
            Ok(())
        }
        serde_json::Value::String(s) => {
            if s.contains("http://")
                || s.contains("https://")
                || s.contains("SESSDATA=")
                || s.contains("MUSIC_U=")
                || s.contains("SYNTHETIC_TEST_ONLY")
            {
                return Err(crate::PublicError::provider(
                    "upstream_schema_changed",
                    false,
                    "返回内容包含受限字段",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(super) fn validate_remote_play_track(
    library: Option<&RemoteLibrary>,
    provider_id: Option<crate::multi_provider::ProviderId>,
    id: &str,
) -> Result<(), crate::PublicError> {
    use crate::multi_provider::{identity::track_provider, OnlineProviderId, ProviderId};
    if id.len() > 128 || !valid_remote_queue_id(provider_id, id) {
        return Err(crate::PublicError::provider(
            "invalid_request",
            false,
            "点播只接受有效规范可播放 ID 并须匹配来源",
        ));
    }
    match track_provider(id) {
        Ok(ProviderId::Netease) => {
            let lib = library.ok_or_else(|| {
                crate::PublicError::provider("provider_unavailable", true, "远端曲库尚未就绪")
            })?;
            let registry = lib.registry.as_ref().ok_or_else(|| {
                crate::PublicError::provider("provider_unavailable", true, "来源注册表尚未就绪")
            })?;
            registry
                .remote_ready(OnlineProviderId::Netease)
                .map(|_| ())
                .map_err(map_provider_error)
        }
        Ok(ProviderId::Bilibili) => {
            let lib = library.ok_or_else(|| {
                crate::PublicError::provider("provider_unavailable", true, "远端曲库尚未就绪")
            })?;
            let registry = lib.registry.as_ref().ok_or_else(|| {
                crate::PublicError::provider("provider_unavailable", true, "来源注册表尚未就绪")
            })?;
            registry
                .remote_ready(OnlineProviderId::Bilibili)
                .map(|_| ())
                .map_err(map_provider_error)
        }
        Ok(ProviderId::Qqmusic | ProviderId::Local) => Ok(()),
        Err(_) => Err(crate::PublicError::provider(
            "invalid_request",
            false,
            "无效的可播放曲目 ID",
        )),
    }
}

impl RemoteLibrary {
    fn remember_cover(&self, kind: &str, key: &str) {
        let mut covers = self
            .covers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if covers.len() >= 10000 {
            covers.clear();
        }
        covers.insert((kind.to_owned(), key.to_owned()));
    }
    fn remember_entities(&self, page: &crate::catalog::CatalogEntityPage) {
        for item in &page.items {
            match item {
                crate::catalog::CatalogEntity::Artist(a) => {
                    if let Some(key) = &a.avatar_cache_key {
                        self.remember_cover("artist", key);
                    }
                }
                crate::catalog::CatalogEntity::Album(a) => {
                    if let Some(key) = &a.cover_cache_key {
                        self.remember_cover("album", key);
                    }
                }
                crate::catalog::CatalogEntity::Playlist(playlist) => {
                    if let Some(key) = &playlist.cover_cache_key {
                        self.remember_cover("playlist", key);
                    }
                }
            }
        }
    }
    fn remember(&self, page: &CatalogSongPage) {
        let mut tracks = self
            .tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if tracks.len() + page.items.len() > 10000 {
            tracks.clear();
        }
        for item in &page.items {
            tracks.insert(
                item.id.clone(),
                QueueTrack {
                    video: None,
                    id: item.id.clone(),
                    media_mid: item.media_mid.clone(),
                    title: item.title.clone(),
                    artist: item.artist.clone(),
                    album: item.album.clone(),
                    duration_ms: item.duration_ms,
                    cover_cache_key: item.cover_cache_key.clone(),
                },
            );
        }
    }
    fn remember_provider_tracks(
        &self,
        provider_id: crate::multi_provider::OnlineProviderId,
        generation: u64,
        method: &str,
        value: &serde_json::Value,
    ) -> Result<(), crate::PublicError> {
        let mut parsed = Vec::new();
        match (provider_id, method) {
            (
                crate::multi_provider::OnlineProviderId::Netease,
                "search.songs" | "library.tracks" | "library.likes",
            ) => {
                if let Some(items) = value["items"].as_array() {
                    for item in items {
                        let track =
                            crate::multi_provider::netease::queue_track_from_provider_track(item)
                                .map_err(map_provider_error)?;
                        parsed.push(track);
                    }
                }
            }
            (crate::multi_provider::OnlineProviderId::Netease, "song.detail") => {
                let track = crate::multi_provider::netease::queue_track_from_provider_track(value)
                    .map_err(map_provider_error)?;
                parsed.push(track);
            }
            (crate::multi_provider::OnlineProviderId::Bilibili, "video.parts") => {
                if let Some(items) = value["items"].as_array() {
                    for item in items {
                        let track =
                            crate::multi_provider::bilibili::queue_track_from_provider_track(item)
                                .map_err(map_provider_error)?;
                        parsed.push(track);
                    }
                }
            }
            _ => {}
        }
        if !parsed.is_empty() {
            let mut store = self
                .provider_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if store.len() + parsed.len() > 10000 {
                store.clear();
            }
            for track in parsed {
                store.insert(track.id.clone(), (generation, track));
            }
        }
        Ok(())
    }
    fn resolve_queue_item(
        &self,
        provider_id: Option<crate::multi_provider::ProviderId>,
        id: &str,
    ) -> Result<QueueTrack, crate::PublicError> {
        use crate::multi_provider::{
            identity::{track_provider, TrackRef},
            OnlineProviderId, ProviderId,
        };
        if !valid_remote_queue_id(provider_id, id) {
            return Err(crate::PublicError::provider(
                "invalid_request",
                false,
                "曲目 ID 或来源标识无效",
            ));
        }
        let actual = track_provider(id).map_err(|_| {
            crate::PublicError::provider("invalid_request", false, "曲目 ID 格式无效")
        })?;
        if let Some(expected) = provider_id {
            TrackRef::new(expected, id.to_string()).map_err(|_| {
                crate::PublicError::provider("invalid_request", false, "曲目 ID 与来源不匹配")
            })?;
        }
        match actual {
            ProviderId::Netease | ProviderId::Bilibili => {
                let online = if actual == ProviderId::Netease {
                    OnlineProviderId::Netease
                } else {
                    OnlineProviderId::Bilibili
                };
                let registry = self.registry.as_ref().ok_or_else(|| {
                    crate::PublicError::provider(
                        "provider_unavailable",
                        true,
                        "来源注册表尚未就绪",
                    )
                })?;
                let (current_gen, _) =
                    registry.remote_ready(online).map_err(map_provider_error)?;
                let (admitted_gen, track) = self
                    .provider_tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(id)
                    .cloned()
                    .ok_or_else(|| {
                        crate::PublicError::provider(
                            "invalid_request",
                            false,
                            "请先从当前来源曲库加载该曲目",
                        )
                    })?;
                if admitted_gen != current_gen {
                    return Err(crate::PublicError::provider(
                        "cancelled",
                        false,
                        "来源会话已变化，旧代次曲目不可入队",
                    ));
                }
                Ok(track)
            }
            ProviderId::Qqmusic | ProviderId::Local => self
                .tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(id)
                .cloned()
                .ok_or_else(crate::provider_unavailable),
        }
    }
    pub(crate) fn execute(
        &self,
        command: LibraryRequest,
        session: &PlaybackSession,
    ) -> Result<serde_json::Value, crate::PublicError> {
        if !remote_write_allowed(&command) || legacy_id_rejected(&command) {
            return Err(crate::public_library_error(
                crate::library::LibraryError::InvalidRequest,
            ));
        }
        let page = match command {
            LibraryRequest::ProviderStatus { provider_id } => {
                if !matches!(
                    provider_id,
                    crate::multi_provider::OnlineProviderId::Netease
                        | crate::multi_provider::OnlineProviderId::Bilibili
                ) {
                    return Err(crate::PublicError::provider(
                        "invalid_request",
                        false,
                        "新来源状态查询仅支持 netease 或 bilibili",
                    ));
                }
                let registry = self.registry.as_ref().ok_or_else(|| {
                    crate::PublicError::provider(
                        "provider_unavailable",
                        true,
                        "来源注册表尚未就绪",
                    )
                })?;
                let snapshot = registry
                    .snapshot(provider_id)
                    .map_err(map_provider_error)?;
                let value = serde_json::to_value(snapshot).map_err(|_| {
                    crate::PublicError::provider(
                        "provider_unavailable",
                        true,
                        "无法序列化来源状态",
                    )
                })?;
                ensure_public_remote_payload(&value)?;
                return Ok(value);
            }
            LibraryRequest::ProviderRead {
                provider_id,
                method,
                params,
            } => {
                if !matches!(
                    provider_id,
                    crate::multi_provider::OnlineProviderId::Netease
                        | crate::multi_provider::OnlineProviderId::Bilibili
                ) {
                    return Err(crate::PublicError::provider(
                        "invalid_request",
                        false,
                        "新来源读取仅支持 netease 或 bilibili",
                    ));
                }
                if !remote_provider_read_allowed(provider_id, &method) {
                    return Err(crate::PublicError::provider(
                        "unsupported_capability",
                        false,
                        "远端仅开放新来源只读浏览与搜索",
                    ));
                }
                let _provider_permit = self
                    .provider_permits
                    .get(&provider_id)
                    .ok_or_else(|| {
                        crate::PublicError::provider(
                            "provider_unavailable",
                            true,
                            "来源读取调度尚未就绪",
                        )
                    })?
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| {
                        crate::PublicError::provider(
                            "rate_limited",
                            true,
                            "当前来源请求过于频繁，请稍后重试",
                        )
                    })?;
                let registry = self.registry.as_ref().ok_or_else(|| {
                    crate::PublicError::provider(
                        "provider_unavailable",
                        true,
                        "来源注册表尚未就绪",
                    )
                })?;
                let (pre_gen, capabilities) = registry
                    .remote_ready(provider_id)
                    .map_err(map_provider_error)?;
                ensure_provider_capability(provider_id, &method, &capabilities)?;
                let read_res = match provider_id {
                    crate::multi_provider::OnlineProviderId::Netease => self
                        .netease
                        .as_ref()
                        .ok_or_else(|| {
                            map_provider_error(crate::multi_provider::protocol::Error::Unavailable)
                        })?
                        .read(&method, params),
                    crate::multi_provider::OnlineProviderId::Bilibili => self
                        .bilibili
                        .as_ref()
                        .ok_or_else(|| {
                            map_provider_error(crate::multi_provider::protocol::Error::Unavailable)
                        })?
                        .read(&method, params),
                    crate::multi_provider::OnlineProviderId::Qqmusic => {
                        Err(crate::multi_provider::protocol::Error::Context)
                    }
                };
                if let Err(crate::multi_provider::protocol::Error::Upstream(code)) = read_res {
                    return Err(map_provider_error(
                        crate::multi_provider::protocol::Error::Upstream(code),
                    ));
                }
                let (post_gen, _) = registry.remote_ready(provider_id).map_err(|_| {
                    crate::PublicError::provider(
                        "cancelled",
                        false,
                        "来源会话已变化，旧代次请求已取消",
                    )
                })?;
                if post_gen != pre_gen {
                    return Err(crate::PublicError::provider(
                        "cancelled",
                        false,
                        "来源会话已变化，旧代次请求已取消",
                    ));
                }
                let value = read_res.map_err(map_provider_error)?;
                ensure_public_remote_payload(&value)?;
                self.remember_provider_tracks(provider_id, pre_gen, &method, &value)?;
                return Ok(value);
            }
            LibraryRequest::RadarStart {} => {
                let catalog = self
                    .catalog
                    .clone()
                    .ok_or_else(crate::provider_unavailable)?;
                let result = session
                    .start_radar(catalog)
                    .map_err(crate::public_radar_error)?;
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::Personal { request } => {
                let value = session
                    .personal_library(request)
                    .map_err(crate::public_session_error)?;
                // Only server-owned metadata is admitted to the remote playback allowlist.
                for field in ["items", "events", "forgotten"] {
                    if let Some(rows) = value[field].as_array() {
                        let mut tracks = self
                            .tracks
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        for row in rows {
                            if let (Some(id), Some(title), Some(artist)) = (
                                row["id"].as_str(),
                                row["title"].as_str(),
                                row["artist"].as_str(),
                            ) {
                                tracks.entry(id.to_owned()).or_insert_with(|| QueueTrack {
                                    video: None,
                                    id: id.into(),
                                    title: title.into(),
                                    artist: artist.into(),
                                    album: String::new(),
                                    duration_ms: 0,
                                    media_mid: None,
                                    cover_cache_key: None,
                                });
                            }
                        }
                    }
                }
                {
                    let mut tracks = self
                        .tracks
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    for item in session.snapshot().queue.items {
                        tracks.insert(item.id.clone(), item);
                    }
                }
                if let Some(rows) = value["bookmarks"].as_array() {
                    for row in rows {
                        if let (Some(kind), Some(key)) =
                            (row["kind"].as_str(), row["coverCacheKey"].as_str())
                        {
                            self.remember_cover(kind, key);
                        }
                    }
                }
                return Ok(value);
            }
            LibraryRequest::SongArtists { song_id } => {
                let artists = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .song_artists(&song_id)
                    .map_err(crate::public_catalog_error)?;
                return Ok(serde_json::json!(artists));
            }
            LibraryRequest::Suggestions {
                keyword,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .search_suggestions(&keyword, generation)
                    .map_err(crate::public_catalog_error)?;
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::RecommendPlaylists {
                page,
                page_size,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .recommend_playlists(page, page_size, generation)
                    .map_err(crate::public_catalog_error)?;
                self.remember_entities(&result);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::SearchEntities {
                kind,
                keyword,
                page,
                page_size,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .search_entities(kind, &keyword, page, page_size, generation)
                    .map_err(crate::public_catalog_error)?;
                self.remember_entities(&result);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::ArtistAlbums {
                artist_id,
                page,
                page_size,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .artist_albums(&artist_id, page, page_size, generation)
                    .map_err(crate::public_catalog_error)?;
                self.remember_entities(&result);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::AlbumDetail { album_id } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .album_detail(&album_id)
                    .map_err(crate::public_catalog_error)?;
                if let Some(key) = &result.cover_cache_key {
                    self.remember_cover("album", key);
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::ArtistDetail { artist_id } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .artist_detail(&artist_id)
                    .map_err(crate::public_catalog_error)?;
                if let Some(key) = result.as_ref().and_then(|a| a.avatar_cache_key.as_ref()) {
                    self.remember_cover("artist", key);
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::AlbumSongs {
                album_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .album_songs(&album_id, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::ArtistSongs {
                artist_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .artist_songs(&artist_id, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Playlists {
                kind,
                page,
                page_size,
            } => {
                return self
                    .library
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .playlists(kind, page, page_size)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_library_error)
            }
            LibraryRequest::PlaylistSongs {
                playlist_id,
                editable_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .playlist_songs(
                    &playlist_id,
                    editable_id.as_deref(),
                    page,
                    page_size,
                    generation,
                )
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Local {} => {
                let result = self
                    .local
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .list()
                    .map_err(crate::public_local_music_error)?;
                let mut tracks = self
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if tracks.len() + result.tracks.len() > 10000 {
                    tracks.clear();
                }
                for item in &result.tracks {
                    tracks.insert(
                        item.id.clone(),
                        QueueTrack {
                            video: None,
                            id: item.id.clone(),
                            title: item.title.clone(),
                            artist: item.artist.clone(),
                            album: item.album.clone(),
                            duration_ms: item.duration_ms,
                            media_mid: None,
                            cover_cache_key: item.cover_cache_key.clone(),
                        },
                    );
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::Replace {
                ref ids,
                provider_id,
            }
            | LibraryRequest::EnqueueMany {
                ref ids,
                provider_id,
            } => {
                if ids.is_empty() || ids.len() > 1000 {
                    return Err(crate::public_queue_error(
                        crate::queue::QueueError::LimitExceeded,
                    ));
                }
                let items = ids
                    .iter()
                    .map(|id| self.resolve_queue_item(provider_id, id))
                    .collect::<Result<Vec<_>, _>>()?;
                if matches!(command, LibraryRequest::EnqueueMany { .. }) {
                    return self
                        .queue
                        .as_ref()
                        .ok_or_else(crate::provider_unavailable)?
                        .enqueue_many(items)
                        .map(|value| serde_json::json!(value))
                        .map_err(crate::public_queue_error);
                }
                return session
                    .replace_queue(items)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_session_error);
            }
            LibraryRequest::Auth {} => {
                return Ok(
                    serde_json::json!({"state": self.auth.read().unwrap_or_else(std::sync::PoisonError::into_inner).state}),
                )
            }
            LibraryRequest::Discover { area, generation } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .discover_new_songs(area, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::RecommendSongs {
                kind,
                page,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .recommend_songs(kind, page, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Search {
                keyword,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .search_songs(&keyword, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Liked {
                page,
                page_size,
                generation,
            } => self
                .library
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .liked_songs(page, page_size, generation)
                .map_err(crate::public_library_error)?,
            LibraryRequest::SetLiked { song_ids, liked } => {
                let epoch = session.shuffle_likes_epoch();
                let result = self
                    .library
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .set_liked_checked(&song_ids, liked)
                    .map_err(crate::public_library_error)?;
                session.update_shuffle_likes(&song_ids, liked, epoch);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::Enqueue {
                ref id,
                provider_id,
            }
            | LibraryRequest::EnqueueNext {
                ref id,
                provider_id,
            } => {
                let item = self.resolve_queue_item(provider_id, id)?;
                if matches!(command, LibraryRequest::EnqueueNext { .. }) {
                    return session
                        .enqueue_next(item)
                        .map(|value| serde_json::json!(value))
                        .map_err(crate::public_session_error);
                }
                return self
                    .queue
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .enqueue(item)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_queue_error);
            }
        };
        self.remember(&page);
        Ok(serde_json::json!(page))
    }
}

pub(super) async fn request(
    State(state): State<Arc<RemoteState>>,
    Json(command): Json<LibraryRequest>,
) -> Response {
    let Some(library) = state.library.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "曲库尚未就绪");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "曲库繁忙，请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if !state.alive.load(Ordering::Acquire) {
            return Err(crate::provider_unavailable());
        }
        library.execute(command, &state.session)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(value)) => (StatusCode::BAD_REQUEST, Json(value)).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "曲库请求未完成"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoverQuery {
    key: String,
    kind: Option<String>,
}
pub(super) async fn cover(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<CoverQuery>,
) -> Response {
    let kind = query.kind.as_deref().unwrap_or("album");
    if !matches!(kind, "album" | "artist" | "playlist") {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    }
    let allowed = state.library.as_ref().is_some_and(|library| {
        library
            .covers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&(kind.to_owned(), query.key.clone()))
            || (kind == "album"
                && library
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .values()
                    .any(|track| track.cover_cache_key.as_deref() == Some(query.key.as_str())))
    });
    if !allowed {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    }
    let Some(cover) = state.cover.clone() else {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    };
    let local = state
        .library
        .as_ref()
        .and_then(|library| library.local.clone());
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if query.key.starts_with("local_") && matches!(query.kind.as_deref(), None | Some("album"))
        {
            return local
                .ok_or(crate::cover::CoverError::CoverUnavailable)?
                .embedded_cover(&query.key)
                .map_err(|_| crate::cover::CoverError::CoverUnavailable);
        }
        match query.kind.as_deref() {
            Some("artist") => cover.get_artist(&query.key),
            Some("playlist") => cover.get_playlist(&query.key),
            _ => cover.get(&query.key),
        }
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
    fn remote_rejects_provider_writes_and_new_ids_before_any_business_call() {
        for command in [
            "provider_write",
            "provider_verify_write",
            "provider_likes",
            "provider_login",
            "provider_poll",
            "provider_cancel",
            "provider_restore",
            "provider_check",
            "provider_logout",
        ] {
            assert!(serde_json::from_value::<LibraryRequest>(serde_json::json!({
                "command": command,
                "request": {}
            }))
            .is_err());
        }
        for id in ["netease:track:1", "bilibili:video:BV17x411w7KC:123"] {
            let op = LibraryRequest::SetLiked {
                song_ids: vec![id.into()],
                liked: true,
            };
            assert!(!remote_write_allowed(&op));
            assert!(legacy_id_rejected(&op));
        }
        assert!(remote_write_allowed(&LibraryRequest::SetLiked {
            song_ids: vec!["songA".into()],
            liked: true
        }));
    }
    #[test]
    fn only_scoped_catalog_requests_are_accepted() {
        assert!(serde_json::from_str::<LibraryRequest>(
            r#"{"command":"catalog_search_songs","keyword":"test","page":1,"pageSize":20,"generation":1}"#
        )
        .is_ok());
        for value in [
            r#"{"command":"radar_start"}"#,
            r#"{"command":"catalog_search_suggestions","keyword":"test","generation":1}"#,
            r#"{"command":"catalog_recommend_songs","kind":"radar","page":2,"generation":1}"#,
            r#"{"command":"catalog_recommend_playlists","page":2,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_search_entities","kind":"albums","keyword":"test","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_album_detail","albumId":"album-1"}"#,
            r#"{"command":"catalog_album_songs","albumId":"album-1","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_artist_detail","artistId":"artist-1"}"#,
            r#"{"command":"catalog_song_artists","songId":"song-mid-1"}"#,
            r#"{"command":"catalog_artist_albums","artistId":"artist-1","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"provider_status","providerId":"netease"}"#,
            r#"{"command":"provider_read","providerId":"bilibili","method":"video.parts","params":{"bvid":"BV17x411w7KC"}}"#,
        ] {
            assert!(serde_json::from_str::<LibraryRequest>(value).is_ok());
        }
        for value in [
            r#"{"command":"radar_start","url":"SENTINEL"}"#,
            r#"{"command":"local_music_catalog","request":{"action":"status"}}"#,
            r#"{"command":"local_music_catalog","request":{"action":"remove","id":"x"}}"#,
            r#"{"command":"catalog_search_entities","kind":"downloads","keyword":"test","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_album_detail","albumId":"album-1","url":"SENTINEL"}"#,
            r#"{"command":"auth_logout"}"#,
            r#"{"command":"library_delete_playlist","editableId":"123"}"#,
            r#"{"command":"queue_enqueue","id":"test","url":"http://example.com"}"#,
            r#"{"command":"provider_status"}"#,
            r#"{"command":"provider_read","method":"search.songs"}"#,
        ] {
            assert!(serde_json::from_str::<LibraryRequest>(value).is_err());
        }
    }
}
