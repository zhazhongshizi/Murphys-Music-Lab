#![cfg(feature = "test-provider")]
use qqmusic_gui_lib::{
    multi_provider::{
        client::{Client, Registration},
        protocol::{self, Error},
        registry::ProviderRegistry,
        secrets::{Prepared, Store},
        OnlineProviderId as Id,
    },
    provider::ProviderLaunch,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use zeroize::Zeroizing;
#[derive(Default)]
struct Memory {
    data: Arc<Mutex<Option<Vec<u8>>>>,
    fail_save: AtomicBool,
    fail_delete: AtomicBool,
}
struct Saved {
    data: Arc<Mutex<Option<Vec<u8>>>>,
    bytes: Vec<u8>,
}
impl Prepared for Saved {
    fn commit(self: Box<Self>) -> Result<(), Error> {
        *self.data.lock().unwrap() = Some(self.bytes);
        Ok(())
    }
}
impl Store for Memory {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        Ok(self.data.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn prepare(&self, b: &[u8]) -> Result<Box<dyn Prepared>, Error> {
        if self.fail_save.load(Ordering::Acquire) {
            return Err(Error::Storage);
        }
        Ok(Box::new(Saved {
            data: self.data.clone(),
            bytes: b.to_vec(),
        }))
    }
    fn delete(&self) -> Result<(), Error> {
        if self.fail_delete.load(Ordering::Acquire) {
            return Err(Error::Storage);
        }
        *self.data.lock().unwrap() = None;
        Ok(())
    }
}
fn registration(id: Id, scenario: &str, marker: Option<&PathBuf>) -> Registration {
    let methods = protocol::constants()["methods"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, s)| {
            s["providers"]
                .as_array()
                .unwrap()
                .contains(&json!(protocol::name(id)))
        })
        .map(|(m, _)| m.clone())
        .collect();
    let mut args = vec![protocol::name(id).to_string(), scenario.to_string()];
    if let Some(p) = marker {
        args.push(p.to_str().unwrap().into());
    }
    let launch = ProviderLaunch::new(PathBuf::from(env!("CARGO_BIN_EXE_provider-v2-fake")))
        .unwrap()
        .args(args);
    let mut r = Registration::v2(id, "test-3a".into(), methods, launch).unwrap();
    r.config.request_timeout = Duration::from_secs(1);
    r.config.handshake_timeout = Duration::from_secs(2);
    r
}
fn marker() -> PathBuf {
    std::env::temp_dir().join(format!("provider-3a-{}", uuid::Uuid::new_v4()))
}
fn secret(id: Id) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"version":1,"providerId":protocol::name(id),"payload":"SYNTHETIC_TEST_ONLY"}),
    )
    .unwrap()
}

