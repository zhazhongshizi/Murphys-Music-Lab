//! Explicit package-check mode. All runtime files live beside the copied EXE;
//! Windows account credentials are never read or written in this mode.
use crate::credentials::{CredentialError, CredentialStore, SecretBlob};
use std::path::PathBuf;
pub const PROTOCOL: &str = "QQMusicGUI/IsolatedSmoke/v2";

/// Exercise the same compiled authority that WebView invokes pass through.
/// Provider business methods remain exclusive to the local main window.
pub fn provider_acl_report(
    authority: &tauri::ipc::RuntimeAuthority,
) -> Result<serde_json::Value, String> {
    use tauri::ipc::Origin;
    let remote = Origin::Remote {
        url: "https://example.invalid/".parse().unwrap(),
    };
    let commands = [
        "provider_status",
        "provider_login",
        "provider_poll",
        "provider_cancel",
        "provider_restore",
        "provider_check",
        "provider_logout",
        "provider_read",
        "provider_write",
        "provider_verify_write",
        "provider_likes",
    ];
    for command in commands {
        if authority
            .resolve_access(command, "main", "main", &Origin::Local)
            .is_none()
        {
            return Err(format!("{command}: local main denied by compiled ACL"));
        }
        if authority
            .resolve_access(command, "tray-menu", "tray-menu", &Origin::Local)
            .is_some()
            || authority
                .resolve_access(command, "main", "main", &remote)
                .is_some()
        {
            return Err(format!("{command}: non-main or remote access allowed"));
        }
    }
    Ok(
        serde_json::json!({"commands":commands,"mainAllowed":true,"trayDenied":true,"remoteDenied":true}),
    )
}

#[cfg(windows)]
fn provider_ipc_report(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody, InvokeResponse},
        webview::InvokeRequest,
        Manager,
    };
    fn invoke(
        app: &tauri::AppHandle,
        window: &str,
        command: &str,
        payload: Value,
        remote: bool,
    ) -> Result<InvokeResponse, String> {
        let webview = app
            .get_webview_window(window)
            .ok_or("smoke webview missing")?;
        let url = if remote {
            "https://example.invalid/".parse().unwrap()
        } else {
            webview.url().map_err(|e| e.to_string())?
        };
        let (send, recv) = std::sync::mpsc::channel();
        webview.on_message(
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: InvokeBody::Json(payload),
                headers: Default::default(),
                invoke_key: app.invoke_key().to_owned(),
            },
            Box::new(move |_, _, response, _, _| {
                let _ = send.send(response);
            }),
        );
        recv.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "smoke IPC response timed out".into())
    }
    for id in ["qqmusic", "netease", "bilibili"] {
        let response = invoke(
            app,
            "main",
            "provider_status",
            json!({"providerId":id}),
            false,
        )?;
        let InvokeResponse::Ok(body) = response else {
            return Err(format!("{id}: main provider_status rejected"));
        };
        let value: Value = body.deserialize().map_err(|e| e.to_string())?;
        if value["providerId"] != id || value["state"] != "disabled" {
            return Err(format!("{id}: unexpected isolated status"));
        }
    }
    // QQ is deliberately invalid for this new-source login command. Reaching
    // its real handler proves ACL passage without creating a QR/network call.
    match invoke(
        app,
        "main",
        "provider_login",
        json!({"providerId":"qqmusic"}),
        false,
    )? {
        InvokeResponse::Err(error) if error.0 == "unsupported_capability" => (),
        _ => return Err("main provider_login did not reach its scoped handler".into()),
    }
    for (window, remote) in [("tray-menu", false), ("main", true)] {
        match invoke(
            app,
            window,
            "provider_login",
            json!({"providerId":"qqmusic"}),
            remote,
        )? {
            InvokeResponse::Err(error)
                if error.0.as_str().is_some_and(|s| s.contains("not allowed")) =>
            {
                ()
            }
            _ => return Err("non-main or remote login was not rejected by ACL".into()),
        }
    }
    Ok(
        json!({"mainStatusProviders":3,"mainLoginReachedHandler":true,"trayDenied":true,"remoteDenied":true,"noQrOrNetworkRequested":true}),
    )
}
pub fn active() -> bool {
    std::env::args_os().any(|arg| arg == "--release-smoke")
}
pub fn data_directory() -> Option<PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .join(".release-smoke/data"),
    )
}
pub struct NoCredentials;
impl CredentialStore for NoCredentials {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        Ok(None)
    }
    fn replace(&self, _secret: &SecretBlob) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
    fn delete(&self) -> Result<(), CredentialError> {
        Ok(())
    }
}
/// The isolated package check exercises the production registry without opening
/// the current user's DPAPI files, even when that user already has an account.
pub struct EmptyProviderStore;
impl crate::multi_provider::secrets::Store for EmptyProviderStore {
    fn read(
        &self,
    ) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, crate::multi_provider::protocol::Error> {
        Ok(None)
    }
    fn prepare(
        &self,
        _bytes: &[u8],
    ) -> Result<
        Box<dyn crate::multi_provider::secrets::Prepared>,
        crate::multi_provider::protocol::Error,
    > {
        Err(crate::multi_provider::protocol::Error::Storage)
    }
    fn delete(&self) -> Result<(), crate::multi_provider::protocol::Error> {
        Ok(())
    }
}

