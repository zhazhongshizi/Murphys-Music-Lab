//! Read-only production adapter. Public projections never contain resolved media.
use super::{client::Registration, identity, protocol::Error, registry::ProviderRegistry, OnlineProviderId, ProviderCapabilities, ProviderId};
use crate::provider::ProviderLaunch;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use sha2::{Digest, Sha256};

pub const METHODS: &[&str] = &["system.handshake","system.ping","auth.qr.start","auth.qr.poll","auth.qr.cancel","auth.credential.restore","auth.credential.check","auth.logout","search.songs","search.playlists","song.detail","library.containers","library.tracks","library.likes","lyrics.get","playback.resolve","library.likeIds","library.container","library.verify","library.setLiked","library.setSubscribed","library.addItems","library.removeItems"];
pub fn registration(root: &Path, node: &Path) -> Result<Registration, Error> {
    let bytes=std::fs::read(node).map_err(|_| Error::Unavailable)?;
    if format!("{:x}",Sha256::digest(bytes)) != "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9" { return Err(Error::Unavailable); }
    let main=root.join("providers/node/netease/main.mjs");
    if !main.is_file() || !root.join("providers/node/netease/node_modules/ajv/package.json").is_file() {return Err(Error::Unavailable);}
    let profile=ProviderCapabilities::netease();
    Registration::with_profile(OnlineProviderId::Netease,"0.1.0".into(),METHODS.iter().map(|m|m.to_string()).collect(),
        ProviderLaunch::new(node).map_err(|_| Error::Unavailable)?.args([main.as_os_str()]).current_dir(root).map_err(|_| Error::Unavailable)?,profile)
}
pub struct NeteaseService { pub registry: Arc<ProviderRegistry> }
impl NeteaseService {
    pub fn new(registry: Arc<ProviderRegistry>) -> Self { Self {registry} }
    pub fn ready_generation(&self) -> Result<u64, Error> {
        self.registry.ready_generation(OnlineProviderId::Netease)
    }
    pub(crate) fn call(&self, generation:u64, method:&str,params:Value)->Result<Value,Error> {
        let mut r=self.registry.request(OnlineProviderId::Netease,generation,method,params)?;
        if r["ok"]!=true { return Err(Error::Upstream(serde_json::from_value(r["error"]["code"].clone()).unwrap_or(super::ErrorCode::ProviderUnavailable))); }
        Ok(r["result"].take())
    }
    /// Only the explicit read whitelist can reach the renderer. No auth, writes,
    /// media resolution, arbitrary method forwarding or account-generation fields.
    pub fn read(&self, method:&str,params:Value)->Result<Value,Error> {
        if !["search.songs","search.playlists","song.detail","library.containers","library.tracks","library.likes","library.container"].contains(&method) {return Err(Error::Context);}
        let generation=self.ready_generation()?;
        let mut params=params;
        if let Some(c)=params.get_mut("containerId") {
            let s=c.as_str().ok_or(Error::Schema)?;
            if identity::container_provider(s)!=Ok(ProviderId::Netease){return Err(Error::Context);}
            *c=Value::String(s.strip_prefix("netease:playlist:").ok_or(Error::Context)?.into());
        }
        if let Some(t)=params.get_mut("songId") {*t=Value::String(raw_song(t.as_str().ok_or(Error::Schema)?)?.into());}
        let v=self.call(generation,method,params)?;
        if method=="library.container" {return public_container(&v);}
        if method=="song.detail" { return public_track(&v); }
        let tracks=matches!(method,"search.songs"|"library.tracks"|"library.likes");
        let items:Result<Vec<_>,_>=v["items"].as_array().ok_or(Error::Schema)?.iter().map(|item|if tracks{public_track(item)}else{public_container(item)}).collect();
        let page = v["page"].as_u64().filter(|p| *p >= 1).ok_or(Error::Schema)?;
        let has_more = v["hasMore"].as_bool().ok_or(Error::Schema)?;
        let total = if v["total"].is_null() {
            Value::Null
        } else {
            Value::from(v["total"].as_u64().ok_or(Error::Schema)?)
        };
        Ok(json!({"page":page,"hasMore":has_more,"total":total,"items":items?}))
    }
}
pub fn raw_song(id:&str)->Result<&str,Error> {
    if identity::track_provider(id)!=Ok(ProviderId::Netease){return Err(Error::Context);}
    id.strip_prefix("netease:track:").ok_or(Error::Context)
}
pub fn queue_track_from_provider_track(v: &Value) -> Result<crate::queue::QueueTrack, Error> {
    let obj = v.as_object().ok_or(Error::Schema)?;
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "providerId"
                | "id"
                | "title"
                | "artist"
                | "creatorKind"
                | "album"
                | "durationMs"
                | "availability"
                | "coverCacheKey"
        ) {
            return Err(Error::Schema);
        }
    }
    if v["providerId"].as_str() != Some("netease") || v["creatorKind"].as_str() != Some("artist") {
        return Err(Error::Schema);
    }
    if !matches!(
        v["availability"].as_str(),
        Some(
            "unknown"
                | "unavailable"
                | "authenticationRequired"
                | "deleted"
                | "permissionDenied"
                | "processing"
                | "noAudio"
        )
    ) {
        return Err(Error::Schema);
    }
    let id = v["id"].as_str().ok_or(Error::Schema)?;
    raw_song(id).map_err(|_| Error::Schema)?;
    let title = v["title"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 512)
        .ok_or(Error::Schema)?;
    let artist = v["artist"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 512)
        .ok_or(Error::Schema)?;
    let album = v["album"]
        .as_str()
        .filter(|s| s.chars().count() <= 512)
        .ok_or(Error::Schema)?
        .to_owned();
    let duration_ms = v["durationMs"]
        .as_u64()
        .filter(|d| *d <= 86_400_000)
        .ok_or(Error::Schema)?;
    let cover_cache_key = match v.get("coverCacheKey") {
        None => None,
        Some(val) => Some(
            val.as_str()
                .filter(|s| !s.is_empty() && s.chars().count() <= 128)
                .ok_or(Error::Schema)?
                .to_owned(),
        ),
    };
    let mut wire = json!({
        "providerId": "netease",
        "id": id,
        "title": title,
        "artist": artist,
        "album": album,
        "durationMs": duration_ms,
    });
    if let Some(key) = cover_cache_key {
        wire["coverCacheKey"] = Value::String(key);
    }
    let track: crate::queue::QueueTrack = serde_json::from_value(wire).map_err(|_| Error::Schema)?;
    crate::queue::validate_items(std::slice::from_ref(&track)).map_err(|_| Error::Schema)?;
    Ok(track)
}
fn public_track(v:&Value)->Result<Value,Error> {
    let id=v["ref"]["songId"].as_str().ok_or(Error::Schema)?;
    let id=identity::TrackRef::netease(id).map_err(|_|Error::Schema)?;
    let title=v["title"].as_str().filter(|s|!s.is_empty()&&s.chars().count()<=512).ok_or(Error::Schema)?;
    let artist=v["artist"].as_str().filter(|s|!s.is_empty()&&s.chars().count()<=512).ok_or(Error::Schema)?;
    let album=v["album"].as_str().filter(|s|s.chars().count()<=512).ok_or(Error::Schema)?;
    let duration_ms=v["durationMs"].as_u64().filter(|d|*d<=86_400_000).ok_or(Error::Schema)?;
    let availability=v["availability"].as_str().filter(|s|matches!(*s,"unknown"|"unavailable"|"authenticationRequired"|"deleted"|"permissionDenied"|"processing"|"noAudio")).ok_or(Error::Schema)?;
    Ok(json!({"providerId":"netease","id":id.id(),"title":title,"artist":artist,"creatorKind":"artist","album":album,"durationMs":duration_ms,"availability":availability}))
}
fn public_container(v:&Value)->Result<Value,Error> {
    let id=format!("netease:playlist:{}",v["id"].as_str().ok_or(Error::Schema)?);
    if identity::container_provider(&id)!=Ok(ProviderId::Netease){return Err(Error::Schema);}
    let ownership=v["ownership"].as_str().filter(|s|matches!(*s,"created"|"collected")).ok_or(Error::Schema)?;
    let owner_id=v["ownerId"].as_str().filter(|s|!s.is_empty()&&s.chars().count()<=128).ok_or(Error::Schema)?;
    let title=v["title"].as_str().filter(|s|!s.is_empty()&&s.chars().count()<=512).ok_or(Error::Schema)?;
    let description=v["description"].as_str().filter(|s|s.chars().count()<=4096).ok_or(Error::Schema)?;
    let item_count=v["itemCount"].as_u64().filter(|c|*c<=10_000_000).ok_or(Error::Schema)?;
    Ok(json!({"providerId":"netease","id":id,"kind":"playlist","ownership":ownership,"owner":{"providerId":"netease","id":owner_id},"title":title,"description":description,"itemCount":item_count,"allowedActions":v["allowedActions"]}))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use super::super::secrets::{Store,Prepared};
    use std::sync::Mutex;
    use zeroize::Zeroizing;
    #[derive(Default)]
    struct Memory(Arc<Mutex<Option<Vec<u8>>>>);
    struct Pending(Arc<Mutex<Option<Vec<u8>>>>,Vec<u8>);
    impl Prepared for Pending {fn commit(self:Box<Self>)->Result<(),Error>{*self.0.lock().unwrap()=Some(self.1);Ok(())}}
    impl Store for Memory {
        fn read(&self)->Result<Option<Zeroizing<Vec<u8>>>,Error>{Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))}
        fn prepare(&self,b:&[u8])->Result<Box<dyn Prepared>,Error>{Ok(Box::new(Pending(self.0.clone(),b.to_vec())))}
        fn delete(&self)->Result<(),Error>{*self.0.lock().unwrap()=None;Ok(())}
    }
    pub(crate) fn service()->Arc<NeteaseService> {
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let node=root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe");
        let mut r=registration(root,&node).expect("bootstrap fixed Node and npm ci --ignore-scripts before 3b tests");
        r.launch=ProviderLaunch::new(&node).unwrap().args([root.join("providers/node/netease/tests/fixture-entry.mjs").into_os_string()]).current_dir(root).unwrap();
        let memory=Arc::new(Memory::default());
        *memory.0.lock().unwrap()=Some(serde_json::to_vec(&json!({"version":1,"providerId":"netease","payload":"SYNTHETIC_TEST_ONLY"})).unwrap());
        let mut registry=ProviderRegistry::default();registry.register(r,memory).unwrap();
        assert!(registry.restore(OnlineProviderId::Netease).unwrap());
        Arc::new(NeteaseService::new(Arc::new(registry)))
    }
    #[test]
    fn node_provider_host_read_identity_and_secret_boundary() {
        let n=service();
        let v=n.read("search.songs",json!({"keyword":"fixture","page":1,"pageSize":2})).unwrap();
        assert!(v.get("providerId").is_none());
        assert_eq!(v["page"],1);
        assert_eq!(v["hasMore"],false);
        assert_eq!(v["total"],1);
        assert_eq!(v["items"][0]["providerId"],"netease");
        assert_eq!(v["items"][0]["id"],"netease:track:1");
        assert_eq!(v["items"][0]["creatorKind"],"artist");
        assert!(v["items"][0].get("mediaMid").is_none());
        assert!(v["items"][0].get("coverCacheKey").is_none());
        assert!(v["items"][0].get("url").is_none());
        assert!(v["items"][0].get("credential").is_none());
        let track = queue_track_from_provider_track(&v["items"][0]).unwrap();
        crate::queue::validate_items(&[track]).unwrap();

        let detail=n.read("song.detail",json!({"songId":"netease:track:1"})).unwrap();
        assert_eq!(detail["providerId"],"netease");
        assert_eq!(detail["id"],"netease:track:1");
        assert_eq!(detail["creatorKind"],"artist");
        assert!(detail.get("mediaMid").is_none());

        let containers=n.read("library.containers",json!({"kind":"created","page":1,"pageSize":20})).unwrap();
        assert!(containers.get("providerId").is_none());
        assert_eq!(containers["items"][0]["providerId"],"netease");
        assert_eq!(containers["items"][0]["id"],"netease:playlist:2");
        assert_eq!(containers["items"][0]["kind"],"playlist");
        assert_eq!(containers["items"][0]["ownership"],"created");
        assert_eq!(containers["items"][0]["owner"],json!({"providerId":"netease","id":"123"}));
        assert!(containers["items"][0].get("ownerId").is_none());
        assert_eq!(containers["items"][0]["allowedActions"],json!([]));

        let playlists=n.read("search.playlists",json!({"keyword":"fixture","page":1,"pageSize":20})).unwrap();
        assert!(playlists.get("providerId").is_none());
        assert_eq!(playlists["items"][0]["ownership"],"collected");
        assert_eq!(playlists["items"][0]["owner"],json!({"providerId":"netease","id":"456"}));

        let tracks=n.read("library.tracks",json!({"containerId":"netease:playlist:2","page":1,"pageSize":20})).unwrap();
        assert!(tracks.get("providerId").is_none());
        assert_eq!(tracks["items"][0]["id"],"netease:track:1");
        assert_eq!(tracks["items"][0]["creatorKind"],"artist");

        let likes=n.read("library.likes",json!({"page":1,"pageSize":20})).unwrap();
        assert!(likes.get("providerId").is_none());
        assert_eq!(likes["items"][0]["id"],"netease:track:1");

        assert!(n.read("library.addItems",json!({})).is_err());
        assert!(n.read("playback.resolve",json!({})).is_err());
        assert!(n.read("song.detail",json!({"songId":"qqmid"})).is_err());
        assert!(n.read("library.tracks",json!({"containerId":"bilibili:favorite:2","page":1,"pageSize":20})).is_err());
        assert_eq!(n.registry.snapshot(OnlineProviderId::Netease).unwrap().capabilities.write_actions,ProviderCapabilities::netease().write_actions);
        n.registry.sign_out(OnlineProviderId::Netease).unwrap();
        assert!(n.read("library.likes",json!({"page":1,"pageSize":20})).is_err());
    }
    #[test]
    fn rate_limit_and_verification_required_stop_only_source() {
        let n=service();
        assert_eq!(n.read("search.songs",json!({"keyword":"rate-limit","page":1,"pageSize":2})),Err(Error::Upstream(super::super::ErrorCode::RateLimited)));
        assert!(n.ready_generation().is_err());
        assert_eq!(n.registry.restore(OnlineProviderId::Netease),Err(Error::Cooldown));

        let n2=service();
        assert_eq!(n2.read("search.songs",json!({"keyword":"verify-risk","page":1,"pageSize":2})),Err(Error::Upstream(super::super::ErrorCode::VerificationRequired)));
        assert!(n2.ready_generation().is_err());
    }
    #[test]
    fn production_node_handshake_declares_only_real_read_methods() {
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let reg=registration(root,&root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe")).unwrap();
        let (client,_events)=super::super::client::Client::start(reg).unwrap();
        assert_eq!(client.request("system.ping",json!({})).unwrap()["result"]["alive"],true);
        client.stop();
    }
}