#[test]
fn multibyte_account_restore_respects_the_schema_character_limit() {
    for (scenario, length) in [("account44", 44), ("account128", 128)] {
        let store = Arc::new(Memory::default());
        *store.data.lock().unwrap() = Some(secret(Id::Netease));
        let before = store.read().unwrap().unwrap().to_vec();
        let mut r = ProviderRegistry::default();
        r.register(registration(Id::Netease, scenario, None), store.clone())
            .unwrap();
        let outcome = r.restore(Id::Netease);
        let snapshot = serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap();
        assert_eq!(
            outcome,
            Ok(true),
            "characters={length}, phase={}",
            snapshot["state"]
        );
        assert_eq!(
            snapshot["account"]["id"].as_str().unwrap().chars().count(),
            length
        );
        assert_eq!(store.read().unwrap().unwrap().as_slice(), before);
    }
}
#[test]
fn multibyte_account_poll_is_validated_before_credential_commit() {
    for (scenario, length) in [("account44", 44), ("account128", 128)] {
        let store = Arc::new(Memory::default());
        let mut original: serde_json::Value = serde_json::from_slice(&secret(Id::Netease)).unwrap();
        original["payload"] = json!("ORIGINAL_SYNTHETIC_TEST_ONLY");
        let before = serde_json::to_vec(&original).unwrap();
        *store.data.lock().unwrap() = Some(before.clone());
        let mut r = ProviderRegistry::default();
        r.register(registration(Id::Netease, scenario, None), store.clone())
            .unwrap();
        r.login(Id::Netease).unwrap();
        let outcome = r.poll(
            Id::Netease,
            r.generation(Id::Netease).unwrap(),
            "synthetic-session",
        );
        let phase =
            serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"].clone();
        assert!(
            outcome.is_ok(),
            "characters={length}, phase={phase}, credentialChanged={}",
            store.read().unwrap().unwrap().as_slice() != before
        );
        assert_eq!(
            outcome.unwrap()["account"]["id"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            length
        );
    }
}
#[test]
fn invalid_account_frames_close_the_instance_preserve_secret_and_allow_retry() {
    for poll in [false, true] {
        let m = marker();
        let store = Arc::new(Memory::default());
        let original = secret(Id::Netease);
        *store.data.lock().unwrap() = Some(original.clone());
        let mut r = ProviderRegistry::default();
        r.register(
            registration(Id::Netease, "account129-once", Some(&m)),
            store.clone(),
        )
        .unwrap();
        if poll {
            r.login(Id::Netease).unwrap();
            assert!(r
                .poll(
                    Id::Netease,
                    r.generation(Id::Netease).unwrap(),
                    "synthetic-session"
                )
                .is_err());
        } else {
            assert!(r.restore(Id::Netease).is_err());
        }
        assert_eq!(
            serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
            "disabled"
        );
        assert_eq!(store.read().unwrap().unwrap().as_slice(), original);
        let old = r.generation(Id::Netease).unwrap();
        assert!(r.restore(Id::Netease).unwrap());
        assert!(r.generation(Id::Netease).unwrap() > old);
        let _ = std::fs::remove_file(m);
    }
}
#[test]
fn subprocess_retry_after_limits_reject_protocol_faults_without_cooldown_or_panic() {
    for scenario in [
        "cooldown-zero",
        "cooldown-max",
        "cooldown-over",
        "cooldown-negative",
        "cooldown-huge",
        "cooldown-exponent",
    ] {
        let store = Arc::new(Memory::default());
        let original = secret(Id::Netease);
        *store.data.lock().unwrap() = Some(original.clone());
        let mut r = ProviderRegistry::default();
        r.register(registration(Id::Netease, scenario, None), store.clone())
            .unwrap();
        assert_eq!(r.restore(Id::Netease), Err(Error::Unavailable));
        let snapshot = serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap();
        assert_eq!(snapshot["state"], "disabled");
        assert_eq!(store.read().unwrap().unwrap().as_slice(), original);
        if scenario == "cooldown-max" {
            assert_eq!(snapshot["error"], "rate_limited");
            assert!((86300000..=86400000).contains(&snapshot["retryAfterMs"].as_u64().unwrap()));
            assert_eq!(r.restore(Id::Netease), Err(Error::Cooldown));
        } else if scenario == "cooldown-zero" {
            assert_eq!(snapshot["error"], "rate_limited");
            assert!(snapshot.get("retryAfterMs").is_none());
        } else {
            assert_eq!(snapshot["error"], "provider_unavailable");
            assert!(snapshot.get("retryAfterMs").is_none());
            let old = r.generation(Id::Netease).unwrap();
            assert_eq!(r.restore(Id::Netease), Err(Error::Unavailable));
            assert!(r.generation(Id::Netease).unwrap() > old);
        }
    }
}
#[test]
fn real_v2_handshake_profiles_and_rejections() {
    for id in [Id::Netease, Id::Bilibili] {
        let (c, _) = Client::start(registration(id, "normal", None)).unwrap();
        assert_eq!(
            c.request("system.ping", json!({})).unwrap()["result"]["alive"],
            true
        );
    }
    for s in [
        "wrong-name",
        "wrong-version",
        "wrong-capability",
        "missing-method",
        "v1",
    ] {
        assert!(
            Client::start(registration(Id::Netease, s, None)).is_err(),
            "{s}"
        );
    }
}

#[test]
fn real_v2_exact_boundaries_and_blocked_stdin_remain_cancellable() {
    for s in ["exact-lf", "exact-crlf"] {
        let (c, _) = Client::start(registration(Id::Netease, s, None)).unwrap();
        assert!(c.request("system.ping", json!({})).is_ok());
    }
    for s in ["oversize", "bad-escape", "float-version"] {
        let (c, _) = Client::start(registration(Id::Netease, s, None)).unwrap();
        assert!(c.request("system.ping", json!({})).is_err());
    }
    let (c, _) = Client::start(registration(Id::Netease, "no-read", None)).unwrap();
    let start = std::time::Instant::now();
    let p = c
        .begin(
            "auth.credential.restore",
            json!({"credential":{"version":1,"providerId":"netease","payload":"x".repeat(60000)}}),
            Some(Duration::from_millis(50)),
        )
        .unwrap();
    assert_eq!(p.wait(), Err(Error::Timeout));
    c.stop();
    assert!(start.elapsed() < Duration::from_secs(2));
}
#[test]
fn real_v2_out_of_order_timeout_cancel_and_late_response() {
    let (c, _) = Client::start(registration(Id::Netease, "out-of-order", None)).unwrap();
    let a = c.begin("system.ping", json!({}), None).unwrap();
    let b = c.begin("system.ping", json!({}), None).unwrap();
    let vb = b.wait().unwrap();
    let va = a.wait().unwrap();
    assert_ne!(va["id"], vb["id"]);
    drop(c);
    let (c, _) = Client::start(registration(Id::Netease, "delay", None)).unwrap();
    assert_eq!(
        c.begin("system.ping", json!({}), Some(Duration::from_millis(20)))
            .unwrap()
            .wait(),
        Err(Error::Timeout)
    );
    let p = c.begin("system.ping", json!({}), None).unwrap();
    p.cancel();
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        c.request("system.ping", json!({})).unwrap()["result"]["alive"],
        true
    );
}
#[test]
fn real_v2_malformed_unknown_duplicate_and_context_fail_closed() {
    for s in ["wrong-result", "invalid-utf8", "unknown", "duplicate"] {
        let (c, _) = Client::start(registration(Id::Netease, s, None)).unwrap();
        let first = c.request("system.ping", json!({}));
        if s == "duplicate" {
            thread::sleep(Duration::from_millis(50));
            assert!(c.request("system.ping", json!({})).is_err());
        } else {
            assert!(first.is_err(), "{s}");
        }
    }
    let (c, _) = Client::start(registration(Id::Netease, "wrong-session", None)).unwrap();
    assert!(c
        .request("auth.qr.poll", json!({"sessionId":"synthetic-session"}))
        .is_err());
}
#[test]
fn registry_zero_process_login_cancel_restore_and_platform_isolation() {
    let a = marker();
    let b = marker();
    let sa = Arc::new(Memory::default());
    let sb = Arc::new(Memory::default());
    let mut r = ProviderRegistry::default();
    r.register(registration(Id::Netease, "normal", Some(&a)), sa.clone())
        .unwrap();
    r.register(registration(Id::Bilibili, "normal", Some(&b)), sb.clone())
        .unwrap();
    assert!(!r.restore(Id::Netease).unwrap());
    assert!(!r.restore(Id::Bilibili).unwrap());
    assert!(!a.exists() && !b.exists());
    assert!(r
        .request(Id::Netease, 0, "search.songs", json!({}))
        .is_err());
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    r.cancel(Id::Netease, g, "synthetic-session").unwrap();
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "disabled"
    );
    assert!(!b.exists());
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let public = r.poll(Id::Netease, g, "synthetic-session").unwrap();
    assert!(public.get("credential").is_none());
    assert_eq!(public["persistence"], "saved");
    r.cancel(Id::Netease, g, "synthetic-session").unwrap();
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "ready"
    );
    r.shutdown().unwrap();
    assert!(r.restore(Id::Netease).unwrap());
    assert_eq!(sa.read().unwrap().unwrap().as_slice(), secret(Id::Netease));
    r.sign_out(Id::Netease).unwrap();
    assert!(sa.read().unwrap().is_none());
    assert!(!b.exists());
    let _ = std::fs::remove_file(a);
}