#[cfg(windows)]
fn phase(value: &str) {
    if let Some(dir) = data_directory() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("phase.txt"), value);
    }
}

/// Only the explicitly requested system handshake is sent; no account or
/// business method can reach a network backend. EOF terminates each owned child.
#[cfg(windows)]
fn exchange(
    launch: &crate::provider::ProviderLaunch,
    request: serde_json::Value,
) -> Result<(bool, Vec<u8>), String> {
    use std::os::windows::process::CommandExt;
    use std::{
        io::{Read, Write},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = &launch.current_dir {
        command.current_dir(dir);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("stdout missing")?;
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(2 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let sent = (|| -> Result<(), std::io::Error> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("stdin missing"))?;
        serde_json::to_writer(&mut stdin, &request)?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    })();
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if sent.is_err() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output.join();
            return Err("owned handshake child failed or timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let bytes = output
        .join()
        .map_err(|_| "stdout reader failed")?
        .map_err(|e| e.to_string())?;
    Ok((status.success(), bytes))
}

#[cfg(windows)]
fn packaged_handshakes(root: &std::path::Path) -> Result<serde_json::Value, String> {
    use crate::{
        multi_provider::{self as mp, client::Client, protocol},
        provider::{
            HandshakeInfo, ProviderSupervisor, SupervisorConfig, V1Capabilities,
            VerifiedProviderBundle,
        },
    };
    use serde_json::{json, Value};
    let mut checks = Vec::new();
    for id in [
        mp::OnlineProviderId::Netease,
        mp::OnlineProviderId::Bilibili,
    ] {
        let registration = if id == mp::OnlineProviderId::Netease {
            mp::netease::registration(root, &root.join("node/node.exe"))
        } else {
            mp::bilibili::registration(root, &root.join("node/node.exe"))
        }
        .map_err(|e| format!("registration: {e:?}"))?;
        let request = json!({"v":2,"id":"stage-g-handshake","method":"system.handshake","params":{"providerId":protocol::name(id),"protocolVersion":2}});
        let (success, bytes) = exchange(&registration.launch, request.clone())?;
        let mut reader = std::io::Cursor::new(&bytes);
        let reply = protocol::read(&mut reader)
            .map_err(|e| format!("NDJSON: {e:?}"))?
            .ok_or("missing handshake")?;
        if !success
            || reader.position() as usize != bytes.len()
            || reply["ok"] != true
            || reply["id"] != "stage-g-handshake"
        {
            return Err("handshake stdout was not exactly one success frame".into());
        }
        protocol::response(id, "system.handshake", &request["params"], &reply)
            .map_err(|e| format!("response: {e:?}"))?;
        protocol::handshake(
            id,
            &registration.version,
            &registration.methods,
            &registration.capabilities,
            &reply["result"],
        )
        .map_err(|e| format!("identity: {e:?}"))?;
        for key in ["name", "version"] {
            let mut bad = reply["result"].clone();
            bad["provider"][key] = json!("stage-g-wrong");
            if protocol::handshake(
                id,
                &registration.version,
                &registration.methods,
                &registration.capabilities,
                &bad,
            )
            .is_ok()
            {
                return Err(format!("host accepted wrong {key}"));
            }
        }
        for (key, wrong) in [
            ("providerId", json!("wrong-provider")),
            ("protocolVersion", json!(99)),
        ] {
            let mut bad = request.clone();
            bad["params"][key] = wrong;
            let (accepted, output) = exchange(&registration.launch, bad)?;
            if accepted || !output.is_empty() {
                return Err(format!("provider accepted bad handshake {key}"));
            }
        }
        let (client, _) =
            Client::start(registration.clone()).map_err(|e| format!("production client: {e:?}"))?;
        let ping = client
            .request("system.ping", json!({}))
            .map_err(|e| format!("ping: {e:?}"))?;
        client.stop();
        drop(client);
        if ping["ok"] != true {
            return Err("ping failed".into());
        }
        let mut bad_version = registration;
        bad_version.version = "stage-g-wrong".into();
        if Client::start(bad_version).is_ok() {
            return Err("client accepted unexpected version".into());
        }
        checks.push(json!({"providerId":protocol::name(id),"protocolVersion":2,"handshake":true,"strictStdout":true,"productionClientPing":true,"wrongNameRejected":true,"wrongVersionRejected":true,"wrongHandshakeRequestRejected":true}));
    }
    let bundle =
        VerifiedProviderBundle::verify(root.join("provider")).map_err(|e| e.to_string())?;
    let device = crate::device_identity::ProviderDevicePath::prepare(
        &data_directory().ok_or("isolated device root missing")?,
    )
    .map_err(|e| format!("isolated device: {e:?}"))?;
    let launch = bundle
        .launch_with_device_path(&device)
        .map_err(|e| e.to_string())?;
    let request =
        json!({"v":1,"id":"stage-g-qq","method":"system.handshake","params":{"protocolVersion":1}});
    let (success, bytes) = exchange(&launch, request.clone())?;
    let reply: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !success
        || bytes.iter().filter(|b| **b == b'\n').count() != 1
        || reply["ok"] != true
        || reply["v"] != 1
        || reply["id"] != "stage-g-qq"
        || reply["result"]["protocol"]["version"] != 1
        || reply["result"]["provider"]["name"] != "qqmusic-provider"
        || reply["result"]["provider"]["version"] != "0.1.0"
        || reply["result"]["provider"]["mode"] != "live"
    {
        return Err("QQ handshake identity or stdout invalid".into());
    }
    let result = &reply["result"];
    let strings = |value: &Value| -> Result<Vec<String>, String> {
        value
            .as_array()
            .ok_or("expected string array")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or("expected string".into())
            })
            .collect()
    };
    let expected = HandshakeInfo {
        provider_name: "qqmusic-provider".into(),
        provider_version: "0.1.0".into(),
        provider_mode: "live".into(),
        implemented_methods: strings(&result["implementedMethods"])?,
        capabilities: V1Capabilities {
            auth_methods: strings(&result["capabilities"]["authMethods"])?,
            search_types: strings(&result["capabilities"]["searchTypes"])?,
            recommend_modules: strings(&result["capabilities"]["recommendModules"])?,
            playlist_writes: strings(&result["capabilities"]["playlistWrites"])?,
            lyric_variants: strings(&result["capabilities"]["lyricVariants"])?,
            quality_candidates: strings(&result["capabilities"]["qualityCandidates"])?,
        },
    };
    let config = SupervisorConfig {
        max_restarts: 0,
        ..Default::default()
    };
    let host = ProviderSupervisor::start(
        launch.clone().expect_handshake(expected.clone()),
        config.clone(),
    )
    .map_err(|e| e.to_string())?;
    host.stop();
    drop(host);
    for key in ["name", "version"] {
        let mut bad = expected.clone();
        if key == "name" {
            bad.provider_name = "stage-g-wrong".into();
        } else {
            bad.provider_version = "stage-g-wrong".into();
        }
        if ProviderSupervisor::start(launch.clone().expect_handshake(bad), config.clone()).is_ok() {
            return Err(format!("QQ host accepted wrong {key}"));
        }
    }
    let mut bad = request;
    bad["params"]["protocolVersion"] = json!(99);
    let (accepted, _) = exchange(&launch, bad)?;
    if accepted {
        return Err("QQ accepted wrong protocol version".into());
    }
    checks.push(json!({"providerId":"qqmusic","protocolVersion":1,"handshake":true,"strictStdout":true,"wrongNameRejected":true,"wrongVersionRejected":true,"wrongHandshakeRequestRejected":true}));
    Ok(json!(checks))
}

