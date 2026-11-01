//! Lazy v1 adapter. QQ's payload and Credential Manager format stay private v1.
use super::{
    lifecycle::{Lifecycle, Persistence, Phase, StartIntent},
    protocol::Error,
    secrets::{credential_bytes, CoordinatedStore, QqStore},
    ErrorCode, OnlineProviderId, ProviderAccount,
};
use crate::{
    auth::{AuthError, PublicAccount, RecoveryState},
    credentials::{CredentialError, CredentialStore, SecretBlob},
    provider::{
        ProviderError, ProviderEvent, ProviderLaunch, ProviderRecoveryHook, ProviderRecoveryPort,
        ProviderReply, ProviderRequest, ProviderRequestPort, ProviderSnapshot, ProviderSupervisor,
        SupervisorConfig,
    },
};
use serde_json::Value;
use std::sync::{
    mpsc::{self, Receiver, Sender},
    Arc, Mutex, Weak,
};
struct State {
    lifecycle: Lifecycle,
    process: Option<Arc<ProviderSupervisor>>,
    session: Option<String>,
    account: Option<PublicAccount>,
    child_generation: u64,
    accepting: bool,
    failed_stop: Option<u64>,
    deletions: usize,
}
pub struct QqEvent {
    pub generation: u64,
    pub event: ProviderEvent,
}
pub struct QqHost {
    launch: ProviderLaunch,
    config: SupervisorConfig,
    state: Mutex<State>,
    secrets: CoordinatedStore,
    events: Mutex<Vec<Sender<QqEvent>>>,
    weak: Weak<QqHost>,
    startup: Mutex<()>,
    invalidator: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
impl QqHost {
    pub fn new(launch: ProviderLaunch, store: Arc<dyn CredentialStore>) -> Arc<Self> {
        use crate::provider::{HandshakeInfo, V1Capabilities};
        let strings = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect();
        let expected = HandshakeInfo {
            provider_name: "qqmusic-provider".into(),
            provider_version: "0.1.0".into(),
            provider_mode: "live".into(),
            implemented_methods: strings(&[
                "system.handshake",
                "system.ping",
                "auth.qr.start",
                "auth.qr.poll",
                "auth.qr.cancel",
                "auth.credential.restore",
                "auth.credential.check",
                "auth.credential.refresh",
                "auth.logout",
                "search.songs",
                "playback.resolve",
                "search.hotkeys",
                "search.complete",
                "search.artists",
                "search.albums",
                "search.playlists",
                "recommend.guess",
                "recommend.radar",
                "recommend.newSongs",
                "recommend.playlists",
                "charts.list",
                "charts.detail",
                "song.detail",
                "playlist.detail",
                "album.detail",
                "album.songs",
                "artist.detail",
                "artist.songs",
                "artist.albums",
                "lyrics.get",
                "library.playlists",
                "library.liked",
                "playlist.create",
                "playlist.delete",
                "playlist.addSongs",
                "playlist.removeSongs",
                "song.like",
                "song.unlike",
                "playlist.favorite",
                "playlist.unfavorite",
            ]),
            capabilities: V1Capabilities {
                auth_methods: strings(&["qq", "wx"]),
                search_types: strings(&["songs", "artists", "albums", "playlists"]),
                recommend_modules: strings(&["guess", "radar", "newSongs", "playlists", "charts"]),
                playlist_writes: strings(&[
                    "create",
                    "delete",
                    "addSongs",
                    "removeSongs",
                    "likeSong",
                    "unlikeSong",
                    "favoritePlaylist",
                    "unfavoritePlaylist",
                ]),
                lyric_variants: strings(&["original", "translation", "romanization"]),
                quality_candidates: strings(&["flac", "320k", "128k"]),
            },
        };
        Self::with_config(
            launch.expect_handshake(expected),
            store,
            SupervisorConfig::default(),
        )
    }
    pub fn with_config(
        launch: ProviderLaunch,
        store: Arc<dyn CredentialStore>,
        config: SupervisorConfig,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            launch,
            config,
            state: Mutex::new(State {
                lifecycle: Lifecycle::new(OnlineProviderId::Qqmusic),
                process: None,
                session: None,
                account: None,
                child_generation: 0,
                accepting: false,
                failed_stop: None,
                deletions: 0,
            }),
            secrets: CoordinatedStore::new(Arc::new(QqStore(store))),
            events: Mutex::new(Vec::new()),
            weak: weak.clone(),
            startup: Mutex::new(()),
            invalidator: Mutex::new(None),
        })
    }
    pub fn snapshot(&self) -> ProviderSnapshot {
        self.state
            .lock()
            .unwrap()
            .process
            .as_ref()
            .map(|p| p.snapshot())
            .unwrap_or_else(ProviderSnapshot::not_started)
    }
    pub fn set_invalidator(&self, f: Arc<dyn Fn() + Send + Sync>) {
        *self.invalidator.lock().unwrap() = Some(f);
    }
    fn invalidate_session(&self) {
        if let Some(f) = self.invalidator.lock().unwrap().clone() {
            f();
        }
    }
    pub fn public_snapshot(&self) -> super::lifecycle::ProviderSnapshot {
        self.state
            .lock()
            .unwrap()
            .lifecycle
            .snapshot(super::ProviderCapabilities::qqmusic())
    }
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().lifecycle.generation()
    }
    pub fn account(&self) -> Option<PublicAccount> {
        let s = self.state.lock().unwrap();
        if s.lifecycle.business_allowed() {
            s.account.clone()
        } else {
            None
        }
    }
    pub fn subscribe_events(&self) -> Result<Receiver<QqEvent>, ProviderError> {
        let (tx, rx) = mpsc::channel();
        self.events.lock().unwrap().push(tx);
        Ok(rx)
    }
    fn start(
        &self,
        intent: StartIntent,
        expected: Option<u64>,
    ) -> Result<Arc<ProviderSupervisor>, ProviderError> {
        let _startup = self.startup.lock().unwrap();
        let (generation, old) = {
            let mut s = self.state.lock().unwrap();
            if expected.is_some_and(|g| g != s.lifecycle.generation()) {
                return Err(ProviderError::Cancelled);
            }
            if s.deletions != 0 {
                return Err(ProviderError::Unavailable);
            }
            if matches!(
                s.lifecycle.phase(),
                Phase::Ready | Phase::Authenticating | Phase::Restoring
            ) {
                if let Some(p) = &s.process {
                    return Ok(p.clone());
                }
            }
            let t = s
                .lifecycle
                .begin(intent, true)
                .map_err(|_| ProviderError::Unavailable)?;
            self.secrets.activate(t.generation);
            s.session = None;
            s.account = None;
            s.accepting = false;
            s.failed_stop = None;
            (t.generation, s.process.take())
        };
        if let Some(p) = old {
            p.stop();
        }
        let process = match ProviderSupervisor::start_with_recovery(
            self.launch.clone(),
            self.config.clone(),
            Arc::new(QqRecovery(self.weak.clone())),
        ) {
            Ok(p) => Arc::new(p),
            Err(e) => {
                self.fail(generation);
                return Err(e);
            }
        };
        let events = process.subscribe_events()?;
        {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || matches!(s.lifecycle.phase(), Phase::Disabled | Phase::Stopping)
            {
                drop(s);
                process.stop();
                return Err(ProviderError::Cancelled);
            }
            s.process = Some(process.clone());
        }
        let weak = self.weak.clone();
        std::thread::spawn(move || {
            for event in events {
                let Some(host) = weak.upgrade() else { return };
                // Supervisor never forwards an old child's frames. Capture the account
                // epoch now, before enqueueing to the asynchronous renderer bridge.
                let generation = {
                    let s = host.state.lock().unwrap();
                    if event.generation != s.child_generation {
                        continue;
                    }
                    s.lifecycle.generation()
                };
                host.events.lock().unwrap().retain(|tx| {
                    tx.send(QqEvent {
                        generation,
                        event: event.clone(),
                    })
                    .is_ok()
                });
            }
            if let Some(host) = weak.upgrade() {
                let failed = {
                    let mut s = host.state.lock().unwrap();
                    s.failed_stop.take().map(|g| (g, s.process.take()))
                };
                if let Some((g, process)) = failed {
                    if let Some(p) = process {
                        p.stop();
                    }
                    host.stopped(g);
                }
            }
        });
        Ok(process)
    }
    pub fn ticket(&self, session: Option<&str>) -> Result<u64, AuthError> {
        let s = self.state.lock().unwrap();
        if !matches!(
            s.lifecycle.phase(),
            Phase::Authenticating | Phase::Restoring | Phase::Ready
        ) || session.is_some_and(|id| s.session.as_deref() != Some(id))
        {
            return Err(AuthError::SessionNotFound);
        }
        Ok(s.lifecycle.generation())
    }
    pub fn accepts(&self, generation: u64, session: &str) -> bool {
        self.ticket(Some(session)) == Ok(generation)
    }
    pub fn accept(
        &self,
        generation: u64,
        session: &str,
        account: PublicAccount,
        credential: &Value,
    ) -> Result<(), AuthError> {
        let result = self.accept_current(generation, session, account, credential);
        if result
            .as_ref()
            .is_err_and(|e| *e != AuthError::SessionNotFound)
        {
            self.fail_when(generation, |phase| {
                matches!(
                    phase,
                    Phase::Starting | Phase::Authenticating | Phase::Restoring
                )
            });
        }
        result
    }
    fn accept_current(
        &self,
        generation: u64,
        session: &str,
        account: PublicAccount,
        credential: &Value,
    ) -> Result<(), AuthError> {
        let public = ProviderAccount {
            provider_id: OnlineProviderId::Qqmusic,
            id: account.music_id.clone(),
            display_name: String::new(),
        };
        {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation || s.session.as_deref() != Some(session) {
                return Err(AuthError::SessionNotFound);
            }
            if s.lifecycle.phase() == Phase::Ready {
                return if s.account.as_ref() == Some(&account) {
                    Ok(())
                } else {
                    Err(AuthError::InvalidResponse)
                };
            }
            if s.lifecycle.phase() != Phase::Authenticating {
                return Err(AuthError::SessionNotFound);
            }
            if s.accepting {
                return Err(AuthError::SessionNotFound);
            }
            s.accepting = true;
            s.lifecycle
                .validate_account(&public)
                .map_err(|_| AuthError::InvalidResponse)?;
        }
        let b = credential_bytes(credential).map_err(|_| AuthError::InvalidResponse)?;
        let prepared = self.secrets.prepare(generation, &b);
        let mut s = self.state.lock().unwrap();
        if s.lifecycle.generation() != generation || s.lifecycle.phase() != Phase::Authenticating {
            return Err(AuthError::SessionNotFound);
        }
        s.lifecycle
            .validate_account(&public)
            .map_err(|_| AuthError::InvalidResponse)?;
        let persistence = match prepared {
            Ok(p) => match self.secrets.commit(generation, p) {
                Ok(()) => Persistence::Saved,
                Err(Error::Stale) => return Err(AuthError::SessionNotFound),
                Err(_) => Persistence::SessionOnly,
            },
            Err(Error::Stale) => return Err(AuthError::SessionNotFound),
            Err(_) => Persistence::SessionOnly,
        };
        s.lifecycle
            .authenticated(generation, public, persistence)
            .map_err(|_| AuthError::InvalidResponse)?;
        s.account = Some(account);
        Ok(())
    }
    pub fn restore(&self) -> Result<RecoveryState, AuthError> {
        let observed = self.state.lock().unwrap().lifecycle.generation();
        if let Some(account) = self.account() {
            return Ok(RecoveryState::Authenticated { account });
        }
        if self
            .secrets
            .read()
            .map_err(|_| AuthError::CredentialUnavailable)?
            .is_none()
        {
            return Ok(RecoveryState::SignedOut);
        }
        self.start(StartIntent::Restore, Some(observed))
            .map_err(|_| AuthError::ProviderUnavailable)?;
        Ok(self
            .account()
            .map(|account| RecoveryState::Authenticated { account })
            .unwrap_or(RecoveryState::SignedOut))
    }
    pub fn refresh(&self) -> Result<RecoveryState, AuthError> {
        let generation = self.ticket(None)?;
        let host = self.weak.upgrade().ok_or(AuthError::ProviderUnavailable)?;
        let store = EpochQqStore { host, generation };
        let result = crate::auth::refresh_credential(&store, &mut |r| self.request(r))?;
        if self.ticket(None) != Ok(generation) {
            return Err(AuthError::SessionNotFound);
        }
        Ok(result)
    }
    pub fn cancel(&self, generation: u64, session: &str) {
        let (stop, next) = {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || s.session.as_deref() != Some(session)
                || s.lifecycle.phase() == Phase::Ready
            {
                return;
            }
            if s.lifecycle.cancel_auth(generation).is_err() {
                return;
            }
            let next = s.lifecycle.generation();
            self.secrets.invalidate(generation, next);
            s.session = None;
            (s.process.take(), next)
        };
        if let Some(p) = stop {
            p.stop();
        }
        self.stopped(next);
    }
    pub fn logout(&self) -> Result<(), AuthError> {
        let (stop, generation) = {
            let mut s = self.state.lock().unwrap();
            let old = s.lifecycle.generation();
            s.lifecycle
                .sign_out()
                .map_err(|_| AuthError::ProviderUnavailable)?;
            s.deletions += 1;
            let next = s.lifecycle.generation();
            self.secrets.invalidate(old, next);
            s.session = None;
            s.account = None;
            s.failed_stop = None;
            (s.process.take(), next)
        };
        let _startup = self.startup.lock().unwrap();
        let deleted = self
            .secrets
            .delete(generation)
            .map_err(|_| AuthError::CredentialUnavailable);
        if let Some(p) = stop {
            p.stop();
        }
        {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() == generation {
                s.deletions -= 1;
            }
        }
        self.stopped(generation);
        deleted
    }
    pub fn shutdown(&self) {
        let (stop, next) = {
            let mut s = self.state.lock().unwrap();
            let old = s.lifecycle.generation();
            let _ = s.lifecycle.shutdown();
            let next = s.lifecycle.generation();
            self.secrets.invalidate(old, next);
            (s.process.take(), next)
        };
        let _startup = self.startup.lock().unwrap();
        if let Some(p) = stop {
            p.stop();
        }
        self.stopped(next);
    }
    fn stopped(&self, g: u64) {
        let mut s = self.state.lock().unwrap();
        if s.lifecycle.generation() == g
            && s.lifecycle.phase() == Phase::Stopping
            && s.deletions == 0
        {
            self.invalidate_session();
            let _ = s.lifecycle.stopped(g);
        }
    }
    fn fail(&self, g: u64) {
        self.fail_when(g, |_| true);
    }
    fn fail_when(&self, g: u64, predicate: impl FnOnce(Phase) -> bool) {
        let (stop, next) = {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != g
                || matches!(s.lifecycle.phase(), Phase::Stopping | Phase::Disabled)
                || !predicate(s.lifecycle.phase())
            {
                return;
            }
            let _ = s.lifecycle.fail(g, ErrorCode::ProviderUnavailable);
            let next = s.lifecycle.generation();
            self.secrets.invalidate(g, next);
            s.account = None;
            s.accepting = false;
            (s.process.take(), next)
        };
        if let Some(p) = stop {
            p.stop();
        }
        self.stopped(next);
    }
}
impl ProviderRequestPort for QqHost {
    fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        let method = request.method();
        let auth = method.starts_with("auth.");
        let process = if method == "auth.qr.start" {
            self.start(StartIntent::Login, None)?
        } else {
            let s = self.state.lock().unwrap();
            if !auth && !s.lifecycle.business_allowed() {
                return Ok(ProviderReply::Failure {
                    code: "authentication_required".into(),
                    retryable: false,
                });
            }
            s.process.clone().ok_or(ProviderError::Unavailable)?
        };
        let generation = {
            let s = self.state.lock().unwrap();
            if !s.process.as_ref().is_some_and(|p| Arc::ptr_eq(p, &process)) {
                return Err(ProviderError::Cancelled);
            }
            s.lifecycle.generation()
        };
        let reply = process.request(request.clone());
        if self.state.lock().unwrap().lifecycle.generation() != generation {
            return Err(ProviderError::Cancelled);
        }
        if method == "auth.qr.start" {
            if let Ok(ProviderReply::Success { result, .. }) = &reply {
                let mut s = self.state.lock().unwrap();
                if s.lifecycle.generation() != generation {
                    return Err(ProviderError::Cancelled);
                }
                s.session = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
        }
        if reply.is_err() {
            self.fail(generation);
        }
        if let Ok(ProviderReply::Failure { code, .. }) = &reply {
            let invalid = matches!(
                code.as_str(),
                "credential_invalid" | "authentication_required"
            );
            self.fail_when(generation, |phase| {
                invalid || (auth && phase != Phase::Ready)
            });
        }
        reply
    }
}
impl Drop for QqHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct QqRecovery(Weak<QqHost>);
impl ProviderRecoveryHook for QqRecovery {
    fn allow_replay(&self) -> bool {
        false
    }
    fn recover(
        &self,
        child_generation: u64,
        provider: &mut dyn ProviderRecoveryPort,
    ) -> Result<(), ProviderError> {
        let host = self.0.upgrade().ok_or(ProviderError::SupervisorStopped)?;
        let generation = {
            let mut s = host.state.lock().unwrap();
            if matches!(s.lifecycle.phase(), Phase::Disabled | Phase::Stopping) {
                return Err(ProviderError::SupervisorStopped);
            }
            s.child_generation = child_generation;
            if child_generation > 1 {
                let old = s.lifecycle.generation();
                let _ = s.lifecycle.fail(old, ErrorCode::ProviderUnavailable);
                let stopped = s.lifecycle.generation();
                let _ = s.lifecycle.stopped(stopped);
                s.lifecycle
                    .begin(StartIntent::Restore, true)
                    .map_err(|_| ProviderError::Unavailable)?;
                host.secrets.invalidate(old, s.lifecycle.generation());
                host.secrets.activate(s.lifecycle.generation());
                host.invalidate_session();
                s.session = None;
                s.account = None;
            }
            let g = s.lifecycle.generation();
            if s.lifecycle.phase() == Phase::Starting {
                s.lifecycle
                    .started(g)
                    .map_err(|_| ProviderError::Unavailable)?;
            }
            if s.lifecycle.phase() == Phase::Authenticating {
                return Ok(());
            }
            g
        };
        let store = EpochQqStore {
            host: host.clone(),
            generation,
        };
        let state = crate::auth::recover_credential(&store, &mut |r| provider.request(r));
        let mut s = host.state.lock().unwrap();
        if s.lifecycle.generation() != generation || s.lifecycle.phase() != Phase::Restoring {
            return Err(ProviderError::Cancelled);
        }
        match state {
            Ok(RecoveryState::Authenticated { account }) => {
                s.lifecycle
                    .authenticated(
                        generation,
                        ProviderAccount {
                            provider_id: OnlineProviderId::Qqmusic,
                            id: account.music_id.clone(),
                            display_name: String::new(),
                        },
                        Persistence::Saved,
                    )
                    .map_err(|_| ProviderError::Unavailable)?;
                s.account = Some(account);
                Ok(())
            }
            _ => {
                if child_generation == 1 {
                    return Err(ProviderError::Unavailable);
                }
                let _ = s.lifecycle.fail(generation, ErrorCode::ProviderUnavailable);
                host.secrets
                    .invalidate(generation, s.lifecycle.generation());
                s.account = None;
                s.failed_stop = Some(s.lifecycle.generation());
                if let Some(p) = &s.process {
                    p.request_stop();
                }
                Err(ProviderError::Unavailable)
            }
        }
    }
}
struct EpochQqStore {
    host: Arc<QqHost>,
    generation: u64,
}
impl CredentialStore for EpochQqStore {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        self.host
            .secrets
            .read()
            .map_err(|_| CredentialError::Unavailable)?
            .map(|b| SecretBlob::new(b.to_vec()))
            .transpose()
    }
    fn replace(&self, s: &SecretBlob) -> Result<(), CredentialError> {
        self.host
            .secrets
            .save(self.generation, s.payload())
            .map_err(|_| CredentialError::Unavailable)
    }
    // Recovery never deletes saved credentials. Only explicit, coordinated logout does.
    fn delete(&self) -> Result<(), CredentialError> {
        Ok(())
    }
}
