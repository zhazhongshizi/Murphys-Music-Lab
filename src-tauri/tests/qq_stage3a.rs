#![cfg(feature = "test-provider")]
use qqmusic_gui_lib::{
    auth::{AuthService, QrLoginState, RecoveryState},
    credentials::{CredentialError, CredentialStore, SecretBlob},
    multi_provider::qq::QqHost,
    provider::{ProviderLaunch, ProviderRequest, ProviderRequestPort},
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
#[derive(Default)]
struct Memory(Mutex<Option<SecretBlob>>);
impl CredentialStore for Memory {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn replace(&self, b: &SecretBlob) -> Result<(), CredentialError> {
        *self.0.lock().unwrap() = Some(b.clone());
        Ok(())
    }
    fn delete(&self) -> Result<(), CredentialError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
fn marker() -> PathBuf {
    std::env::temp_dir().join(format!("qq-3a-{}", uuid::Uuid::new_v4()))
}
fn qq(scenario: &str, store: Arc<Memory>, m: &PathBuf) -> Arc<QqHost> {
    let launch = ProviderLaunch::new(PathBuf::from(env!("CARGO_BIN_EXE_qqmusic-fake-provider")))
        .unwrap()
        .args([
            "--scenario".into(),
            scenario.to_owned(),
            "--marker".into(),
            m.to_str().unwrap().to_owned(),
        ]);
    QqHost::new(launch, store)
}
fn seeded() -> Arc<Memory> {
    let store = Arc::new(Memory::default());
    store
        .replace(
            &SecretBlob::new(
                serde_json::to_vec(
                    &json!({"musicid":123,"login_type":2,"musickey":"SYNTHETIC_TEST_ONLY"}),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    store
}
#[test]
fn ready_refresh_temporary_failure_preserves_account_credentials_and_business() {
    for scenario in ["qq-refresh-network", "qq-refresh-rate"] {
        let store = seeded();
        let before = store.read().unwrap().unwrap();
        let m = marker();
        let host = qq(scenario, store.clone(), &m);
        host.restore().unwrap();
        let account = host.account().unwrap();
        let generation = host.generation();
        let auth = AuthService::new(host.clone(), store.clone()).with_host(host.clone());
        assert!(auth.refresh().is_err());
        assert_eq!(host.account(), Some(account));
        assert_eq!(host.generation(), generation);
        assert_eq!(store.read().unwrap().unwrap().payload(), before.payload());
        assert_eq!(
            std::fs::read_to_string(m.with_extension("refresh")).unwrap(),
            "1"
        );
        assert_eq!(
            qqmusic_gui_lib::catalog::CatalogService::new(host.clone())
                .search_songs("Synthetic", 1, 20, 1)
                .unwrap()
                .items
                .len(),
            1
        );
        host.shutdown();
        let _ = std::fs::remove_file(&m);
        let _ = std::fs::remove_file(m.with_extension("refresh"));
    }
}
#[test]
fn confirmed_invalid_auth_and_real_transport_faults_retire_ready_without_replaying_refresh() {
    for scenario in [
        "qq-refresh-invalid",
        "qq-refresh-required",
        "qq-refresh-crash",
        "qq-refresh-protocol",
    ] {
        let store = seeded();
        let before = store.read().unwrap().unwrap();
        let m = marker();
        let launch =
            ProviderLaunch::new(PathBuf::from(env!("CARGO_BIN_EXE_qqmusic-fake-provider")))
                .unwrap()
                .args([
                    "--scenario".into(),
                    scenario.to_string(),
                    "--marker".into(),
                    m.to_str().unwrap().to_owned(),
                ]);
        let host = QqHost::with_config(
            launch,
            store.clone(),
            qqmusic_gui_lib::provider::SupervisorConfig {
                max_restarts: 0,
                ..Default::default()
            },
        );
        host.restore().unwrap();
        let old = host.generation();
        let auth = AuthService::new(host.clone(), store.clone()).with_host(host.clone());
        assert!(auth.refresh().is_err());
        assert!(host.account().is_none());
        assert!(!host.snapshot().transport_ready());
        assert!(host.generation() > old);
        assert_eq!(store.read().unwrap().unwrap().payload(), before.payload());
        assert_eq!(
            std::fs::read_to_string(m.with_extension("refresh")).unwrap(),
            "1"
        );
        assert!(
            matches!(host.request(ProviderRequest::read_only("search.songs",Default::default())),Ok(qqmusic_gui_lib::provider::ProviderReply::Failure{code,..}) if code=="authentication_required")
        );
        assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
        let _ = std::fs::remove_file(&m);
        let _ = std::fs::remove_file(m.with_extension("refresh"));
    }
}
#[test]
fn qq_current_auth_rejection_is_injected_before_save_while_old_and_duplicate_results_are_isolated()
{
    use qqmusic_gui_lib::auth::{AuthError, PublicAccount};
    let store = seeded();
    let before = store.read().unwrap().unwrap();
    let m = marker();
    let host = qq("qq-normal", store.clone(), &m);
    let auth = AuthService::new(host.clone(), store.clone()).with_host(host.clone());
    auth.start_qr("qq").unwrap();
    let old = host.generation();
    let malformed = PublicAccount {
        music_id: "x".repeat(129),
        login_method: "qq".into(),
    };
    let credential =
        json!({"musicid":999,"login_type":2,"musickey":"REPLACEMENT_SYNTHETIC_TEST_ONLY"});
    assert_eq!(
        host.accept(old, "qq-synthetic", malformed.clone(), &credential),
        Err(AuthError::InvalidResponse)
    );
    assert!(!host.snapshot().transport_ready());
    assert_eq!(store.read().unwrap().unwrap().payload(), before.payload());
    auth.start_qr("qq").unwrap();
    auth.poll_qr("qq-synthetic").unwrap();
    let ready = host.account();
    let saved = store.read().unwrap().unwrap();
    assert_eq!(
        host.accept(old, "qq-synthetic", malformed.clone(), &credential),
        Err(AuthError::SessionNotFound)
    );
    assert!(host
        .accept(host.generation(), "qq-synthetic", malformed, &credential)
        .is_err());
    assert_eq!(host.account(), ready);
    assert_eq!(store.read().unwrap().unwrap().payload(), saved.payload());
    host.shutdown();
    let _ = std::fs::remove_file(m);
}
#[test]
fn login_domain_failure_closes_only_the_temporary_instance_and_keeps_saved_credential() {
    let store = seeded();
    let before = store.read().unwrap().unwrap();
    let m = marker();
    let host = qq("qq-login-network", store.clone(), &m);
    let auth = AuthService::new(host.clone(), store.clone()).with_host(host.clone());
    assert!(auth.start_qr("qq").is_err());
    assert!(host.account().is_none());
    assert!(!host.snapshot().transport_ready());
    assert_eq!(store.read().unwrap().unwrap().payload(), before.payload());
    let _ = std::fs::remove_file(m);
}
#[test]
fn shared_remote_catalog_and_shortcut_resolution_remain_gated_while_restoring() {
    use qqmusic_gui_lib::{
        catalog::{CatalogError, CatalogService},
        playback::{PlaybackController, PlaybackError, PlaybackQuality},
        playback_session::{PlaybackSession, PlaybackSessionError},
        player::{PlayerCommand, PlayerEngine, PlayerError, PlayerSnapshot},
        queue::{QueueService, QueueTrack},
    };
    struct Idle;
    impl PlayerEngine for Idle {
        fn snapshot(&self) -> PlayerSnapshot {
            PlayerSnapshot::idle()
        }
        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            assert!(
                !matches!(
                    command,
                    PlayerCommand::LoadRemote { .. } | PlayerCommand::LoadLocal { .. }
                ),
                "restoring must not load media"
            );
            Ok(())
        }
    }
    let root = std::env::temp_dir().join(format!("qq-review-ready-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let m = root.join("spawn");
    let store = seeded();
    let before = store.read().unwrap().unwrap();
    let host = qq("qq-restore-blocked", store.clone(), &m);
    let worker = host.clone();
    let restoring = thread::spawn(move || worker.restore());
    for _ in 0..500 {
        if m.with_extension("restoring").exists() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert!(m.with_extension("restoring").exists());
    assert_eq!(
        serde_json::to_value(host.public_snapshot()).unwrap()["state"],
        "restoring"
    );
    let catalog = CatalogService::new(host.clone());
    assert_eq!(
        catalog.search_songs("Synthetic", 1, 20, 1),
        Err(CatalogError::AuthenticationRequired)
    );
    let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
    queue
        .replace(vec![QueueTrack {
            video: None,
            id: "SyntheticQQMID".into(),
            media_mid: None,
            title: "Synthetic".into(),
            artist: "Fixture".into(),
            album: String::new(),
            duration_ms: 1000,
            cover_cache_key: None,
        }])
        .unwrap();
    let session = PlaybackSession::new(
        queue,
        Arc::new(PlaybackController::new(host.clone(), Box::new(Idle))),
    );
    assert_eq!(
        session.play_index(0, PlaybackQuality::Kbps128),
        Err(PlaybackSessionError::Playback(
            PlaybackError::AuthenticationRequired
        ))
    );
    assert!(!m.with_extension("search").exists());
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
    assert_eq!(store.read().unwrap().unwrap().payload(), before.payload());
    std::fs::write(m.with_extension("release"), b"release").unwrap();
    assert!(matches!(
        restoring.join().unwrap(),
        Ok(RecoveryState::Authenticated { .. })
    ));
    assert_eq!(
        catalog
            .search_songs("Synthetic", 1, 20, 1)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(m.with_extension("search")).unwrap(),
        "1"
    );
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
    drop(session);
    drop(catalog);
    host.shutdown();
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn qq_no_credential_zero_process_login_cancel_restore_and_v1_secret_format() {
    let store = Arc::new(Memory::default());
    let m = marker();
    let host = qq("qq-normal", store.clone(), &m);
    let auth = AuthService::new(host.clone(), store.clone()).with_host(host.clone());
    assert_eq!(auth.recover(), Ok(RecoveryState::SignedOut));
    assert!(!m.exists());
    assert!(
        matches!(host.request(ProviderRequest::read_only("search.songs",Default::default())),Ok(qqmusic_gui_lib::provider::ProviderReply::Failure{code,..}) if code=="authentication_required")
    );
    assert!(!m.exists());
    auth.start_qr("qq").unwrap();
    auth.cancel_qr("qq-synthetic").unwrap();
    assert!(host.account().is_none());
    auth.start_qr("qq").unwrap();
    assert!(matches!(
        auth.poll_qr("qq-synthetic"),
        Ok(QrLoginState::Authenticated { .. })
    ));
    let saved = store.read().unwrap().unwrap();
    let v: Value = serde_json::from_slice(saved.payload()).unwrap();
    assert_eq!(v["musicid"], 123);
    assert!(v.get("providerId").is_none());
    auth.cancel_qr("qq-synthetic").unwrap();
    assert!(host.account().is_some());
    assert!(host
        .request(ProviderRequest::read_only(
            "search.songs",
            Default::default()
        ))
        .is_ok());
    let page = qqmusic_gui_lib::catalog::CatalogService::new(host.clone())
        .search_songs("Synthetic", 1, 20, 1)
        .unwrap();
    assert_eq!(page.items[0].id, "SyntheticQQMID");
    assert_eq!(
        serde_json::to_value(&page).unwrap()["items"][0]["providerId"],
        "qqmusic"
    );
    host.shutdown();
    assert!(matches!(
        auth.recover(),
        Ok(RecoveryState::Authenticated { .. })
    ));
    auth.logout().unwrap();
    assert!(store.read().unwrap().is_none());
    assert!(host.account().is_none());
    let _ = std::fs::remove_file(m);
}
#[test]
fn qq_network_restore_keeps_secret_and_bad_v1_registration_is_rejected() {
    let store = seeded();
    let m = marker();
    let host = qq("qq-network", store.clone(), &m);
    assert!(host.restore().is_err());
    assert!(store.read().unwrap().is_some());
    assert!(!host.snapshot().transport_ready());
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "1");
    let _ = std::fs::remove_file(&m);
    for scenario in [
        "qq-wrong-version",
        "qq-wrong-name",
        "qq-wrong-capability",
        "qq-missing-method",
    ] {
        let bad = qq(scenario, store.clone(), &m);
        assert!(bad.restore().is_err(), "{scenario}");
        assert!(store.read().unwrap().is_some());
        let _ = std::fs::remove_file(&m);
    }
}
#[test]
fn qq_restart_recovers_account_without_replaying_the_failed_read() {
    let store = seeded();
    let m = marker();
    let host = qq("qq-crash", store.clone(), &m);
    host.restore().unwrap();
    assert!(host
        .request(ProviderRequest::read_only(
            "search.songs",
            Default::default()
        ))
        .is_err());
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "2");
    assert!(host.account().is_some());
    host.logout().unwrap();
    thread::sleep(Duration::from_millis(150));
    assert_eq!(std::fs::read_to_string(&m).unwrap(), "2");
    let _ = std::fs::remove_file(m);
}
