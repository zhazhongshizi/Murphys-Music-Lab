//! Platform contracts and 3a host lifecycle, strict v2 IPC, and credential ownership.
pub mod bilibili;
pub mod client;
#[cfg(test)]
mod compatibility;
pub mod identity;
pub mod lifecycle;
pub mod media_bridge;
pub mod netease;
#[cfg(feature = "manual-spikes")]
pub mod media_probe;
pub mod protocol;
pub mod qq;
pub mod registry;
pub mod secrets;
pub mod writes;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Qqmusic,
    Netease,
    Bilibili,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnlineProviderId {
    Qqmusic,
    Netease,
    Bilibili,
}

impl From<OnlineProviderId> for ProviderId {
    fn from(id: OnlineProviderId) -> Self {
        match id {
            OnlineProviderId::Qqmusic => Self::Qqmusic,
            OnlineProviderId::Netease => Self::Netease,
            OnlineProviderId::Bilibili => Self::Bilibili,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountRef {
    pub provider_id: OnlineProviderId,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccount {
    pub provider_id: OnlineProviderId,
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidParams,
    UnsupportedCapability,
    AuthenticationRequired,
    CredentialInvalid,
    NetworkUnavailable,
    RateLimited,
    EntitlementDenied,
    PreviewOnly,
    MediaUnavailable,
    UnsupportedMedia,
    UpstreamSchemaChanged,
    ProviderUnavailable,
    OutcomeUnknown,
    VerificationFailed,
    VerificationRequired,
    Cancelled,
    InternalError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCapabilities {
    pub login_methods: Vec<LoginMethod>,
    pub search_kinds: Vec<SearchKind>,
    pub library_kinds: Vec<LibraryKind>,
    pub write_actions: Vec<WriteAction>,
    pub lyrics: bool,
    pub qualities: Vec<Quality>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginMethod {
    Qr,
    Qq,
    Wx,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchKind {
    Songs,
    Artists,
    Albums,
    Playlists,
    Videos,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    Created,
    Favorite,
    Likes,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Quality {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "flac")]
    Flac,
    #[serde(rename = "320k")]
    Kbps320,
    #[serde(rename = "128k")]
    Kbps128,
    #[serde(rename = "aac")]
    Aac,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteAction {
    #[serde(rename = "playlist.create")]
    CreatePlaylist,
    #[serde(rename = "playlist.delete")]
    DeletePlaylist,
    #[serde(rename = "song.like")]
    Like,
    #[serde(rename = "song.unlike")]
    Unlike,
    #[serde(rename = "playlist.subscribe")]
    Subscribe,
    #[serde(rename = "playlist.unsubscribe")]
    Unsubscribe,
    #[serde(rename = "playlist.addTracks")]
    AddTracks,
    #[serde(rename = "playlist.removeTracks")]
    RemoveTracks,
    #[serde(rename = "favorite.addVideos")]
    AddVideos,
    #[serde(rename = "favorite.removeVideos")]
    RemoveVideos,
}

impl ProviderCapabilities {
    pub fn qqmusic() -> Self {
        Self {
            login_methods: vec![LoginMethod::Qq, LoginMethod::Wx],
            search_kinds: vec![
                SearchKind::Songs,
                SearchKind::Artists,
                SearchKind::Albums,
                SearchKind::Playlists,
            ],
            library_kinds: vec![
                LibraryKind::Created,
                LibraryKind::Favorite,
                LibraryKind::Likes,
            ],
            write_actions: vec![
                WriteAction::CreatePlaylist,
                WriteAction::DeletePlaylist,
                WriteAction::Like,
                WriteAction::Unlike,
                WriteAction::Subscribe,
                WriteAction::Unsubscribe,
                WriteAction::AddTracks,
                WriteAction::RemoveTracks,
            ],
            lyrics: true,
            qualities: vec![Quality::Flac, Quality::Kbps320, Quality::Kbps128],
        }
    }
    /// Static supported features. `ready` still gates every business operation.
    pub fn netease() -> Self {
        Self {
            login_methods: vec![LoginMethod::Qr],
            search_kinds: vec![SearchKind::Songs, SearchKind::Playlists],
            library_kinds: vec![
                LibraryKind::Created,
                LibraryKind::Favorite,
                LibraryKind::Likes,
            ],
            write_actions: vec![
                WriteAction::Like,
                WriteAction::Unlike,
                WriteAction::Subscribe,
                WriteAction::Unsubscribe,
                WriteAction::AddTracks,
                WriteAction::RemoveTracks,
            ],
            lyrics: true,
            qualities: vec![
                Quality::Auto,
                Quality::Flac,
                Quality::Kbps320,
                Quality::Kbps128,
            ],
        }
    }
    pub fn bilibili() -> Self {
        Self {
            login_methods: vec![LoginMethod::Qr],
            search_kinds: vec![SearchKind::Videos],
            library_kinds: vec![LibraryKind::Created, LibraryKind::Favorite],
            write_actions: vec![WriteAction::AddVideos, WriteAction::RemoveVideos],
            lyrics: false,
            qualities: vec![Quality::Auto, Quality::Aac],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_and_errors_match_frozen_contracts() {
        let constants: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/protocol-v2.constants.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(ProviderCapabilities::netease()).unwrap(),
            constants["capabilities"]["netease"]
        );
        assert_eq!(
            serde_json::to_value(ProviderCapabilities::bilibili()).unwrap(),
            constants["capabilities"]["bilibili"]
        );
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/protocol-v2.schema.json"))
                .unwrap();
        for code in schema["$defs"]["errorCode"]["enum"].as_array().unwrap() {
            let error: ErrorCode = serde_json::from_value(code.clone()).unwrap();
            assert_eq!(serde_json::to_value(error).unwrap(), *code);
        }
        assert!(serde_json::from_str::<ErrorCode>("\"raw_upstream_error\"").is_err());
        assert!(serde_json::from_value::<ProviderAccount>(serde_json::json!({
            "providerId": "netease", "id": "123", "displayName": "Fixture", "cookie": "SYNTHETIC"
        })).is_err());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoPartMetadata {
    pub title: String,
    pub part_title: String,
    pub part_number: u32,
}
impl VideoPartMetadata {
    pub fn validate_for(id: &str, video: Option<&Self>) -> bool {
        match (identity::track_provider(id), video) {
            (Ok(ProviderId::Bilibili), Some(v)) => {
                let valid = |s: &str| !s.is_empty() && s.len() <= 512 && !s.contains(['\r', '\n', '\0']);
                valid(&v.title) && valid(&v.part_title) && (1..=10000).contains(&v.part_number)
            }
            (Ok(ProviderId::Bilibili) | Err(_), _) => false,
            (_, None) => true,
            _ => false,
        }
    }
}
