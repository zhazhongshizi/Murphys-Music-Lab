//! Bilibili production read boundary. Video summaries are never queue tracks.
use super::{client::Registration, identity, protocol::Error, registry::ProviderRegistry, OnlineProviderId, ProviderCapabilities, ProviderId, VideoPartMetadata};
use crate::provider::ProviderLaunch;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::{Arc, Mutex}};

pub const METHODS: &[&str] = &["system.handshake", "system.ping", "auth.qr.start", "auth.qr.poll", "auth.qr.cancel", "auth.credential.restore", "auth.credential.check", "auth.logout", "search.videos", "video.resolve", "video.parts", "library.containers", "library.videos", "playback.resolve", "library.container", "library.verify", "library.addItems", "library.removeItems"];
pub fn registration(root: &Path, node: &Path) -> Result<Registration, Error> {
    let bytes = std::fs::read(node).map_err(|_| Error::Unavailable)?;
    if format!("{:x}", Sha256::digest(bytes)) != "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9" { return Err(Error::Unavailable); }
    let main = root.join("providers/node/bilibili/main.mjs");
    if !main.is_file() || !root.join("providers/node/bilibili/node_modules/ajv/package.json").is_file() { return Err(Error::Unavailable); }
    let profile = ProviderCapabilities::bilibili();
    Registration::with_profile(OnlineProviderId::Bilibili, "0.1.0".into(), METHODS.iter().map(|m| m.to_string()).collect(),
        ProviderLaunch::new(node).map_err(|_| Error::Unavailable)?.args([main.as_os_str()]).current_dir(root).map_err(|_| Error::Unavailable)?, profile)
}
pub struct BilibiliService {
    pub registry: Arc<ProviderRegistry>,
    covers: Mutex<BTreeMap<String, (u64, String)>>,
}
impl BilibiliService {
    pub fn new(registry: Arc<ProviderRegistry>) -> Self { Self { registry, covers: Mutex::new(BTreeMap::new()) } }
    pub fn ready_generation(&self) -> Result<u64, Error> { self.registry.ready_generation(OnlineProviderId::Bilibili) }
    /// Private metadata lookup for a cover cache miss. Never expose its URL over IPC.
    pub fn cover_url(&self, bvid: &str) -> Result<String, Error> {
        identity::TrackRef::bilibili(bvid, "1").map_err(|_| Error::Context)?;
        let generation = self.ready_generation()?;
        if let Some((epoch, url)) = self.covers.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(bvid).cloned() {
            if epoch == generation { return Ok(url); }
        }
        let response = self.registry.request(OnlineProviderId::Bilibili, generation, "video.resolve", json!({"input":bvid}))?;
        if response["ok"] != true || response["result"]["bvid"] != bvid { return Err(Error::Schema); }
        self.remember_covers(generation, &response["result"]);
        response["result"]["coverUrl"].as_str().map(str::to_owned).ok_or(Error::Schema)
    }
    fn remember_covers(&self, generation: u64, result: &Value) {
        let rows: Vec<&Value> = result["items"].as_array().map(|rows| rows.iter().collect()).unwrap_or_else(|| vec![result]);
        let mut covers = self.covers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for row in rows {
            if let (Some(bvid), Some(url)) = (row["bvid"].as_str().or_else(|| row["ref"]["bvid"].as_str()), row["coverUrl"].as_str()) {
                if covers.len() >= 2048 && !covers.contains_key(bvid) { covers.pop_first(); }
                covers.insert(bvid.to_owned(), (generation, url.to_owned()));
            }
        }
    }
    pub fn read(&self, method: &str, mut params: Value) -> Result<Value, Error> {
        if !["search.videos", "video.resolve", "video.parts", "library.containers", "library.videos", "library.container"].contains(&method) { return Err(Error::Context); }
        let generation = self.ready_generation()?;
        if let Some(c) = params.get_mut("containerId") {
            let s = c.as_str().ok_or(Error::Schema)?;
            if identity::container_provider(s) != Ok(ProviderId::Bilibili) { return Err(Error::Context); }
            *c = Value::String(s.strip_prefix("bilibili:favorite:").ok_or(Error::Context)?.into());
        }
        let mut response = self.registry.request(OnlineProviderId::Bilibili, generation, method, params)?;
        if response["ok"] != true {
            return Err(Error::Upstream(serde_json::from_value(response["error"]["code"].clone()).map_err(|_| Error::Schema)?));
        }
        let v = response["result"].take();
        self.remember_covers(generation, &v);
        if method == "library.container" { return public_container(&v); }
        if method == "video.resolve" { return public_video(&v); }
        let items: Result<Vec<_>, _> = v["items"].as_array().ok_or(Error::Schema)?.iter().map(|x| match method {
            "video.parts" => public_track(x), "library.containers" => public_container(x), _ => public_video(x),
        }).collect();
        Ok(json!({"page":v["page"],"hasMore":v["hasMore"],"total":v["total"],"items":items?}))
    }
}
pub fn raw_part(id: &str) -> Result<(&str, &str), Error> {
    if identity::track_provider(id) != Ok(ProviderId::Bilibili) { return Err(Error::Context); }
    id.strip_prefix("bilibili:video:").and_then(|v| v.split_once(':')).ok_or(Error::Context)
}
fn public_video(v: &Value) -> Result<Value, Error> {
    // Private schema is validated by Registry; never project coverUrl or other
    // upstream fields into the renderer. No source URL persists here.
    let bvid = v["bvid"].as_str().ok_or(Error::Schema)?;
    identity::TrackRef::bilibili(bvid, "1").map_err(|_| Error::Schema)?;
    Ok(json!({"providerId":"bilibili","bvid":v["bvid"],"aid":v["aid"],"title":v["title"],"uploader":v["uploader"],"durationMs":v["durationMs"],"availability":v["availability"],"coverCacheKey":format!("bili_{bvid}")}))
}
pub fn public_track(v: &Value) -> Result<Value, Error> {
    let reference = identity::TrackRef::bilibili(v["ref"]["bvid"].as_str().ok_or(Error::Schema)?, v["ref"]["cid"].as_str().ok_or(Error::Schema)?).map_err(|_| Error::Schema)?;
    let track = json!({"providerId":"bilibili","id":reference.id(),"title":v["title"],"artist":v["artist"],"creatorKind":"uploader","album":v["album"],"durationMs":v["durationMs"],"availability":v["availability"],"video":v["video"],"coverCacheKey":format!("bili_{}",v["ref"]["bvid"].as_str().ok_or(Error::Schema)?)});
    queue_track_from_provider_track(&track)?;
    Ok(track)
}
pub fn queue_track_from_provider_track(v: &Value) -> Result<crate::queue::QueueTrack, Error> {
    let mut o = v.as_object().ok_or(Error::Schema)?.clone();
    if o.keys().any(|k| !["providerId","id","title","artist","creatorKind","album","durationMs","availability","video","coverCacheKey"].contains(&k.as_str()))
        || v["providerId"] != "bilibili" || v["creatorKind"] != "uploader"
        || !matches!(v["availability"].as_str(), Some("unknown"|"unavailable"|"authenticationRequired"|"deleted"|"permissionDenied"|"processing"|"noAudio")) { return Err(Error::Schema); }
    let metadata: VideoPartMetadata = serde_json::from_value(v["video"].clone()).map_err(|_| Error::Schema)?;
    if !VideoPartMetadata::validate_for(v["id"].as_str().ok_or(Error::Schema)?, Some(&metadata)) { return Err(Error::Schema); }
    o.remove("creatorKind"); o.remove("availability");
    let track = serde_json::from_value(Value::Object(o)).map_err(|_| Error::Schema)?;
    crate::queue::validate_items(std::slice::from_ref(&track)).map_err(|_| Error::Schema)?;
    Ok(track)
}
fn public_container(v: &Value) -> Result<Value, Error> {
    let id = format!("bilibili:favorite:{}", v["id"].as_str().ok_or(Error::Schema)?);
    if identity::container_provider(&id) != Ok(ProviderId::Bilibili) { return Err(Error::Schema); }
    Ok(json!({"providerId":"bilibili","id":id,"kind":"favoriteFolder","ownership":v["ownership"],"owner":{"providerId":"bilibili","id":v["ownerId"]},"title":v["title"],"description":v["description"],"itemCount":v["itemCount"],"allowedActions":v["allowedActions"]}))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use super::super::secrets::{Prepared, Store};
    use std::sync::Mutex;
    use zeroize::Zeroizing;
    #[derive(Default)]
    struct Memory(Arc<Mutex<Option<Vec<u8>>>>);
    struct Pending(Arc<Mutex<Option<Vec<u8>>>>, Vec<u8>);
    impl Prepared for Pending { fn commit(self: Box<Self>) -> Result<(), Error> { *self.0.lock().unwrap() = Some(self.1); Ok(()) } }
    impl Store for Memory {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> { Ok(self.0.lock().unwrap().clone().map(Zeroizing::new)) }
        fn prepare(&self, b: &[u8]) -> Result<Box<dyn Prepared>, Error> { Ok(Box::new(Pending(self.0.clone(), b.to_vec()))) }
        fn delete(&self) -> Result<(), Error> { *self.0.lock().unwrap() = None; Ok(()) }
    }
    pub(crate) fn service() -> Arc<BilibiliService> {
        service_with_expiry(0)
    }
    pub(crate) fn service_with_expiry(seconds: u64) -> Arc<BilibiliService> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let node = root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe");
        let mut r = registration(root, &node).unwrap();
        r.launch = ProviderLaunch::new(&node).unwrap().args([root.join("providers/node/bilibili/tests/fixture-entry.mjs").into_os_string(), seconds.to_string().into()]).current_dir(root).unwrap();
        let memory = Arc::new(Memory::default());
        *memory.0.lock().unwrap() = Some(serde_json::to_vec(&json!({"version":1,"providerId":"bilibili","payload":"SYNTHETIC_TEST_ONLY"})).unwrap());
        let mut registry = ProviderRegistry::default(); registry.register(r, memory).unwrap();
        assert!(registry.restore(OnlineProviderId::Bilibili).unwrap());
        Arc::new(BilibiliService::new(Arc::new(registry)))
    }
    pub(crate) fn tracks(b: &BilibiliService) -> Vec<crate::queue::QueueTrack> {
        let page = b.read("video.parts", json!({"bvid":"BV17x411w7KC","page":1,"pageSize":20})).unwrap();
        page["items"].as_array().unwrap().iter().map(|t| queue_track_from_provider_track(t).unwrap()).collect()
    }
    #[test]
    fn production_handshake_and_host_read_parts_are_strict_and_public() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let r = registration(root, &root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe")).unwrap();
        let (c, _) = super::super::client::Client::start(r).unwrap();
        assert_eq!(c.request("system.ping", json!({})).unwrap()["result"]["alive"], true); c.stop();
        let b = service();
        let search = b.read("search.videos", json!({"keyword":"fixture","page":1,"pageSize":20})).unwrap();
        assert_eq!(search["items"][0]["title"], "原题 & 文本");
        assert!(queue_track_from_provider_track(&search["items"][0]).is_err());
        let ts = tracks(&b); assert_eq!(ts.len(), 2); assert_ne!(ts[0].id, ts[1].id);
        assert_eq!(search["items"][0]["coverCacheKey"], "bili_BV17x411w7KC");
        assert_eq!(ts[0].cover_cache_key.as_deref(), Some("bili_BV17x411w7KC"));
        assert_eq!(ts[0].cover_cache_key, ts[1].cover_cache_key);
        assert_eq!(b.cover_url("BV17x411w7KC").unwrap(), "https://i0.hdslb.com/bfs/archive/synthetic-cover.jpg");
        assert_eq!(ts[1].video.as_ref().unwrap().part_number, 2);
        for kind in ["created", "favorite"] {
            let folders = b.read("library.containers", json!({"kind":kind,"page":1,"pageSize":20})).unwrap();
            assert_eq!(folders["items"][0]["owner"]["providerId"], "bilibili");
            assert_eq!(folders["items"][0]["allowedActions"], json!([]));
        }
        let videos = b.read("library.videos", json!({"containerId":"bilibili:favorite:7","page":1,"pageSize":20})).unwrap();
        assert_eq!(videos["items"][1]["availability"], "deleted");
        assert!(!videos.to_string().contains("SESSDATA")); assert!(!videos.to_string().contains("https://"));
        assert!(b.read("library.addItems", json!({})).is_err());
        assert!(b.read("playback.resolve", json!({})).is_err());
        assert!(b.read("library.videos", json!({"containerId":"netease:playlist:7","page":1,"pageSize":20})).is_err());
        b.registry.sign_out(OnlineProviderId::Bilibili).unwrap();
        assert!(b.read("video.parts", json!({"bvid":"BV17x411w7KC"})).is_err());
    }
    #[test]
    fn bilibili_lyrics_are_normal_empty_and_never_request_other_platforms() {
        struct Reject;
        impl crate::provider::ProviderRequestPort for Reject {
            fn request(&self, _: crate::provider::ProviderRequest) -> Result<crate::provider::ProviderReply, crate::provider::ProviderError> { panic!("Bilibili must not request QQ lyrics") }
        }
        let lyrics = crate::lyrics::LyricService::new(Arc::new(Reject));
        assert!(lyrics.lines("bilibili:video:BV17x411w7KC:124").unwrap().is_empty());
    }
    #[test]
    fn confirmed_negative_check_retires_only_bilibili_account_generation() {
        let b=service(); let n=crate::multi_provider::netease::tests::service();
        b.read("search.videos",json!({"keyword":"invalidate-check","page":1,"pageSize":20})).unwrap();
        let g=b.ready_generation().unwrap();
        let r=b.registry.request(OnlineProviderId::Bilibili,g,"auth.credential.check",json!({})).unwrap();
        assert_eq!(r["result"]["valid"],false);assert!(b.ready_generation().is_err());assert!(n.ready_generation().is_ok());
        assert!(b.registry.request(OnlineProviderId::Bilibili,g,"system.ping",json!({})).is_err());
    }
    #[test]
    fn schema11_migration_retains_parts_queue_history_collections_resume_and_old_ids() {
        use crate::{persistence::LOCAL_SCHEMA_VERSION, queue::{QueueTrack, QueueService}, personal::StoredQueue};
        let root = std::env::temp_dir().join(format!("bilibili-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap(); let path = root.join("state.sqlite3");
        let legacy: StoredQueue = serde_json::from_str(include_str!("../../../tests/fixtures/provider-v2/legacy-storage.json")).unwrap();
        let q = QueueService::open(&path).unwrap(); q.replace(legacy.items.clone()).unwrap(); drop(q);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("ALTER TABLE queue_items DROP COLUMN video_json; ALTER TABLE playback_history DROP COLUMN video_json; DROP TABLE video_part_metadata; PRAGMA user_version=11;").unwrap();
        conn.backup("main", root.join("schema11-before.sqlite3"), None).unwrap(); drop(conn);
        assert_eq!(crate::migration_guard::prepare(&path, false), Err(crate::migration_guard::MigrationError::Declined));
        let approved_backup = crate::migration_guard::prepare(&path, true).unwrap().unwrap();
        assert_eq!(crate::migration_guard::existing_version(&approved_backup), Ok(Some(11)));
        let q = QueueService::open(&path).unwrap(); assert_eq!(q.snapshot().items, legacy.items);
        assert_eq!(q.persistence.schema_version().unwrap(), LOCAL_SCHEMA_VERSION);
        let b = service(); let parts = tracks(&b);
        let mut mixed = legacy.items.clone(); mixed.extend(parts.clone());
        q.replace(mixed.clone()).unwrap(); q.select(mixed.len()-1).unwrap();
        let mut settings = q.persistence.load_settings().unwrap(); settings.last_position_ms = 123456; q.persistence.save_settings(&settings).unwrap();
        for part in &parts { q.append_history(part).unwrap(); }
        let stored = StoredQueue { items: parts.clone(), selected_index: Some(1), saved_at_ms: 42 };
        q.persistence.save_named_queue("分 P", &stored).unwrap();
        q.persistence.delete_named_queue("分 P").unwrap(); q.persistence.undo_delete_queue().unwrap();
        assert_eq!(q.persistence.load_named_queue(Some("分 P")).unwrap().items, parts);
        let public = serde_json::to_value(q.persistence.load_playback_history().unwrap()).unwrap();
        assert_eq!(public[0]["video"]["title"], "视频原题"); assert_eq!(public[0]["video"]["partNumber"], 2);
        assert_eq!(public[0]["providerId"], "bilibili"); assert!(!public.to_string().contains("https://"));
        drop(q);
        let q = QueueService::open(&path).unwrap(); assert_eq!(q.snapshot().items, mixed);
        assert_eq!(q.snapshot().selected_index, Some(mixed.len()-1));
        assert_eq!(q.persistence.load_settings().unwrap().last_position_ms, 123456);
        // Long-term tapes must remain replayable after both queue removal and history pruning.
        let now = crate::personal::now_ms();
        for t in &parts { q.persistence.record_listening(&t.id, &t.title, &t.artist, 1000, true, now).unwrap(); }
        let month: String = q.persistence.connection().unwrap().query_row("SELECT strftime('%Y-%m',?1/1000,'unixepoch','localtime')", [now as i64], |r| r.get(0)).unwrap();
        q.replace(Vec::new()).unwrap(); q.persistence.connection().unwrap().execute("DELETE FROM playback_history", []).unwrap();
        let ids: Vec<_> = parts.iter().map(|t|t.id.clone()).collect();
        let replay = q.persistence.memory_tape_tracks(&month, &ids).unwrap();
        for (a,b) in replay.iter().zip(&parts) { assert_eq!(a.video,b.video); assert_eq!(a.id,b.id); }
        crate::queue::validate_items(&replay).unwrap();
        let mut wire = serde_json::to_value(&parts[0]).unwrap();
        wire["providerId"] = json!("netease"); assert!(serde_json::from_value::<QueueTrack>(wire.clone()).is_err());
        wire["providerId"] = json!("bilibili"); wire.as_object_mut().unwrap().remove("video");
        assert!(serde_json::from_value::<QueueTrack>(wire).is_err());
        drop(q); drop(b); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn schema12_migration_failure_rolls_back_every_change() {
        use crate::persistence::PersistenceService;
        let root = std::env::temp_dir().join(format!("bilibili-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap(); let path = root.join("state.sqlite3");
        drop(PersistenceService::open(&path).unwrap());
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("ALTER TABLE queue_items DROP COLUMN video_json; DROP TABLE playback_history; DROP TABLE video_part_metadata; PRAGMA user_version=11;").unwrap();
        assert!(PersistenceService::open(&path).is_err());
        assert_eq!(db.pragma_query_value::<u32,_>(None,"user_version",|r|r.get(0)).unwrap(),11);
        let fields: i64 = db.query_row("SELECT count(*) FROM pragma_table_info('queue_items') WHERE name='video_json'",[],|r|r.get(0)).unwrap(); assert_eq!(fields,0);
        let tables: i64 = db.query_row("SELECT count(*) FROM sqlite_master WHERE name='video_part_metadata'",[],|r|r.get(0)).unwrap(); assert_eq!(tables,0);
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
}
