//! Desktop write boundary: fixed identities, captured epoch, same-target exclusion.
use super::{
    identity,
    protocol::{self, Error},
    registry::ProviderRegistry,
    ErrorCode, OnlineProviderId, ProviderId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    pub provider_id: OnlineProviderId,
    pub account_id: String,
    pub operation: Operation,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    SetLiked {
        track_id: String,
        liked: bool,
    },
    SetSubscribed {
        container_id: String,
        subscribed: bool,
    },
    AddItems {
        container_id: String,
        track_ids: Vec<String>,
    },
    RemoveItems {
        container_id: String,
        track_ids: Vec<String>,
    },
}
impl WriteRequest {
    fn raw(&self) -> Result<(&'static str, Value, String, &'static str), Error> {
        let pid = self.provider_id;
        if !matches!(pid, OnlineProviderId::Netease | OnlineProviderId::Bilibili)
            || self.account_id.is_empty()
            || self.account_id.chars().count() > 128
        {
            return Err(Error::Context);
        }
        let container = |s: &str| -> Result<String, Error> {
            if identity::container_provider(s) != Ok(ProviderId::from(pid)) {
                return Err(Error::Context);
            }
            Ok(s.rsplit(':').next().ok_or(Error::Context)?.into())
        };
        let result = match &self.operation {
            Operation::SetLiked { track_id, liked } if pid == OnlineProviderId::Netease => (
                "library.setLiked",
                json!({"songId":super::netease::raw_song(track_id)?,"liked":liked}),
                format!("like:{track_id}"),
                if *liked { "song.like" } else { "song.unlike" },
            ),
            Operation::SetSubscribed {
                container_id,
                subscribed,
            } if pid == OnlineProviderId::Netease => (
                "library.setSubscribed",
                json!({"containerId":container(container_id)?,"subscribed":subscribed}),
                format!("container:{container_id}"),
                if *subscribed {
                    "playlist.subscribe"
                } else {
                    "playlist.unsubscribe"
                },
            ),
            Operation::AddItems {
                container_id,
                track_ids,
            }
            | Operation::RemoveItems {
                container_id,
                track_ids,
            } => {
                let add = matches!(self.operation, Operation::AddItems { .. });
                if track_ids.is_empty() || track_ids.len() > 100 {
                    return Err(Error::Schema);
                }
                let mut seen = HashSet::new();
                let mut items = Vec::new();
                for t in track_ids {
                    let item = if pid == OnlineProviderId::Netease {
                        json!({"kind":"song","songId":super::netease::raw_song(t)?})
                    } else {
                        let (bv, _) = super::bilibili::raw_part(t)?;
                        json!({"kind":"video","bvid":bv})
                    };
                    if seen.insert(item.to_string()) {
                        items.push(item);
                    }
                }
                (
                    if add {
                        "library.addItems"
                    } else {
                        "library.removeItems"
                    },
                    json!({"containerId":container(container_id)?,"items":items}),
                    format!("container:{container_id}"),
                    match (pid, add) {
                        (OnlineProviderId::Netease, true) => "playlist.addTracks",
                        (OnlineProviderId::Netease, false) => "playlist.removeTracks",
                        (_, true) => "favorite.addVideos",
                        _ => "favorite.removeVideos",
                    },
                )
            }
            _ => return Err(Error::Context),
        };
        protocol::request(pid, "write-validation", result.0, result.1.clone())?;
        Ok(result)
    }
    pub fn execute(&self, registry: &ProviderRegistry, verify_only: bool) -> Result<Value, Error> {
        let (method, params, key, action) = self.raw()?;
        let fingerprint = json!({"method":method,"params":params}).to_string();
        let lease = registry.begin_write(
            self.provider_id,
            &self.account_id,
            key,
            &fingerprint,
            verify_only,
        )?;
        let g = lease.generation;
        let snapshot = registry.snapshot(self.provider_id)?;
        let capabilities =
            serde_json::to_value(snapshot.capabilities).map_err(|_| Error::Schema)?;
        if !capabilities["writeActions"]
            .as_array()
            .is_some_and(|xs| xs.contains(&json!(action)))
        {
            return Err(Error::Context);
        }
        if let Some(c) = params.get("containerId") {
            let detail = registry.request(
                self.provider_id,
                g,
                "library.container",
                json!({"containerId":c}),
            )?;
            if detail["ok"] != true {
                return Err(upstream(&detail));
            }
            let d = &detail["result"];
            if d["id"] != *c {
                return Err(Error::Context);
            }
            if matches!(
                self.operation,
                Operation::AddItems { .. } | Operation::RemoveItems { .. }
            ) && (d["ownerId"] != self.account_id
                || d["ownership"] != "created"
                || !d["allowedActions"]
                    .as_array()
                    .is_some_and(|xs| xs.contains(&json!(action))))
            {
                return Err(Error::Upstream(ErrorCode::EntitlementDenied));
            }
        }
        // c.begin() is serialized with sign-out's generation change in Registry.
        // All ambiguous post-submission transport/process outcomes become pending.
        let response = registry.request(
            self.provider_id,
            g,
            if verify_only {
                "library.verify"
            } else {
                method
            },
            if verify_only {
                json!({"method":method,"params":params})
            } else {
                params
            },
        );
        let pending = || json!({"status":"verificationPending","affectedCount":null});
        match response {
            Ok(v) if v["ok"] == true => {
                registry.finish_write(&lease, fingerprint, v["result"]["status"] == "applied");
                if v["result"]["status"] == "applied" {
                    if let Operation::SetLiked { track_id, liked } = &self.operation {
                        registry.verified_like(g, track_id, *liked);
                    }
                }
                Ok(v["result"].clone())
            }
            Ok(v) => Err(upstream(&v)),
            Err(Error::Upstream(ErrorCode::OutcomeUnknown)) if !verify_only => {
                registry.finish_write(&lease, fingerprint, false);
                Ok(pending())
            }
            Err(e) => Err(e),
        }
    }
}
fn upstream(v: &Value) -> Error {
    Error::Upstream(
        serde_json::from_value(v["error"]["code"].clone())
            .unwrap_or(ErrorCode::ProviderUnavailable),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multi_provider::secrets::{Prepared, Store};
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use zeroize::Zeroizing;
    struct Memory(Vec<u8>);
    impl Store for Memory {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
            Ok(Some(Zeroizing::new(self.0.clone())))
        }
        fn prepare(&self, _: &[u8]) -> Result<Box<dyn Prepared>, Error> {
            Err(Error::Storage)
        }
        fn delete(&self) -> Result<(), Error> {
            Ok(())
        }
    }
    struct Fixture {
        registry: Arc<ProviderRegistry>,
        audit: PathBuf,
    }
    impl Fixture {
        fn new(id: OnlineProviderId, mode: &str, timeout: Duration) -> Self {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap();
            let node = root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe");
            let mut reg = if id == OnlineProviderId::Netease {
                super::super::netease::registration(root, &node)
            } else {
                super::super::bilibili::registration(root, &node)
            }
            .unwrap();
            let audit =
                std::env::temp_dir().join(format!("provider-write-{}.jsonl", uuid::Uuid::new_v4()));
            reg.launch = crate::provider::ProviderLaunch::new(&node)
                .unwrap()
                .args([
                    root.join("providers/node/tests/write-fixture-entry.mjs")
                        .into_os_string(),
                    protocol::name(id).into(),
                    audit.clone().into_os_string(),
                    mode.into(),
                ])
                .current_dir(root)
                .unwrap();
            reg.config.request_timeout = timeout;
            let mut registry = ProviderRegistry::default();
            registry.register(reg,Arc::new(Memory(serde_json::to_vec(&json!({"version":1,"providerId":protocol::name(id),"payload":"SYNTHETIC_TEST_ONLY"})).unwrap()))).unwrap();
            assert!(registry.restore(id).unwrap());
            Self {
                registry: Arc::new(registry),
                audit,
            }
        }
        fn count(&self) -> usize {
            std::fs::read_to_string(&self.audit)
                .unwrap_or_default()
                .lines()
                .count()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.registry.shutdown();
            let _ = std::fs::remove_file(&self.audit);
        }
    }
    fn like(liked: bool) -> WriteRequest {
        WriteRequest {
            provider_id: OnlineProviderId::Netease,
            account_id: "42".into(),
            operation: Operation::SetLiked {
                track_id: "netease:track:2".into(),
                liked,
            },
        }
    }
    fn items(id: OnlineProviderId) -> WriteRequest {
        WriteRequest {
            provider_id: id,
            account_id: "42".into(),
            operation: Operation::AddItems {
                container_id: if id == OnlineProviderId::Netease {
                    "netease:playlist:7"
                } else {
                    "bilibili:favorite:7"
                }
                .into(),
                track_ids: if id == OnlineProviderId::Netease {
                    vec!["netease:track:2".into()]
                } else {
                    vec![
                        "bilibili:video:BV17x411w7KC:123".into(),
                        "bilibili:video:BV17x411w7KC:124".into(),
                    ]
                },
            },
        }
    }
    #[test]
    fn actual_node_both_platform_writes_verify_and_deduplicate_cid_without_mutating_queue() {
        for id in [OnlineProviderId::Netease, OnlineProviderId::Bilibili] {
            let f = Fixture::new(id, "", Duration::from_secs(3));
            let op = items(id);
            assert_eq!(
                op.execute(&f.registry, false).unwrap(),
                json!({"status":"applied","affectedCount":null})
            );
            assert_eq!(f.count(), 1);
            assert_eq!(op.execute(&f.registry, false).unwrap()["status"], "applied");
            assert_eq!(f.count(), 1);
            assert_eq!(op.execute(&f.registry, true).unwrap()["status"], "applied");
            assert_eq!(f.count(), 1);
            let serialized = std::fs::read_to_string(&f.audit).unwrap();
            assert!(!serialized.contains("cid"));
        }
    }
    #[test]
    fn source_account_permission_and_strict_input_rejections_send_zero_writes() {
        let f = Fixture::new(OnlineProviderId::Netease, "foreign", Duration::from_secs(3));
        assert!(items(OnlineProviderId::Netease)
            .execute(&f.registry, false)
            .is_err());
        let mut wrong = like(true);
        wrong.account_id = "99".into();
        assert!(wrong.execute(&f.registry, false).is_err());
        for v in [
            json!({"providerId":"netease","accountId":"42","generation":1,"operation":{"kind":"setLiked","trackId":"netease:track:1","liked":true}}),
            json!({"providerId":"netease","accountId":"42","operation":{"kind":"setLiked","trackId":"netease:track:1","liked":true,"ownerId":"42"}}),
        ] {
            assert!(serde_json::from_value::<WriteRequest>(v).is_err());
        }
        let mut wrong = items(OnlineProviderId::Netease);
        wrong.operation = Operation::AddItems {
            container_id: "netease:playlist:7".into(),
            track_ids: vec!["bilibili:video:BV17x411w7KC:123".into()],
        };
        assert!(wrong.execute(&f.registry, false).is_err());
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn response_lost_is_pending_repeated_entry_is_blocked_and_verify_is_read_only() {
        for id in [OnlineProviderId::Netease, OnlineProviderId::Bilibili] {
            let f = Fixture::new(id, "lost", Duration::from_secs(3));
            let op = items(id);
            assert_eq!(
                op.execute(&f.registry, false).unwrap()["status"],
                "verificationPending"
            );
            assert_eq!(f.count(), 1);
            assert_eq!(
                op.execute(&f.registry, false),
                Err(Error::Upstream(ErrorCode::OutcomeUnknown))
            );
            assert_eq!(f.count(), 1);
            assert_eq!(op.execute(&f.registry, true).unwrap()["status"], "applied");
            assert_eq!(f.count(), 1);
        }
    }
    #[test]
    fn timeout_and_concurrent_same_target_never_replay_or_restart() {
        let f = Fixture::new(
            OnlineProviderId::Netease,
            "stall",
            Duration::from_millis(200),
        );
        let r = f.registry.clone();
        let write = std::thread::spawn(move || like(true).execute(&r, false));
        for _ in 0..100 {
            if f.count() > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(f.count(), 1);
        assert!(like(false).execute(&f.registry, false).is_err());
        assert_eq!(
            write.join().unwrap().unwrap()["status"],
            "verificationPending"
        );
        assert!(f
            .registry
            .ready_generation(OnlineProviderId::Netease)
            .is_err());
        assert_eq!(f.count(), 1);
    }
    #[test]
    fn signout_during_preflight_does_not_send_and_sent_outcome_does_not_cross_epoch() {
        for mode in ["delay-preflight", "delay-sent"] {
            let f = Fixture::new(OnlineProviderId::Netease, mode, Duration::from_secs(3));
            let r = f.registry.clone();
            let write =
                std::thread::spawn(move || items(OnlineProviderId::Netease).execute(&r, false));
            if mode == "delay-sent" {
                for _ in 0..100 {
                    if f.count() > 0 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            } else {
                std::thread::sleep(Duration::from_millis(60));
            }
            f.registry.sign_out(OnlineProviderId::Netease).unwrap();
            let result = write.join().unwrap();
            assert_eq!(f.count(), usize::from(mode == "delay-sent"));
            if mode == "delay-sent" {
                assert_eq!(result.unwrap()["status"], "verificationPending");
            } else {
                assert!(result.is_err());
            }
            assert!(f.registry.cached_netease_likes().is_none());
        }
    }
    #[test]
    fn likes_sync_and_verified_deltas_are_generation_scoped_and_old_reads_cannot_overwrite() {
        let f = Fixture::new(
            OnlineProviderId::Netease,
            "delay-read",
            Duration::from_secs(3),
        );
        f.registry.sync_netease_likes().unwrap();
        assert_eq!(
            f.registry.cached_netease_likes().unwrap(),
            HashSet::from(["netease:track:1".into()])
        );
        let r = f.registry.clone();
        let read = std::thread::spawn(move || r.sync_netease_likes());
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            like(true).execute(&f.registry, false).unwrap()["status"],
            "applied"
        );
        assert!(read.join().unwrap().is_err());
        assert!(f
            .registry
            .cached_netease_likes()
            .unwrap()
            .contains("netease:track:2"));
        f.registry.sign_out(OnlineProviderId::Netease).unwrap();
        assert!(f.registry.cached_netease_likes().is_none());
        assert!(f.registry.restore(OnlineProviderId::Netease).unwrap());
        f.registry.sync_netease_likes().unwrap();
        assert_eq!(f.registry.cached_netease_likes().unwrap(),HashSet::from(["netease:track:1".into()]));
    }
}
