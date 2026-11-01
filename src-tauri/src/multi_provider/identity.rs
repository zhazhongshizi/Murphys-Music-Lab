use super::ProviderId;
use serde::{Deserialize, Serialize};

/// Add derived source at public projections; never rewrite stored IDs or SQL.
pub(crate) fn public_track(mut v: serde_json::Value) -> serde_json::Value {
    let id = v["id"].as_str().unwrap_or("").to_owned();
    let source = track_provider(&id).ok();
    let o = v.as_object_mut().unwrap();
    o.retain(|_, v| !v.is_null());
    if let Some(p) = source {
        o.insert("providerId".into(), serde_json::to_value(p).unwrap());
        if p == ProviderId::Bilibili {
            o.entry("coverCacheKey").or_insert_with(|| serde_json::Value::String(format!("bili_{}", id.split(':').nth(2).unwrap())));
        }
    }
    v
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRef {
    provider_id: ProviderId,
    id: String,
}

impl TrackRef {
    pub fn new(provider_id: ProviderId, id: String) -> Result<Self, InvalidIdentity> {
        if track_provider(&id)? != provider_id {
            return Err(InvalidIdentity);
        }
        Ok(Self { provider_id, id })
    }
    pub fn from_legacy_id(id: String) -> Result<Self, InvalidIdentity> {
        Self::new(track_provider(&id)?, id)
    }
    pub fn provider_id(&self) -> ProviderId {
        self.provider_id
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn netease(song_id: &str) -> Result<Self, InvalidIdentity> {
        Self::new(ProviderId::Netease, format!("netease:track:{song_id}"))
    }
    pub fn bilibili(bvid: &str, cid: &str) -> Result<Self, InvalidIdentity> {
        Self::new(ProviderId::Bilibili, format!("bilibili:video:{bvid}:{cid}"))
    }
}

// New public requests require providerId. Only from_legacy_id may infer it.
impl<'de> Deserialize<'de> for TrackRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            provider_id: ProviderId,
            id: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.provider_id, wire.id)
            .map_err(|_| serde::de::Error::custom("invalid_track_identity"))
    }
}

fn decimal(value: &str) -> bool {
    (1..=20).contains(&value.len())
        && !value.starts_with('0')
        && value.bytes().all(|b| b.is_ascii_digit())
}
fn bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value.as_bytes()[2..]
            .iter()
            .all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(b))
}
pub fn track_provider(id: &str) -> Result<ProviderId, InvalidIdentity> {
    if id.is_empty() || id.len() > 128 {
        return Err(InvalidIdentity);
    }
    if id.starts_with("local_") {
        let parts: Vec<_> = id.split('_').collect();
        return if parts.len() == 3
            && parts[1].len() == 64
            && parts[1]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && matches!(parts[2], "mp3" | "flac" | "ogg")
        {
            Ok(ProviderId::Local)
        } else {
            Err(InvalidIdentity)
        };
    }
    let parts: Vec<_> = id.split(':').collect();
    match parts.as_slice() {
        ["netease", "track", song_id] if decimal(song_id) => Ok(ProviderId::Netease),
        ["bilibili", "video", video_id, cid] if bvid(video_id) && decimal(cid) => {
            Ok(ProviderId::Bilibili)
        }
        [_] if id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) =>
        {
            Ok(ProviderId::Qqmusic)
        }
        _ => Err(InvalidIdentity),
    }
}
pub fn container_provider(id: &str) -> Result<ProviderId, InvalidIdentity> {
    let parts: Vec<_> = id.split(':').collect();
    match parts.as_slice() {
        ["netease", "playlist", value] if decimal(value) => Ok(ProviderId::Netease),
        ["bilibili", "favorite", value] if decimal(value) => Ok(ProviderId::Bilibili),
        _ => Err(InvalidIdentity),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn old_bilibili_queue_items_get_the_same_video_cover_without_rewriting_storage() {
        let raw = serde_json::json!({"id":"bilibili:video:BV17x411w7KC:123","coverCacheKey":null});
        let public = public_track(raw.clone());
        assert_eq!(public["coverCacheKey"], "bili_BV17x411w7KC");
        assert!(raw["coverCacheKey"].is_null());
        assert!(public_track(serde_json::json!({"id":"qq-song"})).get("coverCacheKey").is_none());
    }
    #[test]
    fn shared_identity_vectors_and_public_boundary() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-v2/identities.json"
        ))
        .unwrap();
        for case in fixture["tracks"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let expected: Option<ProviderId> =
                serde_json::from_value(case["providerId"].clone()).unwrap();
            assert_eq!(track_provider(id).ok(), expected, "{id}");
            if let Some(provider) = expected {
                let reference = TrackRef::from_legacy_id(id.into()).unwrap();
                assert_eq!(reference.id(), id);
                assert_eq!(
                    serde_json::to_value(&reference).unwrap(),
                    serde_json::json!({"id": id, "providerId": provider})
                );
                let wrong = if provider == ProviderId::Qqmusic {
                    ProviderId::Bilibili
                } else {
                    ProviderId::Qqmusic
                };
                assert!(TrackRef::new(wrong, id.into()).is_err());
            }
        }
        for case in fixture["containers"].as_array().unwrap() {
            let expected: Option<ProviderId> =
                serde_json::from_value(case["providerId"].clone()).unwrap();
            assert_eq!(
                container_provider(case["id"].as_str().unwrap()).ok(),
                expected
            );
        }
        assert!(serde_json::from_value::<TrackRef>(serde_json::json!({"id":"123"})).is_err());
        assert!(serde_json::from_value::<TrackRef>(
            serde_json::json!({"id":"123","providerId":"netease"})
        )
        .is_err());
    }
    #[test]
    fn cross_source_and_part_identity_preserves_distinctions() {
        let qq = TrackRef::from_legacy_id("123".into()).unwrap();
        let netease = TrackRef::netease("123").unwrap();
        let p1 = TrackRef::bilibili("BV17x411w7KC", "123").unwrap();
        let p2 = TrackRef::bilibili("BV17x411w7KC", "124").unwrap();
        let ids: std::collections::HashSet<_> = [&qq, &netease, &p1, &p2]
            .into_iter()
            .map(TrackRef::id)
            .collect();
        assert_eq!(ids.len(), 4);
    }
}
