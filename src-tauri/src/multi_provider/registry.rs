//! Account/process ownership. A transport handshake never grants business access.
use super::{
    client::{Client, Registration},
    lifecycle::{Lifecycle, Persistence, Phase, ProviderSnapshot, StartIntent},
    protocol::{self, Error},
    secrets::{credential_bytes, CoordinatedStore, Store},
    ErrorCode, OnlineProviderId, ProviderAccount,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};

struct State {
    lifecycle: Lifecycle,
    client: Option<Arc<Client>>,
    qr: Option<String>,
    cooldown: Option<Instant>,
    accepting: bool,
    deletions: usize,
    write_targets: HashSet<(u64, String)>,
    likes: Option<(u64, HashSet<String>)>,
    likes_version: u64,
    unresolved_writes: HashMap<(u64,String),String>,
}
impl State {
    fn clear_business_cache(&mut self) {
        self.likes=None;self.likes_version=self.likes_version.wrapping_add(1);
        self.write_targets.clear();self.unresolved_writes.clear();
    }
}
struct Slot {
    registration: Registration,
    state: Mutex<State>,
    secrets: CoordinatedStore,
    startup: Mutex<()>,
}
pub struct ProviderRegistry {
    slots: HashMap<OnlineProviderId, Arc<Slot>>,
    qq: Option<Arc<super::qq::QqHost>>,
}
pub struct WriteLease<'a> { registry: &'a ProviderRegistry, id: OnlineProviderId, pub generation: u64, key: String }
impl Drop for WriteLease<'_> {
    fn drop(&mut self) { if let Ok(slot)=self.registry.slot(self.id) { slot.state.lock().unwrap().write_targets.remove(&(self.generation,self.key.clone())); } }
}
impl Default for ProviderRegistry {
    fn default() -> Self {
        Self {
            slots: HashMap::new(),
            qq: None,
        }
    }
}
impl ProviderRegistry {
    pub fn attach_qq(&mut self, host: Arc<super::qq::QqHost>) {
        self.qq = Some(host);
    }
    pub fn register(
        &mut self,
        registration: Registration,
        store: Arc<dyn Store>,
    ) -> Result<(), Error> {
        registration.validate()?;
        let id = registration.provider;
        if id == OnlineProviderId::Qqmusic
            || self.slots.contains_key(&id)
            || registration.config.max_restarts != 0
        {
            return Err(Error::Context);
        }
        self.slots.insert(
            id,
            Arc::new(Slot {
                registration,
                state: Mutex::new(State {
                    lifecycle: Lifecycle::new(id),
                    client: None,
                    qr: None,
                    cooldown: None,
                    accepting: false,
                    deletions: 0,
                    write_targets: HashSet::new(),
                    likes: None,
                    likes_version: 0,
                    unresolved_writes: HashMap::new(),
                }),
                secrets: CoordinatedStore::new(store),
                startup: Mutex::new(()),
            }),
        );
        Ok(())
    }
    pub fn register_dpapi(
        &mut self,
        registration: Registration,
        app_data: std::path::PathBuf,
    ) -> Result<(), Error> {
        let store = super::secrets::DpapiStore::new(app_data, registration.provider)?;
        self.register(registration, Arc::new(store))
    }
    fn slot(&self, id: OnlineProviderId) -> Result<&Arc<Slot>, Error> {
        self.slots.get(&id).ok_or(Error::Unavailable)
    }
    pub fn snapshot(&self, id: OnlineProviderId) -> Result<ProviderSnapshot, Error> {
        if id == OnlineProviderId::Qqmusic {
            return self
                .qq
                .as_ref()
                .map(|q| q.public_snapshot())
                .ok_or(Error::Unavailable);
        }
        let slot = self.slot(id)?;
        slot.observe_exit()?;
        let s = slot.state.lock().unwrap();
        let mut snapshot = s.lifecycle.snapshot(slot.registration.capabilities.clone());
        if let super::lifecycle::PublicStatus::Disabled { retry_after_ms, .. } =
            &mut snapshot.status
        {
            *retry_after_ms = s.cooldown.filter(|t| *t > Instant::now()).map(|t| {
                t.saturating_duration_since(Instant::now())
                    .as_millis()
                    .min(86400000) as u64
            });
        }
        Ok(snapshot)
    }
    pub fn generation(&self, id: OnlineProviderId) -> Result<u64, Error> {
        if id == OnlineProviderId::Qqmusic {
            return self
                .qq
                .as_ref()
                .map(|q| q.generation())
                .ok_or(Error::Unavailable);
        }
        Ok(self.slot(id)?.state.lock().unwrap().lifecycle.generation())
    }
    pub fn ready_generation(&self, id: OnlineProviderId) -> Result<u64, Error> {
        if id == OnlineProviderId::Qqmusic {
            let q = self.qq.as_ref().ok_or(Error::Unavailable)?;
            if !matches!(q.public_snapshot().status, super::lifecycle::PublicStatus::Ready { .. }) {
                return Err(Error::Unavailable);
            }
            return Ok(q.generation());
        }
        let slot = self.slot(id)?;
        slot.observe_exit()?;
        let s = slot.state.lock().unwrap();
        if !s.lifecycle.business_allowed() {
            return Err(Error::Unavailable);
        }
        Ok(s.lifecycle.generation())
    }
    pub fn remote_ready(
        &self,
        id: OnlineProviderId,
    ) -> Result<(u64, super::ProviderCapabilities), Error> {
        if !matches!(id, OnlineProviderId::Netease | OnlineProviderId::Bilibili) {
            return Err(Error::Upstream(super::ErrorCode::InvalidParams));
        }
        let slot = self.slot(id)?;
        slot.observe_exit()?;
        let s = slot.state.lock().unwrap();
        if let Some(until) = s.cooldown {
            if Instant::now() < until {
                return Err(Error::Cooldown);
            }
        }
        let snapshot = s.lifecycle.snapshot(slot.registration.capabilities.clone());
        match snapshot.status {
            super::lifecycle::PublicStatus::Ready { .. } => {
                Ok((s.lifecycle.generation(), snapshot.capabilities))
            }
            super::lifecycle::PublicStatus::Restoring
            | super::lifecycle::PublicStatus::Starting
            | super::lifecycle::PublicStatus::Authenticating
            | super::lifecycle::PublicStatus::Stopping => Err(Error::Unavailable),
            super::lifecycle::PublicStatus::Disabled {
                error: Some(code), ..
            } => Err(Error::Upstream(code)),
            super::lifecycle::PublicStatus::Disabled { error: None, .. } => {
                Err(Error::Upstream(super::ErrorCode::AuthenticationRequired))
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn set_restoring_for_test(&self, id: OnlineProviderId) -> Result<u64, Error> {
        let slot = self.slot(id)?;
        let mut s = slot.state.lock().unwrap();
        let t = s
            .lifecycle
            .begin(StartIntent::Restore, true)
            .map_err(|_| Error::Context)?;
        slot.secrets.activate(t.generation);
        s.lifecycle
            .started(t.generation)
            .map_err(|_| Error::Context)?;
        Ok(t.generation)
    }
    pub fn begin_write(&self, id: OnlineProviderId, account: &str, key: String, fingerprint:&str, verify:bool) -> Result<WriteLease<'_>, Error> {
        let slot=self.slot(id)?;slot.observe_exit()?;
        let mut s=slot.state.lock().unwrap();
        let snapshot=s.lifecycle.snapshot(slot.registration.capabilities.clone());
        match snapshot.status {
            super::lifecycle::PublicStatus::Ready { account: current, .. } if current.id==account => (),
            _ => return Err(Error::Stale),
        }
        let generation=s.lifecycle.generation();
        if let Some(previous)=s.unresolved_writes.get(&(generation,key.clone())) {
            if !verify || previous!=fingerprint{return Err(Error::Upstream(ErrorCode::OutcomeUnknown));}
        }
        if !s.write_targets.insert((generation,key.clone())) { return Err(Error::Upstream(ErrorCode::Cancelled)); }
        if key.starts_with("like:") {s.likes_version=s.likes_version.wrapping_add(1);}
        Ok(WriteLease{registry:self,id,generation,key})
    }
    pub fn finish_write(&self,lease:&WriteLease<'_>,fingerprint:String,confirmed:bool) {
        if let Ok(slot)=self.slot(lease.id) {let mut s=slot.state.lock().unwrap();
            if s.lifecycle.generation()!=lease.generation||!s.lifecycle.business_allowed(){return;}
            let key=(lease.generation,lease.key.clone());
            if confirmed{s.unresolved_writes.remove(&key);}else{s.unresolved_writes.insert(key,fingerprint);}
        }
    }
    pub fn cached_netease_likes(&self)->Option<HashSet<String>> {
        let slot=self.slot(OnlineProviderId::Netease).ok()?;slot.observe_exit().ok()?;
        let s=slot.state.lock().unwrap();
        let (g,ids)=s.likes.as_ref()?;
        (s.lifecycle.business_allowed()&&s.lifecycle.generation()==*g).then(||ids.clone())
    }
    pub fn sync_netease_likes(&self)->Result<Value,Error> {
        let id=OnlineProviderId::Netease;let slot=self.slot(id)?;let g=self.ready_generation(id)?;
        let version={let s=slot.state.lock().unwrap();
            if s.write_targets.iter().any(|(epoch,k)|*epoch==g&&k.starts_with("like:")){return Err(Error::Stale);}
            s.likes_version};
        let v=self.request(id,g,"library.likeIds",json!({}))?;
        if v["ok"]!=true{return Err(Error::Upstream(serde_json::from_value(v["error"]["code"].clone()).map_err(|_|Error::Schema)?));}
        let ids:HashSet<String>=v["result"].as_array().ok_or(Error::Schema)?.iter().map(|v|v.as_str().map(|id|format!("netease:track:{id}")).ok_or(Error::Schema)).collect::<Result<_,_>>()?;
        let mut s=slot.state.lock().unwrap();
        if s.lifecycle.generation()!=g||!s.lifecycle.business_allowed()||version!=s.likes_version{return Err(Error::Stale);}
        let account=match s.lifecycle.snapshot(slot.registration.capabilities.clone()).status {super::lifecycle::PublicStatus::Ready{account,..}=>account,_=>return Err(Error::Stale)};
        s.likes=Some((g,ids.clone()));
        s.unresolved_writes.retain(|(epoch,key),fingerprint| {
            if *epoch!=g||!key.starts_with("like:"){return true;}
            let Ok(op)=serde_json::from_str::<Value>(fingerprint) else{return true;};
            let Some(song)=op["params"]["songId"].as_str() else{return true;};
            ids.contains(&format!("netease:track:{song}"))!=op["params"]["liked"].as_bool().unwrap_or(false)
        });
        Ok(json!({"accountId":account.id,"ids":ids}))
    }
    pub fn verified_like(&self,g:u64,track:&str,liked:bool) {
        if let Ok(slot)=self.slot(OnlineProviderId::Netease) {let mut s=slot.state.lock().unwrap();
            if s.lifecycle.business_allowed()&&s.lifecycle.generation()==g {
                s.likes_version=s.likes_version.wrapping_add(1);
                if let Some((epoch,ids))=&mut s.likes {if *epoch==g {if liked {ids.insert(track.into());}else{ids.remove(track);}}}
            }
        }
    }
    pub fn login(&self, id: OnlineProviderId) -> Result<Value, Error> {
        let slot = self.slot(id)?;
        let (generation, client) = slot.start(StartIntent::Login, None)?;
        match client.request("auth.qr.start", json!({})) {
            Ok(v) if v["ok"] == true => {
                let mut s = slot.state.lock().unwrap();
                if s.lifecycle.generation() != generation
                    || s.lifecycle.phase() != Phase::Authenticating
                {
                    return Err(Error::Stale);
                }
                s.qr = Some(
                    v["result"]["sessionId"]
                        .as_str()
                        .ok_or(Error::Schema)?
                        .to_owned(),
                );
                Ok(v["result"].clone())
            }
            r => {
                slot.fail(generation, error_code(&r), None)?;
                Err(Error::Unavailable)
            }
        }
    }
    pub fn poll(
        &self,
        id: OnlineProviderId,
        generation: u64,
        session: &str,
    ) -> Result<Value, Error> {
        let slot = self.slot(id)?;
        let client = {
            let s = slot.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || s.lifecycle.phase() != Phase::Authenticating
                || s.qr.as_deref() != Some(session)
            {
                return Err(Error::Stale);
            }
            s.client.clone().ok_or(Error::Unavailable)?
        };
        let v = client.request("auth.qr.poll", json!({"sessionId":session}));
        let v = match v {
            Ok(v) if v["ok"] == true => v,
            r => {
                slot.fail(generation, error_code(&r), None)?;
                return Err(Error::Unavailable);
            }
        };
        if v["result"]["state"] == "authenticated" {
            let persistence = slot.accept(
                generation,
                &v["result"]["account"],
                Some(&v["result"]["credential"]),
            )?;
            return Ok(
                json!({"sessionId":session,"state":"authenticated","account": {"providerId":protocol::name(id),"id":v["result"]["account"]["id"],"displayName":v["result"]["account"]["displayName"]},"persistence":persistence}),
            );
        }
        if ["expired", "rejected", "cancelled"]
            .iter()
            .any(|x| v["result"]["state"] == *x)
        {
            self.cancel(id, generation, session)?;
        }
        Ok(v["result"].clone())
    }
    /// Single startup attempt. Failures retain secrets and never schedule retries.
    pub fn restore(&self, id: OnlineProviderId) -> Result<bool, Error> {
        if id == OnlineProviderId::Qqmusic {
            return self
                .qq
                .as_ref()
                .ok_or(Error::Unavailable)?
                .restore()
                .map(|s| matches!(s, crate::auth::RecoveryState::Authenticated { .. }))
                .map_err(|_| Error::Unavailable);
        }
        let slot = self.slot(id)?;
        let observed = slot.state.lock().unwrap().lifecycle.generation();
        let Some(bytes) = slot.secrets.read()? else {
            return Ok(false);
        };
        super::secrets::validate(id, &bytes)?;
        let credential: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Storage)?;
        let (generation, client) = slot.start(StartIntent::Restore, Some(observed))?;
        let v = client.request("auth.credential.restore", json!({"credential":credential}));
        match v {
            Ok(v) if v["ok"] == true => {
                slot.accept(generation, &v["result"]["account"], None)?;
                Ok(true)
            }
            r => {
                let code = error_code(&r);
                slot.fail(
                    generation,
                    code,
                    r.as_ref()
                        .ok()
                        .and_then(|v| v["error"]["retryAfterMs"].as_u64())
                        .map(Duration::from_millis),
                )?;
                Err(Error::Unavailable)
            }
        }
    }
    pub fn cancel(
        &self,
        id: OnlineProviderId,
        generation: u64,
        session: &str,
    ) -> Result<(), Error> {
        let slot = self.slot(id)?;
        let (stop, stopping) = {
            let mut s = slot.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || s.lifecycle.phase() == Phase::Ready
                || s.qr.as_deref() != Some(session)
            {
                return Ok(());
            }
            s.lifecycle
                .cancel_auth(generation)
                .map_err(|_| Error::Context)?;
            let next = s.lifecycle.generation();
            slot.secrets.invalidate(generation, next);
            s.qr = None;
            (s.client.take(), next)
        };
        if let Some(c) = stop {
            c.stop();
            drop(c);
        }
        slot.finish_stop(stopping)?;
        Ok(())
    }
    pub fn sign_out(&self, id: OnlineProviderId) -> Result<(), Error> {
        if id == OnlineProviderId::Qqmusic {
            return self
                .qq
                .as_ref()
                .ok_or(Error::Unavailable)?
                .logout()
                .map_err(|_| Error::Storage);
        }
        let slot = self.slot(id)?;
        let (generation, stop) = {
            let mut s = slot.state.lock().unwrap();
            let old = s.lifecycle.generation();
            s.lifecycle.sign_out().map_err(|_| Error::Context)?;
            s.clear_business_cache();
            s.deletions += 1;
            let next = s.lifecycle.generation();
            slot.secrets.invalidate(old, next);
            s.qr = None;
            (next, s.client.take())
        };
        // Wait for a commit already in progress, then delete. A prepared old save
        // checks epoch under this same boundary and can no longer replace it.
        let _startup = slot.startup.lock().unwrap();
        let deleted = slot.secrets.delete(generation);
        if let Some(c) = stop {
            c.stop();
            drop(c);
        }
        {
            let mut s = slot.state.lock().unwrap();
            if s.lifecycle.generation() == generation {
                s.deletions -= 1;
            }
        }
        slot.finish_stop(generation)?;
        deleted
    }
    pub fn request(
        &self,
        id: OnlineProviderId,
        generation: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, Error> {
        let slot = self.slot(id)?;
        slot.observe_exit()?;
        if protocol::constants()["methods"][method]["access"] != "ready"
            && !(method == "auth.credential.check" && protocol::constants()["methods"][method]["access"] == "authenticated") {
            return Err(Error::Context);
        }
        let write=method.starts_with("library.") && protocol::constants()["methods"][method]["semantics"]=="neverReplay";
        let pending = {
            let s = slot.state.lock().unwrap();
            if s.lifecycle.generation() != generation || !s.lifecycle.business_allowed() {
                return Err(Error::Stale);
            }
            s.client.as_ref().ok_or(Error::Unavailable)?.begin(method,params,None)?
        };
        let v = pending.wait().map_err(|e|if write {Error::Upstream(ErrorCode::OutcomeUnknown)}else{e})?;
        let s = slot.state.lock().unwrap();
        if s.lifecycle.generation() != generation || !s.lifecycle.business_allowed() {
            return Err(if write {Error::Upstream(ErrorCode::OutcomeUnknown)}else{Error::Stale});
        }
        drop(s);
        if method == "auth.credential.check" && v["ok"] == true && v["result"]["valid"] == false {
            // A confirmed negative check is as authoritative as the platform's
            // credential_invalid error. Retire only this source, retain storage.
            slot.fail(generation, ErrorCode::CredentialInvalid, None)?;
        }
        if v["ok"]==false {
            let code=serde_json::from_value::<ErrorCode>(v["error"]["code"].clone()).unwrap_or(ErrorCode::ProviderUnavailable);
            if matches!(code,ErrorCode::CredentialInvalid|ErrorCode::AuthenticationRequired|ErrorCode::VerificationRequired|ErrorCode::RateLimited) {
                slot.fail(generation,code,v["error"]["retryAfterMs"].as_u64().map(Duration::from_millis))?;
            }
        }
        Ok(v)
    }
    pub fn shutdown(&self) -> Result<(), Error> {
        if let Some(qq) = &self.qq {
            qq.shutdown();
        }
        for slot in self.slots.values() {
            let (old, next, stop) = {
                let mut s = slot.state.lock().unwrap();
                let old = s.lifecycle.generation();
                s.lifecycle.shutdown().map_err(|_| Error::Context)?;
                s.clear_business_cache();
                (old, s.lifecycle.generation(), s.client.take())
            };
            slot.secrets.invalidate(old, next);
            let _startup = slot.startup.lock().unwrap();
            if let Some(c) = stop {
                c.stop();
                drop(c);
            }
            slot.finish_stop(next)?;
        }
        Ok(())
    }
}
impl Drop for ProviderRegistry {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
impl Slot {
    fn start(
        self: &Arc<Self>,
        intent: StartIntent,
        expected: Option<u64>,
    ) -> Result<(u64, Arc<Client>), Error> {
        let _startup = self.startup.lock().unwrap();
        self.observe_exit()?;
        let generation = {
            let mut s = self.state.lock().unwrap();
            if expected.is_some_and(|g| g != s.lifecycle.generation()) {
                return Err(Error::Stale);
            }
            if s.deletions != 0 {
                return Err(Error::Context);
            }
            if s.cooldown.is_some_and(|t| t > Instant::now()) {
                return Err(Error::Cooldown);
            }
            let t = s
                .lifecycle
                .begin(intent, true)
                .map_err(|_| Error::Context)?;
            s.accepting = false;
            self.secrets.activate(t.generation);
            s.clear_business_cache();
            t.generation
        };
        let (client, events) = match Client::start(self.registration.clone()) {
            Ok(v) => v,
            Err(e) => {
                self.fail(generation, ErrorCode::ProviderUnavailable, None)?;
                return Err(e);
            }
        };
        let client = Arc::new(client);
        {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation || s.lifecycle.phase() != Phase::Starting {
                client.stop();
                return Err(Error::Stale);
            }
            s.lifecycle
                .started(generation)
                .map_err(|_| Error::Context)?;
            s.client = Some(client.clone());
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            // Events carry no credential. QR terminal notifications only cancel
            // an authenticating session; a ready session cannot be cancelled.
            for v in events {
                let Some(slot) = weak.upgrade() else { return };
                if v["event"] == "provider.invalidated" {
                    let code = serde_json::from_value(v["payload"]["code"].clone())
                        .unwrap_or(ErrorCode::ProviderUnavailable);
                    let _ = slot.fail(generation, code, None);
                } else if ["expired", "rejected"]
                    .iter()
                    .any(|x| v["payload"]["state"] == *x)
                {
                    let (stop, stopping) = {
                        let mut s = slot.state.lock().unwrap();
                        if s.lifecycle.generation() != generation
                            || s.lifecycle.phase() == Phase::Ready
                            || s.qr.as_deref() != v["payload"]["sessionId"].as_str()
                        {
                            continue;
                        }
                        if s.lifecycle.cancel_auth(generation).is_err() {
                            continue;
                        }
                        slot.secrets
                            .invalidate(generation, s.lifecycle.generation());
                        (s.client.take(), s.lifecycle.generation())
                    };
                    if let Some(c) = stop {
                        c.stop();
                        drop(c);
                    }
                    let _ = slot.finish_stop(stopping);
                }
            }
            if let Some(slot) = weak.upgrade() {
                let _ = slot.fail(generation, ErrorCode::ProviderUnavailable, None);
            }
        });
        Ok((generation, client))
    }
    fn accept(
        &self,
        generation: u64,
        account: &Value,
        credential: Option<&Value>,
    ) -> Result<Persistence, Error> {
        let result = self.accept_current(generation, account, credential);
        if result.as_ref().is_err_and(|e| *e != Error::Stale) {
            self.fail_if(generation, ErrorCode::UpstreamSchemaChanged, None, true)?;
        }
        result
    }
    fn accept_current(
        &self,
        generation: u64,
        account: &Value,
        credential: Option<&Value>,
    ) -> Result<Persistence, Error> {
        // Check before preparing any save; check again before publishing ready.
        let parsed = {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || !matches!(
                    s.lifecycle.phase(),
                    Phase::Authenticating | Phase::Restoring
                )
            {
                return Err(Error::Stale);
            }
            if s.accepting {
                return Err(Error::Stale);
            }
            s.accepting = true;
            let account = ProviderAccount {
                provider_id: self.registration.provider,
                id: account["id"].as_str().ok_or(Error::Schema)?.into(),
                display_name: account["displayName"].as_str().ok_or(Error::Schema)?.into(),
            };
            s.lifecycle
                .validate_account(&account)
                .map_err(|_| Error::Context)?;
            account
        };
        let prepared = if let Some(c) = credential {
            let b = credential_bytes(c)?;
            super::secrets::validate(self.registration.provider, &b)?;
            Some(self.secrets.prepare(generation, &b))
        } else {
            None
        };
        let mut s = self.state.lock().unwrap();
        if s.lifecycle.generation() != generation
            || !matches!(
                s.lifecycle.phase(),
                Phase::Authenticating | Phase::Restoring
            )
        {
            return Err(Error::Stale);
        }
        s.lifecycle
            .validate_account(&parsed)
            .map_err(|_| Error::Context)?;
        // Commit and Ready are one transition relative to QR cancellation.
        // Preparing/encrypting/flushing remains cancellable outside this lock.
        let persistence = match prepared {
            None => Persistence::Saved,
            Some(Ok(p)) => match self.secrets.commit(generation, p) {
                Ok(()) => Persistence::Saved,
                Err(Error::Stale) => return Err(Error::Stale),
                Err(_) => Persistence::SessionOnly,
            },
            Some(Err(Error::Stale)) => return Err(Error::Stale),
            Some(Err(_)) => Persistence::SessionOnly,
        };
        s.lifecycle
            .authenticated(generation, parsed, persistence)
            .map_err(|_| Error::Context)?;
        Ok(persistence)
    }
    fn fail(
        &self,
        generation: u64,
        code: ErrorCode,
        cooldown: Option<Duration>,
    ) -> Result<(), Error> {
        self.fail_if(generation, code, cooldown, false)
    }
    fn fail_if(
        &self,
        generation: u64,
        code: ErrorCode,
        cooldown: Option<Duration>,
        auth_only: bool,
    ) -> Result<(), Error> {
        let (stop, stopping) = {
            let mut s = self.state.lock().unwrap();
            if s.lifecycle.generation() != generation
                || matches!(s.lifecycle.phase(), Phase::Disabled | Phase::Stopping)
                || (auth_only && s.lifecycle.phase() == Phase::Ready)
            {
                return Ok(());
            }
            s.lifecycle
                .fail(generation, code)
                .map_err(|_| Error::Context)?;
            s.clear_business_cache();
            self.secrets
                .invalidate(generation, s.lifecycle.generation());
            if let Some(d) = cooldown {
                s.cooldown = Some(Instant::now() + d);
            }
            s.accepting = false;
            s.qr = None;
            (s.client.take(), s.lifecycle.generation())
        };
        if let Some(c) = stop {
            c.stop();
            drop(c);
        }
        self.finish_stop(stopping)
    }
    fn finish_stop(&self, g: u64) -> Result<(), Error> {
        let mut s = self.state.lock().unwrap();
        if s.lifecycle.phase() == Phase::Stopping && s.deletions == 0 {
            s.lifecycle.stopped(g).map_err(|_| Error::Context)?;
        }
        Ok(())
    }
    fn observe_exit(&self) -> Result<(), Error> {
        let failed = {
            let s = self.state.lock().unwrap();
            s.client
                .as_ref()
                .filter(|c| !c.alive.load(Ordering::Acquire))
                .map(|_| s.lifecycle.generation())
        };
        if let Some(g) = failed {
            self.fail(g, ErrorCode::ProviderUnavailable, None)?;
        }
        Ok(())
    }
}
fn error_code(r: &Result<Value, Error>) -> ErrorCode {
    match r {
        Ok(v) => serde_json::from_value(v["error"]["code"].clone())
            .unwrap_or(ErrorCode::ProviderUnavailable),
        Err(_) => ErrorCode::ProviderUnavailable,
    }
}

#[cfg(test)]
mod review_tests {
    use super::super::secrets::Prepared;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use zeroize::Zeroizing;
    struct Stored {
        bytes: Vec<u8>,
        prepares: AtomicUsize,
    }
    impl Store for Stored {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
            Ok(Some(Zeroizing::new(self.bytes.clone())))
        }
        fn prepare(&self, _: &[u8]) -> Result<Box<dyn Prepared>, Error> {
            self.prepares.fetch_add(1, Ordering::SeqCst);
            Err(Error::Storage)
        }
        fn delete(&self) -> Result<(), Error> {
            panic!("authentication rejection must retain credentials")
        }
    }
    #[test]
    fn injected_current_rejection_retires_claim_before_any_save_and_stale_cannot_stop_ready() {
        // Deliberately bypass Client to exercise the host's rejection guard;
        // these malformed accounts/credentials are rejected earlier on the wire.
        for (account, credential) in [
            (
                json!({"id":"汉".repeat(129),"displayName":"Synthetic"}),
                None,
            ),
            (json!({"id":false,"displayName":"Synthetic"}), None),
            (
                json!({"id":"123","displayName":"Synthetic"}),
                Some(json!({"version":1,"providerId":"bilibili","payload":"SYNTHETIC_TEST_ONLY"})),
            ),
            (
                json!({"id":"123","displayName":"Synthetic"}),
                Some(json!({"version":1,"providerId":"netease","payload":"x".repeat(65536)})),
            ),
        ] {
            let store = Arc::new(Stored {
                bytes: serde_json::to_vec(&json!({"version":1,"providerId":"netease","payload":"ORIGINAL_SYNTHETIC_TEST_ONLY"})).unwrap(),
                prepares: AtomicUsize::new(0),
            });
            let launch =
                crate::provider::ProviderLaunch::new(std::env::current_exe().unwrap()).unwrap();
            let methods = protocol::constants()["methods"]
                .as_object()
                .unwrap()
                .iter()
                .filter(|(_, s)| {
                    s["providers"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("netease"))
                })
                .map(|(m, _)| m.clone())
                .collect();
            let slot = Slot {
                registration: Registration::v2(
                    OnlineProviderId::Netease,
                    "test-3a".into(),
                    methods,
                    launch,
                )
                .unwrap(),
                state: Mutex::new(State {
                    lifecycle: Lifecycle::new(OnlineProviderId::Netease),
                    client: None,
                    qr: None,
                    cooldown: None,
                    accepting: false,
                    deletions: 0,
                    write_targets: HashSet::new(),
                    likes: None,
                    likes_version: 0,
                    unresolved_writes: HashMap::new(),
                }),
                secrets: CoordinatedStore::new(store.clone()),
                startup: Mutex::new(()),
            };
            let g = {
                let mut s = slot.state.lock().unwrap();
                let g = s
                    .lifecycle
                    .begin(StartIntent::Restore, true)
                    .unwrap()
                    .generation;
                s.lifecycle.started(g).unwrap();
                g
            };
            slot.secrets.activate(g);
            assert!(slot.accept(g, &account, credential.as_ref()).is_err());
            assert_eq!(
                slot.state.lock().unwrap().lifecycle.phase(),
                Phase::Disabled
            );
            assert_eq!(store.prepares.load(Ordering::SeqCst), 0);
            assert_eq!(
                slot.secrets.read().unwrap().unwrap().as_slice(),
                store.bytes
            );
            let next = {
                let mut s = slot.state.lock().unwrap();
                let g = s
                    .lifecycle
                    .begin(StartIntent::Restore, true)
                    .unwrap()
                    .generation;
                s.lifecycle.started(g).unwrap();
                s.accepting = false;
                g
            };
            slot.secrets.activate(next);
            slot.accept(next, &json!({"id":"123","displayName":"Synthetic"}), None)
                .unwrap();
            assert_eq!(
                slot.accept(g, &account, credential.as_ref()),
                Err(Error::Stale)
            );
            assert_eq!(
                slot.accept(next, &account, credential.as_ref()),
                Err(Error::Stale)
            );
            assert_eq!(slot.state.lock().unwrap().lifecycle.phase(), Phase::Ready);
        }
    }
}
