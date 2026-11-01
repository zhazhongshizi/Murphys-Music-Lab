//! Pure lifecycle reducer; Registry executes IO and owns per-platform effects.
use super::{ErrorCode, OnlineProviderId, ProviderAccount, ProviderCapabilities};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Disabled,
    Starting,
    Authenticating,
    Restoring,
    Ready,
    Stopping,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartIntent {
    Login,
    Restore,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Persistence {
    Saved,
    SessionOnly,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    StartProcess,
    StopProcess,
    InvalidateSession,
    DeleteCredential,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleError {
    InvalidTransition,
    WrongAccount,
    GenerationExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    /// Internal only; never serialize in a public DTO.
    pub generation: u64,
    pub effects: Vec<Effect>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider_id: OnlineProviderId,
    pub capabilities: ProviderCapabilities,
    #[serde(flatten)]
    pub status: PublicStatus,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PublicStatus {
    Disabled {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ErrorCode>,
        #[serde(rename = "retryAfterMs", skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
    Starting,
    Authenticating,
    Restoring,
    Ready {
        account: ProviderAccount,
        persistence: Persistence,
    },
    Stopping,
}

pub struct Lifecycle {
    provider_id: OnlineProviderId,
    phase: Phase,
    generation: u64,
    intent: StartIntent,
    account: Option<ProviderAccount>,
    persistence: Persistence,
    error: Option<ErrorCode>,
}

impl Lifecycle {
    pub fn new(provider_id: OnlineProviderId) -> Self {
        Self {
            provider_id,
            phase: Phase::Disabled,
            generation: 0,
            intent: StartIntent::Login,
            account: None,
            persistence: Persistence::SessionOnly,
            error: None,
        }
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn business_allowed(&self) -> bool {
        self.phase == Phase::Ready
    }
    fn transition(&self, effects: Vec<Effect>) -> Transition {
        Transition {
            generation: self.generation,
            effects,
        }
    }
    fn next_generation(&self) -> Result<u64, LifecycleError> {
        self.generation
            .checked_add(1)
            .ok_or(LifecycleError::GenerationExhausted)
    }

    /// No saved credential means no start effect, including on application startup.
    pub fn begin(
        &mut self,
        intent: StartIntent,
        has_saved_credential: bool,
    ) -> Result<Transition, LifecycleError> {
        if self.phase != Phase::Disabled {
            return Err(LifecycleError::InvalidTransition);
        }
        if intent == StartIntent::Restore && !has_saved_credential {
            return Ok(self.transition(vec![]));
        }
        self.generation = self.next_generation()?;
        self.intent = intent;
        self.phase = Phase::Starting;
        self.error = None;
        Ok(self.transition(vec![Effect::StartProcess]))
    }
    pub fn started(&mut self, generation: u64) -> Result<Transition, LifecycleError> {
        if generation != self.generation {
            return Ok(self.transition(vec![]));
        }
        if self.phase != Phase::Starting {
            return Err(LifecycleError::InvalidTransition);
        }
        self.phase = match self.intent {
            StartIntent::Login => Phase::Authenticating,
            StartIntent::Restore => Phase::Restoring,
        };
        Ok(self.transition(vec![]))
    }
    pub fn authenticated(
        &mut self,
        generation: u64,
        account: ProviderAccount,
        persistence: Persistence,
    ) -> Result<Transition, LifecycleError> {
        if generation != self.generation {
            return Ok(self.transition(vec![]));
        }
        if !matches!(self.phase, Phase::Authenticating | Phase::Restoring) {
            return Err(LifecycleError::InvalidTransition);
        }
        self.validate_account(&account)?;
        self.account = Some(account);
        self.persistence = persistence;
        self.phase = Phase::Ready;
        Ok(self.transition(vec![]))
    }
    /// Match JSON Schema minLength/maxLength (Unicode scalar values, not UTF-8 bytes).
    pub fn validate_account(&self, account: &ProviderAccount) -> Result<(), LifecycleError> {
        if account.provider_id != self.provider_id
            || account.id.is_empty()
            || account.id.chars().count() > 128
            || account.display_name.chars().count() > 512
        {
            return Err(LifecycleError::WrongAccount);
        }
        Ok(())
    }
    /// A late QR cancel/expiry cannot tear down an already authenticated session.
    pub fn cancel_auth(&mut self, generation: u64) -> Result<Transition, LifecycleError> {
        if generation != self.generation
            || !matches!(
                self.phase,
                Phase::Starting | Phase::Authenticating | Phase::Restoring
            )
        {
            return Ok(self.transition(vec![]));
        }
        self.stop(Some(ErrorCode::Cancelled), false)
    }
    /// Provider/session failure preserves secrets. Only explicit sign-out deletes them.
    pub fn fail(
        &mut self,
        generation: u64,
        error: ErrorCode,
    ) -> Result<Transition, LifecycleError> {
        if generation != self.generation {
            return Ok(self.transition(vec![]));
        }
        if matches!(self.phase, Phase::Disabled | Phase::Stopping) {
            return Err(LifecycleError::InvalidTransition);
        }
        self.stop(Some(error), false)
    }
    pub fn sign_out(&mut self) -> Result<Transition, LifecycleError> {
        if self.phase == Phase::Stopping {
            self.error = None;
            return Ok(self.transition(vec![Effect::DeleteCredential]));
        }
        if self.phase == Phase::Disabled {
            self.generation = self.next_generation()?;
            self.error = None;
            return Ok(self.transition(vec![Effect::InvalidateSession, Effect::DeleteCredential]));
        }
        self.stop(None, true)
    }
    /// Shutdown preserves persisted login, unlike sign-out.
    pub fn shutdown(&mut self) -> Result<Transition, LifecycleError> {
        if matches!(self.phase, Phase::Disabled | Phase::Stopping) {
            return Ok(self.transition(vec![]));
        }
        self.stop(None, false)
    }
    fn stop(
        &mut self,
        error: Option<ErrorCode>,
        delete: bool,
    ) -> Result<Transition, LifecycleError> {
        self.generation = self.next_generation()?;
        self.phase = Phase::Stopping;
        self.account = None;
        self.error = error;
        let mut effects = vec![Effect::InvalidateSession];
        if delete {
            effects.push(Effect::DeleteCredential);
        }
        effects.push(Effect::StopProcess);
        Ok(self.transition(effects))
    }
    /// Complete only after the owned process is actually reaped. No automatic retry.
    pub fn stopped(&mut self, generation: u64) -> Result<Transition, LifecycleError> {
        if generation != self.generation {
            return Ok(self.transition(vec![]));
        }
        if self.phase == Phase::Disabled {
            return Ok(self.transition(vec![]));
        }
        if self.phase != Phase::Stopping {
            return Err(LifecycleError::InvalidTransition);
        }
        self.phase = Phase::Disabled;
        Ok(self.transition(vec![]))
    }
    pub fn snapshot(&self, capabilities: ProviderCapabilities) -> ProviderSnapshot {
        let status = match self.phase {
            Phase::Disabled => PublicStatus::Disabled {
                error: self.error,
                retry_after_ms: None,
            },
            Phase::Starting => PublicStatus::Starting,
            Phase::Authenticating => PublicStatus::Authenticating,
            Phase::Restoring => PublicStatus::Restoring,
            Phase::Stopping => PublicStatus::Stopping,
            Phase::Ready => PublicStatus::Ready {
                account: self
                    .account
                    .clone()
                    .expect("ready requires an authenticated account"),
                persistence: self.persistence,
            },
        };
        ProviderSnapshot {
            provider_id: self.provider_id,
            capabilities,
            status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(provider_id: OnlineProviderId) -> ProviderAccount {
        ProviderAccount {
            provider_id,
            id: "123".into(),
            display_name: "Fixture".into(),
        }
    }
    #[test]
    fn account_limits_count_unicode_scalars_before_authentication() {
        let s = Lifecycle::new(OnlineProviderId::Netease);
        for id in ["汉".repeat(44), "汉".repeat(128), "🎵".repeat(128)] {
            let mut a = account(OnlineProviderId::Netease);
            a.id = id;
            assert!(s.validate_account(&a).is_ok());
        }
        for id in [String::new(), "汉".repeat(129)] {
            let mut a = account(OnlineProviderId::Netease);
            a.id = id;
            assert_eq!(s.validate_account(&a), Err(LifecycleError::WrongAccount));
        }
    }
    #[test]
    fn explicit_logout_while_stopping_keeps_deletion_and_classifies_late_notifications() {
        let mut s = Lifecycle::new(OnlineProviderId::Netease);
        let g = s.begin(StartIntent::Login, false).unwrap().generation;
        s.started(g).unwrap();
        let stop = s.fail(g, ErrorCode::ProviderUnavailable).unwrap();
        let out = s.sign_out().unwrap();
        assert_eq!(out.generation, stop.generation);
        assert_eq!(out.effects, vec![Effect::DeleteCredential]);
        assert!(s
            .fail(g, ErrorCode::InternalError)
            .unwrap()
            .effects
            .is_empty());
        assert_eq!(s.phase(), Phase::Stopping);
        s.stopped(stop.generation).unwrap();
        assert!(s.stopped(stop.generation).unwrap().effects.is_empty());
        assert_eq!(s.phase(), Phase::Disabled);
    }
    #[test]
    fn shared_lifecycle_traces() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-v2/lifecycle.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut state = Lifecycle::new(OnlineProviderId::Netease);
            let mut effects = Vec::new();
            for event in case["events"].as_array().unwrap() {
                let result = match event.as_str().unwrap() {
                    "restoreAbsent" => state.begin(StartIntent::Restore, false),
                    "restoreSaved" => state.begin(StartIntent::Restore, true),
                    "login" => state.begin(StartIntent::Login, false),
                    "started" => state.started(state.generation()),
                    "authenticated" => state.authenticated(
                        state.generation(),
                        account(OnlineProviderId::Netease),
                        Persistence::Saved,
                    ),
                    "saveFailed" => state.authenticated(
                        state.generation(),
                        account(OnlineProviderId::Netease),
                        Persistence::SessionOnly,
                    ),
                    "cancel" => state.cancel_auth(state.generation()),
                    "networkFailure" => {
                        state.fail(state.generation(), ErrorCode::NetworkUnavailable)
                    }
                    "invalidCredential" => {
                        state.fail(state.generation(), ErrorCode::CredentialInvalid)
                    }
                    "logout" => state.sign_out(),
                    "shutdown" => state.shutdown(),
                    "stopped" => state.stopped(state.generation()),
                    _ => panic!("unknown fixture event"),
                }
                .unwrap();
                effects.extend(
                    result
                        .effects
                        .into_iter()
                        .map(|effect| format!("{effect:?}")),
                );
            }
            assert_eq!(
                serde_json::to_value(state.phase()).unwrap(),
                case["state"],
                "{}",
                case["name"]
            );
            assert_eq!(
                serde_json::to_value(effects).unwrap(),
                case["effects"],
                "{}",
                case["name"]
            );
            assert_eq!(state.business_allowed(), case["state"] == "ready");
        }
    }
    #[test]
    fn cancellation_invalidates_late_auth_and_other_platform_is_unchanged() {
        let mut a = Lifecycle::new(OnlineProviderId::Netease);
        let b = Lifecycle::new(OnlineProviderId::Bilibili);
        let old = a.begin(StartIntent::Login, false).unwrap().generation;
        a.started(old).unwrap();
        a.cancel_auth(old).unwrap();
        a.stopped(a.generation()).unwrap();
        let new = a.begin(StartIntent::Login, false).unwrap().generation;
        a.started(new).unwrap();
        assert!(a
            .authenticated(old, account(OnlineProviderId::Netease), Persistence::Saved)
            .unwrap()
            .effects
            .is_empty());
        assert_eq!(a.phase(), Phase::Authenticating);
        assert_eq!(b.phase(), Phase::Disabled);
        assert_eq!(b.generation(), 0);
        assert_eq!(
            a.authenticated(new, account(OnlineProviderId::Bilibili), Persistence::Saved),
            Err(LifecycleError::WrongAccount)
        );
        assert!(!a.business_allowed());
        a.authenticated(
            new,
            account(OnlineProviderId::Netease),
            Persistence::SessionOnly,
        )
        .unwrap();
        assert!(a.cancel_auth(new).unwrap().effects.is_empty());
        assert_eq!(a.phase(), Phase::Ready);
        let snapshot = serde_json::to_value(a.snapshot(ProviderCapabilities::netease())).unwrap();
        assert_eq!(snapshot["persistence"], "sessionOnly");
        assert!(snapshot.get("generation").is_none());
        assert!(snapshot.get("credential").is_none());
        assert!(a.begin(StartIntent::Login, false).is_err());
    }
}