/// Construct only synthetic legacy data, then migrate a copy with this exact
/// packaged executable. The synthetic source and sidecar must remain unchanged.
#[cfg(windows)]
fn schema11_round_trip(root: &std::path::Path) -> Result<serde_json::Value, String> {
    use crate::{
        persistence::{PersistedTrack, PersistenceService},
        personal::StoredQueue,
        queue::{QueueService, QueueTrack},
        smart_shuffle::SmartShuffle,
    };
    use rusqlite::Connection;
    use serde_json::json;
    let source = root.join("compat-source");
    let copy = root.join("compat-copy");
    std::fs::create_dir(&source).map_err(|e| e.to_string())?;
    std::fs::create_dir(&copy).map_err(|e| e.to_string())?;
    let database = source.join("state.sqlite3");
    let sidecar = source.join("smart-shuffle.sqlite3");
    let ids = [
        "SyntheticQQMID".to_owned(),
        format!("local_{}_mp3", "a".repeat(64)),
    ];
    let tracks: Vec<_> = ids
        .iter()
        .map(|id| PersistedTrack {
            video: None,
            track_id: id.clone(),
            media_mid: None,
            title: format!("Synthetic {id}"),
            artist: "Synthetic Artist".into(),
            album: "Synthetic Album".into(),
            duration_ms: 12345,
            cover_cache_key: None,
        })
        .collect();
    let persisted = PersistenceService::open(&database).map_err(|e| format!("seed: {e:?}"))?;
    persisted
        .replace_queue_selected(&tracks, Some(&ids[1]))
        .map_err(|e| format!("queue seed: {e:?}"))?;
    for track in &tracks {
        persisted
            .append_history(track, false)
            .map_err(|e| format!("history seed: {e:?}"))?;
    }
    persisted
        .save_named_queue(
            "Synthetic saved queue",
            &StoredQueue {
                items: tracks.iter().cloned().map(QueueTrack::from).collect(),
                selected_index: Some(1),
                saved_at_ms: 42,
            },
        )
        .map_err(|e| format!("personal seed: {e:?}"))?;
    let before_history = serde_json::to_value(
        persisted
            .load_playback_history()
            .map_err(|e| format!("history: {e:?}"))?,
    )
    .map_err(|e| e.to_string())?;
    let before_personal = persisted
        .personal_collections()
        .map_err(|e| format!("collections: {e:?}"))?;
    let mut shuffle = SmartShuffle::new(sidecar.clone());
    shuffle
        .set_enabled(true, &[(ids[0].clone(), 42), (ids[1].clone(), 84)], None)
        .map_err(|_| "sidecar seed")?;
    drop(shuffle);
    drop(persisted);
    let legacy = Connection::open(&database).map_err(|e| e.to_string())?;
    legacy.execute_batch("ALTER TABLE queue_items DROP COLUMN video_json; ALTER TABLE playback_history DROP COLUMN video_json; DROP TABLE video_part_metadata; PRAGMA user_version=11; PRAGMA wal_checkpoint(TRUNCATE);").map_err(|e| e.to_string())?;
    drop(legacy);
    let original = std::fs::read(&database).map_err(|e| e.to_string())?;
    let original_sidecar = std::fs::read(&sidecar).map_err(|e| e.to_string())?;
    std::fs::copy(&database, copy.join("state.sqlite3")).map_err(|e| e.to_string())?;
    std::fs::copy(&sidecar, copy.join("smart-shuffle.sqlite3")).map_err(|e| e.to_string())?;
    let migrated = PersistenceService::open(&copy.join("state.sqlite3"))
        .map_err(|e| format!("migration: {e:?}"))?;
    if migrated
        .schema_version()
        .map_err(|e| format!("schema: {e:?}"))?
        != 12
        || migrated.load_queue().map_err(|e| format!("queue: {e:?}"))? != tracks
        || serde_json::to_value(
            migrated
                .load_playback_history()
                .map_err(|e| format!("history: {e:?}"))?,
        )
        .map_err(|e| e.to_string())?
            != before_history
        || migrated
            .personal_collections()
            .map_err(|e| format!("personal: {e:?}"))?
            != before_personal
    {
        return Err("legacy queue/history/collections changed".into());
    }
    let saved = migrated
        .load_named_queue(Some("Synthetic saved queue"))
        .map_err(|e| format!("saved queue: {e:?}"))?;
    if saved.items.iter().map(|t| &t.id).collect::<Vec<_>>() != ids.iter().collect::<Vec<_>>()
        || saved.selected_index != Some(1)
        || saved.saved_at_ms != 42
    {
        return Err("legacy personal payload changed".into());
    }
    let queue = QueueService::open(&copy.join("state.sqlite3"))
        .map_err(|e| format!("queue service: {e:?}"))?;
    if queue.snapshot().selected_index != Some(1) {
        return Err("legacy queue selection changed".into());
    }
    let shuffle = SmartShuffle::new(copy.join("smart-shuffle.sqlite3"));
    if !shuffle.status().enabled {
        return Err("legacy sidecar preference lost".into());
    }
    drop(shuffle);
    let connection =
        Connection::open(copy.join("smart-shuffle.sqlite3")).map_err(|e| e.to_string())?;
    for (id, expected) in [(&ids[0], 42_i64), (&ids[1], 84)] {
        let actual: i64 = connection
            .query_row(
                "SELECT last_played_ms FROM listening_stats WHERE track_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if actual != expected {
            return Err("legacy sidecar listening data changed".into());
        }
    }
    if std::fs::read(&database).map_err(|e| e.to_string())? != original
        || std::fs::read(&sidecar).map_err(|e| e.to_string())? != original_sidecar
    {
        return Err("synthetic legacy source changed".into());
    }
    Ok(
        json!({"sourceSchema":11,"resultSchema":12,"queue":true,"history":true,"privateCollections":true,"legacyQqAndLocalIds":true,"queueSelection":true,"sidecar":true,"sourceUnchanged":true,"syntheticOnly":true}),
    )
}
#[cfg(windows)]
pub fn schedule(app: tauri::AppHandle, compiled_acl: Result<serde_json::Value, String>) {
    use tauri::Manager;
    std::thread::spawn(move || {
        phase("unauthenticated");
        std::thread::sleep(std::time::Duration::from_secs(5));
        let state = app.state::<crate::AppState>();
        let queue_ok = state.queue.as_ref().is_some_and(|queue| {
            if !queue.snapshot().items.is_empty() {
                return false;
            }
            let track = crate::queue::QueueTrack {
                video: None,
                id: "release_smoke_track".into(),
                media_mid: None,
                title: "发行检查".into(),
                artist: "检查".into(),
                album: String::new(),
                duration_ms: 1000,
                cover_cache_key: None,
            };
            queue.enqueue(track).is_ok_and(|q| q.items.len() == 1)
                && queue.remove(0).is_ok_and(|q| q.items.is_empty())
        });
        let settings_ok = state
            .persistence
            .as_ref()
            .is_some_and(|p| p.load_settings().is_ok_and(|s| p.save_settings(&s).is_ok()));
        let local_ok = state
            .local_music
            .as_ref()
            .is_some_and(|s| s.list().is_ok_and(|l| l.tracks.is_empty()));
        let qq_not_started = state.provider.as_ref().is_some_and(|provider| {
            serde_json::to_value(provider.snapshot())
                .is_ok_and(|value| value["state"] == "notStarted")
        });
        let providers_disabled = [
            crate::multi_provider::OnlineProviderId::Qqmusic,
            crate::multi_provider::OnlineProviderId::Netease,
            crate::multi_provider::OnlineProviderId::Bilibili,
        ]
        .into_iter()
        .all(|id| {
            state
                .registry
                .snapshot(id)
                .ok()
                .and_then(|s| serde_json::to_value(s).ok())
                .is_some_and(|v| v["state"] == "disabled")
        });
        // QqHost is lazy in multi-provider builds. A transport-ready process here
        // would violate the fresh-data/no-account boundary.
        let provider_idle = qq_not_started && providers_disabled;
        phase("provider-ipc");
        let provider_ipc = provider_ipc_report(&app);
        phase("handshakes");
        let root = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
        let handshakes = root
            .as_deref()
            .ok_or_else(|| "package root unavailable".to_owned())
            .and_then(packaged_handshakes);
        phase("compatibility");
        let compatibility = data_directory()
            .ok_or_else(|| "smoke data unavailable".to_owned())
            .and_then(|dir| schema11_round_trip(&dir));
        let passed = queue_ok
            && settings_ok
            && local_ok
            && provider_idle
            && compiled_acl.is_ok()
            && provider_ipc.is_ok()
            && handshakes.is_ok()
            && compatibility.is_ok()
            && state.playback_session.is_some()
            && state.updates.is_some();
        let report = serde_json::json!({"protocol":PROTOCOL,"passed":passed,"version":env!("CARGO_PKG_VERSION"),"channel":if cfg!(debug_assertions){"Debug"}else{"Release"},"instanceIdentifier":app.config().identifier,"providerAcl":compiled_acl,"providerIpc":provider_ipc,"providersDisabledWithoutCredentials":provider_idle,"handshakes":handshakes,"schema11Compatibility":compatibility,"playbackSessionReady":state.playback_session.is_some(),"queueRoundTrip":queue_ok,"settingsRoundTrip":settings_ok,"localLibraryRead":local_ok,"updatesReady":state.updates.is_some(),"isolatedData":true,"accountCredentialsAccessed":false});
        phase("complete");
        let saved = data_directory()
            .and_then(|dir| {
                std::fs::create_dir_all(&dir).ok()?;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join("result.json"))
                    .ok()?;
                use std::io::Write;
                file.write_all(serde_json::to_string_pretty(&report).ok()?.as_bytes())
                    .ok()?;
                file.sync_all().ok()?;
                Some(())
            })
            .is_some();
        app.exit(if passed && saved { 0 } else { 1 });
    });
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn provider_commands_pass_compiled_main_acl_and_reject_other_origins() {
        let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        super::provider_acl_report(context.runtime_authority_mut()).expect("desktop Provider ACL");
    }
}
