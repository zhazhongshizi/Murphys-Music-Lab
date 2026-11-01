//! One owned v2 process, no restart or replay. Registry owns account readiness.
use super::{
    protocol::{self, Error},
    OnlineProviderId,
};
use crate::provider::{ProviderLaunch, SupervisorConfig};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Registration {
    pub provider: OnlineProviderId,
    pub version: String,
    pub methods: Vec<String>,
    pub launch: ProviderLaunch,
    pub config: SupervisorConfig,
    pub capabilities: super::ProviderCapabilities,
}
impl Registration {
    pub fn v2(
        provider: OnlineProviderId,
        version: String,
        methods: Vec<String>,
        launch: ProviderLaunch,
    ) -> Result<Self, Error> {
        Self::with_profile(
            provider,
            version,
            methods,
            launch,
            if provider == OnlineProviderId::Netease {
                super::ProviderCapabilities::netease()
            } else {
                super::ProviderCapabilities::bilibili()
            },
        )
    }
    pub fn with_profile(
        provider: OnlineProviderId,
        version: String,
        methods: Vec<String>,
        launch: ProviderLaunch,
        capabilities: super::ProviderCapabilities,
    ) -> Result<Self, Error> {
        if provider == OnlineProviderId::Qqmusic
            || version.is_empty()
            || ![
                "system.handshake",
                "system.ping",
                "auth.qr.start",
                "auth.qr.poll",
                "auth.qr.cancel",
                "auth.credential.restore",
                "auth.credential.check",
                "auth.logout",
            ]
            .iter()
            .all(|m| methods.iter().any(|x| x == m))
        {
            return Err(Error::Handshake);
        }
        Ok(Self {
            provider,
            version,
            methods,
            launch,
            config: SupervisorConfig {
                max_restarts: 0,
                ..Default::default()
            },
            capabilities,
        })
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.provider == OnlineProviderId::Qqmusic
            || self.version.is_empty()
            || self.version.len() > 64
            || self.methods.len() != self.methods.iter().collect::<HashSet<_>>().len()
        {
            return Err(Error::Handshake);
        }
        if [
            "system.handshake",
            "system.ping",
            "auth.qr.start",
            "auth.qr.poll",
            "auth.qr.cancel",
            "auth.credential.restore",
            "auth.credential.check",
            "auth.logout",
        ]
        .iter()
        .any(|m| !self.methods.iter().any(|x| x == m))
        {
            return Err(Error::Handshake);
        }
        if self.methods.iter().any(|m| {
            !protocol::constants()["methods"][m]["providers"]
                .as_array()
                .is_some_and(|ps| ps.contains(&json!(protocol::name(self.provider))))
        }) {
            return Err(Error::Handshake);
        }
        let profile = serde_json::to_value(&self.capabilities).map_err(|_| Error::Handshake)?;
        let max = &protocol::constants()["capabilities"][protocol::name(self.provider)];
        protocol::validate("capabilities", &profile)?;
        for key in [
            "loginMethods",
            "searchKinds",
            "libraryKinds",
            "writeActions",
            "qualities",
        ] {
            if profile[key]
                .as_array()
                .unwrap()
                .iter()
                .any(|x| !max[key].as_array().unwrap().contains(x))
            {
                return Err(Error::Handshake);
            }
        }
        if profile["lyrics"] == true && max["lyrics"] != true {
            return Err(Error::Handshake);
        }
        let has = |m: &str| self.methods.iter().any(|x| x == m);
        for (key, mappings) in [
            (
                "searchKinds",
                vec![
                    ("songs", "search.songs"),
                    ("playlists", "search.playlists"),
                    ("videos", "search.videos"),
                ],
            ),
            (
                "writeActions",
                vec![
                    ("song.like", "library.setLiked"),
                    ("song.unlike", "library.setLiked"),
                    ("playlist.subscribe", "library.setSubscribed"),
                    ("playlist.unsubscribe", "library.setSubscribed"),
                    ("playlist.addTracks", "library.addItems"),
                    ("playlist.removeTracks", "library.removeItems"),
                    ("favorite.addVideos", "library.addItems"),
                    ("favorite.removeVideos", "library.removeItems"),
                ],
            ),
        ] {
            for value in profile[key].as_array().unwrap() {
                let m = mappings
                    .iter()
                    .find(|(k, _)| value == *k)
                    .ok_or(Error::Handshake)?
                    .1;
                if !has(m) {
                    return Err(Error::Handshake);
                }
            }
        }
        if !profile["qualities"].as_array().unwrap().is_empty() && !has("playback.resolve")
            || profile["lyrics"] == true && !has("lyrics.get")
        {
            return Err(Error::Handshake);
        }
        if !profile["libraryKinds"].as_array().unwrap().is_empty()
            && (!has("library.containers")
                || !has(if self.provider == OnlineProviderId::Netease {
                    "library.tracks"
                } else {
                    "library.videos"
                }))
        {
            return Err(Error::Handshake);
        }
        if profile["libraryKinds"]
            .as_array()
            .unwrap()
            .contains(&json!("likes"))
            && !has("library.likes")
        {
            return Err(Error::Handshake);
        }
        Ok(())
    }
}
enum Message {
    Submit {
        id: String,
        frame: Value,
        deadline: Instant,
        reply: Sender<Result<Value, Error>>,
    },
    Cancel(String),
    Frame(Result<Option<Value>, Error>),
    Stop,
    WriteFailed,
}
struct Entry {
    frame: Value,
    deadline: Instant,
    reply: Sender<Result<Value, Error>>,
}
pub struct Pending {
    id: String,
    tx: Sender<Message>,
    rx: Receiver<Result<Value, Error>>,
    done: bool,
}
impl Pending {
    pub fn wait(mut self) -> Result<Value, Error> {
        let r = self.rx.recv().unwrap_or(Err(Error::Unavailable));
        self.done = true;
        r
    }
    pub fn cancel(mut self) {
        let _ = self.tx.send(Message::Cancel(self.id.clone()));
        self.done = true;
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.tx.send(Message::Cancel(self.id.clone()));
        }
    }
}
pub struct Client {
    tx: Sender<Message>,
    sequence: AtomicU64,
    pub alive: Arc<AtomicBool>,
    reaped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    provider: OnlineProviderId,
    methods: Vec<String>,
    timeout: Duration,
}
impl Client {
    pub fn start(reg: Registration) -> Result<(Self, Receiver<Value>), Error> {
        reg.validate()?;
        if reg.config.max_restarts != 0
            || reg.config.request_timeout.is_zero()
            || reg.config.handshake_timeout.is_zero()
        {
            return Err(Error::Handshake);
        }
        let mut command = Command::new(&reg.launch.executable);
        command
            .args(&reg.launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = &reg.launch.current_dir {
            command.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| Error::Unavailable)?;
        let mut stdin = child.stdin.take().ok_or(Error::Unavailable)?;
        let stdout = child.stdout.take().ok_or(Error::Unavailable)?;
        let (tx, rx) = mpsc::channel();
        let read_tx = tx.clone();
        let reader = thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                let f = protocol::read(&mut r);
                let end = !matches!(f, Ok(Some(_)));
                if read_tx.send(Message::Frame(f)).is_err() || end {
                    break;
                }
            }
        });
        let handshake = protocol::request(
            reg.provider,
            "handshake-0",
            "system.handshake",
            json!({"protocolVersion":2,"providerId":protocol::name(reg.provider)}),
        )?;
        let handshake_result = (|| {
            stdin
                .write_all(&protocol::encode(&handshake)?)
                .and_then(|_| stdin.flush())
                .map_err(|_| Error::Unavailable)?;
            match rx.recv_timeout(reg.config.handshake_timeout) {
                Ok(Message::Frame(Ok(Some(v)))) if v["id"] == "handshake-0" => {
                    protocol::response(reg.provider, "system.handshake", &handshake["params"], &v)?;
                    if v["ok"] != true {
                        return Err(Error::Handshake);
                    }
                    protocol::handshake(
                        reg.provider,
                        &reg.version,
                        &reg.methods,
                        &reg.capabilities,
                        &v["result"],
                    )
                }
                _ => Err(Error::Handshake),
            }
        })();
        if let Err(e) = handshake_result {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(e);
        }
        let (events, event_rx) = mpsc::sync_channel(64);
        let (outbound, write_rx) = mpsc::channel::<zeroize::Zeroizing<Vec<u8>>>();
        let write_error = tx.clone();
        let writer = thread::spawn(move || {
            for bytes in write_rx {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    let _ = write_error.send(Message::WriteFailed);
                    break;
                }
            }
        });
        let alive = Arc::new(AtomicBool::new(true));
        let live = alive.clone();
        let reaped = Arc::new(AtomicBool::new(false));
        let worker_reaped = reaped.clone();
        let provider = reg.provider;
        let worker = thread::spawn(move || {
            let mut pending: HashMap<String, Entry> = HashMap::new();
            let mut retired = HashSet::from(["handshake-0".to_string()]);
            let mut abandoned = HashSet::new();
            let outcome = (|| -> Result<(), Error> {
                loop {
                    if !live.load(Ordering::Acquire) {
                        break;
                    }
                    let now = Instant::now();
                    let expired: Vec<_> = pending
                        .iter()
                        .filter(|(_, e)| e.deadline <= now)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in expired {
                        if let Some(e) = pending.remove(&id) {
                            let is_write=e.frame["method"].as_str().is_some_and(|m| m.starts_with("library.") && protocol::constants()["methods"][m]["semantics"]=="neverReplay");
                            abandoned.insert(id);
                            let _ = e.reply.send(Err(Error::Timeout));
                            // A queued request cannot be recalled from Node's
                            // scheduler. Retire the process on a write timeout;
                            // never let it send later in a recovered session.
                            if is_write { return Err(Error::Timeout); }
                        }
                    }
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(Message::Submit {
                            id,
                            frame,
                            deadline,
                            reply,
                        }) => {
                            if deadline<=Instant::now() {let _=reply.send(Err(Error::Timeout));retired.insert(id);continue;}
                            if retired.contains(&id)
                                || abandoned.contains(&id)
                                || pending.contains_key(&id)
                            {
                                return Err(Error::Frame);
                            }
                            outbound
                                .send(zeroize::Zeroizing::new(protocol::encode(&frame)?))
                                .map_err(|_| Error::Unavailable)?;
                            pending.insert(
                                id,
                                Entry {
                                    frame,
                                    deadline,
                                    reply,
                                },
                            );
                        }
                        Ok(Message::Cancel(id)) => {
                            if let Some(e) = pending.remove(&id) {
                                let is_write=e.frame["method"].as_str().is_some_and(|m|m.starts_with("library.")&&protocol::constants()["methods"][m]["semantics"]=="neverReplay");
                                abandoned.insert(id);
                                let _ = e.reply.send(Err(Error::Cancelled));
                                if is_write {return Err(Error::Cancelled);}
                            }
                        }
                        Ok(Message::Frame(Ok(Some(v)))) => {
                            if v.get("event").is_some() {
                                protocol::event(&v)?;
                                events.try_send(v).map_err(|_| Error::Frame)?;
                                continue;
                            }
                            let id = v["id"].as_str().ok_or(Error::Frame)?;
                            if let Some(e) = pending.remove(id) {
                                protocol::response(
                                    provider,
                                    e.frame["method"].as_str().ok_or(Error::Frame)?,
                                    &e.frame["params"],
                                    &v,
                                )
                                .inspect_err(|e2| {
                                    let _ = e.reply.send(Err(*e2));
                                })?;
                                retired.insert(id.to_owned());
                                let _ = e.reply.send(Ok(v));
                            } else if abandoned.remove(id) {
                                // Exactly one late response is expected for a locally cancelled/expired call.
                                protocol::validate(
                                    if v["ok"] == true {
                                        "success"
                                    } else {
                                        "failure"
                                    },
                                    &v,
                                )?;
                                retired.insert(id.to_owned());
                            } else {
                                return Err(Error::Frame);
                            }
                        }
                        Ok(Message::Frame(_)) | Ok(Message::WriteFailed) => {
                            return Err(Error::Unavailable)
                        }
                        Ok(Message::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                Ok(())
            })();
            live.store(false, Ordering::Release);
            for (_, e) in pending {
                let _ = e
                    .reply
                    .send(Err(outcome.err().unwrap_or(Error::Unavailable)));
            }
            let _ = child.kill();
            let _ = child.wait();
            drop(outbound);
            let _ = writer.join();
            let _ = reader.join();
            worker_reaped.store(true, Ordering::Release);
        });
        Ok((
            Self {
                tx,
                sequence: AtomicU64::new(1),
                alive,
                reaped,
                worker: Some(worker),
                provider,
                methods: reg.methods,
                timeout: reg.config.request_timeout,
            },
            event_rx,
        ))
    }
    pub fn begin(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Pending, Error> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(Error::Unavailable);
        }
        if method == "system.handshake" || !self.methods.iter().any(|m| m == method) {
            return Err(Error::Context);
        }
        let n = self
            .sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::Frame)?;
        let id = format!("host-{n}");
        let frame = protocol::request(self.provider, &id, method, params)?;
        let (reply, rx) = mpsc::channel();
        self.tx
            .send(Message::Submit {
                id: id.clone(),
                frame,
                deadline: Instant::now() + timeout.unwrap_or(self.timeout),
                reply,
            })
            .map_err(|_| Error::Unavailable)?;
        Ok(Pending {
            id,
            tx: self.tx.clone(),
            rx,
            done: false,
        })
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.begin(method, params, None)?.wait()
    }
    pub fn stop(&self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.tx.send(Message::Stop);
        while !self.reaped.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