#[test]
fn starting_sign_out_waits_for_the_owned_child_and_late_exit_cannot_revive_it() {
    let m = marker();
    let store = Arc::new(Memory::default());
    let mut r = ProviderRegistry::default();
    r.register(
        registration(Id::Netease, "slow-handshake", Some(&m)),
        store.clone(),
    )
    .unwrap();
    let r = Arc::new(r);
    let rr = r.clone();
    let login = thread::spawn(move || rr.login(Id::Netease));
    for _ in 0..100 {
        if r.generation(Id::Netease).unwrap() != 0 {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    r.sign_out(Id::Netease).unwrap();
    assert!(login.join().unwrap().is_err());
    assert!(store.read().unwrap().is_none());
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "disabled"
    );
    thread::sleep(Duration::from_millis(30));
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
    let _ = std::fs::remove_file(m);
}
#[test]
fn ready_platform_crash_and_concurrent_signout_leave_the_other_account_untouched() {
    let m = marker();
    let a = Arc::new(Memory::default());
    let b = Arc::new(Memory::default());
    let mut r = ProviderRegistry::default();
    r.register(
        registration(Id::Netease, "crash-ready", Some(&m)),
        a.clone(),
    )
    .unwrap();
    r.register(registration(Id::Bilibili, "normal", None), b.clone())
        .unwrap();
    for id in [Id::Netease, Id::Bilibili] {
        r.login(id).unwrap();
        r.poll(id, r.generation(id).unwrap(), "synthetic-session")
            .unwrap();
    }
    let other = b.read().unwrap().unwrap().to_vec();
    let bg = r.generation(Id::Bilibili).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let r = Arc::new(r);
    let rr = r.clone();
    let failure = thread::spawn(move || {
        rr.request(
            Id::Netease,
            g,
            "search.songs",
            json!({"keyword":"Synthetic","page":1,"pageSize":20}),
        )
    });
    for _ in 0..200 {
        if m.with_extension("exit").exists() {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert!(m.with_extension("exit").exists());
    r.sign_out(Id::Netease).unwrap();
    assert!(failure.join().unwrap().is_err());
    assert!(a.read().unwrap().is_none());
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "disabled"
    );
    assert_eq!(r.generation(Id::Bilibili).unwrap(), bg);
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Bilibili).unwrap()).unwrap()["state"],
        "ready"
    );
    assert_eq!(b.read().unwrap().unwrap().as_slice(), other);
    let _ = std::fs::remove_file(&m);
    let _ = std::fs::remove_file(m.with_extension("exit"));
}
#[test]
fn new_platform_crash_never_restarts_or_replays_manual_retry_changes_epoch() {
    for id in [Id::Netease, Id::Bilibili] {
        let m = marker();
        let mut r = ProviderRegistry::default();
        let reg = registration(id, "crash", Some(&m));
        assert_eq!(reg.config.max_restarts, 0);
        r.register(reg, Arc::new(Memory::default())).unwrap();
        assert!(r.login(id).is_err());
        let old = r.generation(id).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
        assert!(r.login(id).is_err());
        assert!(r.generation(id).unwrap() > old);
        assert_eq!(std::fs::read_to_string(&m).unwrap(), "2");
        let _ = std::fs::remove_file(m);
    }
}
#[test]
fn restore_network_risk_and_rate_limit_keep_secret_and_stop_without_retry() {
    for scenario in [
        "network_unavailable",
        "verification_required",
        "rate_limited",
        "credential_invalid",
    ] {
        let m = marker();
        let s = Arc::new(Memory::default());
        *s.data.lock().unwrap() = Some(secret(Id::Netease));
        let mut r = ProviderRegistry::default();
        r.register(registration(Id::Netease, scenario, Some(&m)), s.clone())
            .unwrap();
        assert!(r.restore(Id::Netease).is_err());
        assert!(s.read().unwrap().is_some());
        assert_eq!(
            serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
            "disabled"
        );
        if ["verification_required", "rate_limited"].contains(&scenario) {
            assert_eq!(r.restore(Id::Netease), Err(Error::Cooldown));
            assert!(
                serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["retryAfterMs"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
        }
        thread::sleep(Duration::from_millis(60));
        assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
        if ["verification_required", "rate_limited"].contains(&scenario) {
            thread::sleep(Duration::from_millis(130));
            let old = r.generation(Id::Netease).unwrap();
            assert_eq!(r.restore(Id::Netease), Err(Error::Unavailable));
            assert!(r.generation(Id::Netease).unwrap() > old);
            assert_eq!(std::fs::read_to_string(&m).unwrap(), "2");
        }
        let _ = std::fs::remove_file(m);
    }
}
#[test]
fn session_only_save_failure_and_delete_failure_are_distinct() {
    let s = Arc::new(Memory::default());
    s.fail_save.store(true, Ordering::Release);
    let mut r = ProviderRegistry::default();
    r.register(registration(Id::Netease, "normal", None), s.clone())
        .unwrap();
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    assert_eq!(
        r.poll(Id::Netease, g, "synthetic-session").unwrap()["persistence"],
        "sessionOnly"
    );
    s.fail_delete.store(true, Ordering::Release);
    assert_eq!(r.sign_out(Id::Netease), Err(Error::Storage));
    s.fail_delete.store(false, Ordering::Release);
    r.sign_out(Id::Netease).unwrap();
}

struct Gate {
    armed: AtomicBool,
    entered: std::sync::mpsc::Sender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Gate {
    fn wait(&self) {
        if self.armed.swap(false, Ordering::AcqRel) {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
    }
}
struct BlockStore {
    inner: Arc<Memory>,
    gate: Arc<Gate>,
    at_commit: bool,
}
struct BlockCommit {
    inner: Box<dyn Prepared>,
    gate: Arc<Gate>,
    at_commit: bool,
}
impl Prepared for BlockCommit {
    fn commit(self: Box<Self>) -> Result<(), Error> {
        if self.at_commit {
            self.gate.wait();
        }
        self.inner.commit()
    }
}
impl Store for BlockStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        self.inner.read()
    }
    fn prepare(&self, b: &[u8]) -> Result<Box<dyn Prepared>, Error> {
        if !self.at_commit {
            self.gate.wait();
        }
        Ok(Box::new(BlockCommit {
            inner: self.inner.prepare(b)?,
            gate: self.gate.clone(),
            at_commit: self.at_commit,
        }))
    }
    fn delete(&self) -> Result<(), Error> {
        self.inner.delete()
    }
}
fn blocked_registry(
    at_commit: bool,
) -> (
    Arc<ProviderRegistry>,
    Arc<Memory>,
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (entered, rx) = std::sync::mpsc::channel();
    let (tx, release) = std::sync::mpsc::channel();
    let inner = Arc::new(Memory::default());
    let store = Arc::new(BlockStore {
        inner: inner.clone(),
        gate: Arc::new(Gate {
            armed: AtomicBool::new(true),
            entered,
            release: Mutex::new(release),
        }),
        at_commit,
    });
    let mut r = ProviderRegistry::default();
    r.register(registration(Id::Netease, "normal", None), store)
        .unwrap();
    (Arc::new(r), inner, rx, tx)
}
#[test]
fn logout_invalidates_prepared_save_and_old_save_cannot_overwrite_new_login() {
    let (r, store, entered, release) = blocked_registry(false);
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let rr = r.clone();
    let poll = thread::spawn(move || rr.poll(Id::Netease, g, "synthetic-session"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    r.sign_out(Id::Netease).unwrap();
    assert!(store.read().unwrap().is_none());
    r.login(Id::Netease).unwrap();
    let new = r.generation(Id::Netease).unwrap();
    assert!(new > g);
    r.poll(Id::Netease, new, "synthetic-session").unwrap();
    let saved = store.read().unwrap().unwrap().to_vec();
    release.send(()).unwrap();
    assert_eq!(poll.join().unwrap(), Err(Error::Stale));
    assert_eq!(store.read().unwrap().unwrap().as_slice(), saved);
    r.shutdown().unwrap();
    assert!(r.restore(Id::Netease).unwrap());
    assert_eq!(store.read().unwrap().unwrap().as_slice(), saved);
}
#[test]
fn logout_waits_for_committing_save_then_deletes_before_it_completes() {
    let (r, store, entered, release) = blocked_registry(true);
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let rr = r.clone();
    let poll = thread::spawn(move || rr.poll(Id::Netease, g, "synthetic-session"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let rr = r.clone();
    let (done, rx) = std::sync::mpsc::channel();
    let logout = thread::spawn(move || {
        let result = rr.sign_out(Id::Netease);
        done.send(result).unwrap();
    });
    thread::sleep(Duration::from_millis(20));
    assert!(rx.try_recv().is_err());
    release.send(()).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(()));
    logout.join().unwrap();
    let _ = poll.join().unwrap(); // A commit already linearized may publish before logout.
    assert!(store.read().unwrap().is_none());
    assert!(!r.restore(Id::Netease).unwrap());
}
#[test]
fn qr_cancel_during_commit_is_ordered_after_authentication_and_preserves_ready() {
    let (r, store, entered, release) = blocked_registry(true);
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let rr = r.clone();
    let poll = thread::spawn(move || rr.poll(Id::Netease, g, "synthetic-session"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let rr = r.clone();
    let (done, rx) = std::sync::mpsc::channel();
    let cancel = thread::spawn(move || {
        done.send(rr.cancel(Id::Netease, g, "synthetic-session"))
            .unwrap()
    });
    thread::sleep(Duration::from_millis(20));
    assert!(rx.try_recv().is_err());
    release.send(()).unwrap();
    assert!(poll.join().unwrap().is_ok());
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(()));
    cancel.join().unwrap();
    assert!(store.read().unwrap().is_some());
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "ready"
    );
}
#[test]
fn effective_qr_cancel_wins_against_auth_save_but_late_cancel_preserves_ready() {
    let (r, store, entered, release) = blocked_registry(false);
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    let rr = r.clone();
    let poll = thread::spawn(move || rr.poll(Id::Netease, g, "synthetic-session"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    r.cancel(Id::Netease, g, "synthetic-session").unwrap();
    release.send(()).unwrap();
    assert_eq!(poll.join().unwrap(), Err(Error::Stale));
    assert!(store.read().unwrap().is_none());
    r.login(Id::Netease).unwrap();
    let g = r.generation(Id::Netease).unwrap();
    r.poll(Id::Netease, g, "synthetic-session").unwrap();
    r.cancel(Id::Netease, g, "synthetic-session").unwrap();
    assert_eq!(
        serde_json::to_value(r.snapshot(Id::Netease).unwrap()).unwrap()["state"],
        "ready"
    );
}
