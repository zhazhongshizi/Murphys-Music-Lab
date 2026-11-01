#[cfg(not(windows))]
compile_error!("provider-media-probe is Windows-only");
use qqmusic_gui_lib::{
    multi_provider::media_probe::MediaProbeBridge,
    player::{
        NativePlayerEvent, PlayerCommand, PlayerEngine, SeekPositionMs, SmtcMetadata, TrackSummary,
        WindowsMediaPlayerEngine,
    },
};
use serde::Deserialize;
use std::{
    io::{self, BufRead, Read},
    sync::atomic::Ordering,
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    url: String,
    bvid: String,
    cid: String,
    codec: String,
    bitrate: u64,
}
fn main() {
    if let Err(code) = run() {
        eprintln!("provider_media_probe_failed:{code}");
        std::process::exit(2);
    }
}
fn snapshot(engine: &WindowsMediaPlayerEngine) -> serde_json::Value {
    serde_json::to_value(engine.snapshot()).unwrap()
}
fn wait(
    engine: &WindowsMediaPlayerEngine,
    seconds: u64,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if let Some(NativePlayerEvent::Failed { .. }) = engine.try_event() {
            return Err("native_media_failed");
        }
        if predicate(&snapshot(engine)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err("native_state_timeout")
}
fn run() -> Result<(), &'static str> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--stdin-public-probe"] {
        return Err("explicit_probe_required");
    }
    let mut line = String::new();
    io::stdin()
        .lock()
        .take(16385)
        .read_line(&mut line)
        .map_err(|_| "stdin_failed")?;
    if line.len() > 16384 {
        return Err("descriptor_too_large");
    }
    let descriptor: Descriptor = serde_json::from_str(&line).map_err(|_| "invalid_descriptor")?;
    if descriptor.codec != "aac" || descriptor.bitrate == 0 {
        return Err("unsupported_codec");
    }
    qqmusic_gui_lib::multi_provider::identity::TrackRef::bilibili(
        &descriptor.bvid,
        &descriptor.cid,
    )
    .map_err(|_| "invalid_track")?;
    let bridge = MediaProbeBridge::bilibili(&descriptor.url)?;
    let local = bridge.local_url_for_checks();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "client_failed")?;
    let head = client.head(&local).send().map_err(|_| "head_failed")?;
    if !head.status().is_success() {
        return Err("head_status");
    }
    let partial = client
        .get(&local)
        .header("Range", "bytes=0-1023")
        .send()
        .map_err(|_| "range_failed")?;
    if partial.status() != 206
        || !partial.headers().contains_key("content-range")
        || partial.bytes().map_err(|_| "range_read_failed")?.len() != 1024
    {
        return Err("range_invalid");
    }
    let outside = client
        .get(&local)
        .header("Range", "bytes=999999999999-")
        .send()
        .map_err(|_| "range_416_failed")?;
    if outside.status() != 416 {
        return Err("range_416_status");
    }
    let before_native = bridge.metrics().range.load(Ordering::Relaxed);
    let mut engine = WindowsMediaPlayerEngine::new().map_err(|_| "engine_unavailable")?;
    engine
        .handle(PlayerCommand::SetMuted { muted: true })
        .map_err(|_| "mute_failed")?;
    engine
        .handle(PlayerCommand::LoadRemote {
            url: bridge.native_url(),
            track: TrackSummary {
                id: format!("bilibili:video:{}:{}", descriptor.bvid, descriptor.cid),
                title: "Isolated AAC probe".into(),
                artist: "Public fixture".into(),
                source: None,
            },
            smtc_metadata: SmtcMetadata::default(),
        })
        .map_err(|_| "load_failed")?;
    wait(&engine, 25, |s| {
        s["durationMs"].as_u64().is_some_and(|n| n > 5000)
    })?;
    let duration = snapshot(&engine)["durationMs"]
        .as_u64()
        .ok_or("duration_missing")?;
    engine
        .handle(PlayerCommand::Play)
        .map_err(|_| "play_failed")?;
    wait(&engine, 10, |s| {
        s["positionMs"].as_u64().unwrap_or(0) >= 300
    })?;
    engine
        .handle(PlayerCommand::Pause)
        .map_err(|_| "pause_failed")?;
    wait(&engine, 5, |s| s["state"] == "paused")?;
    thread::sleep(Duration::from_millis(150));
    let paused = snapshot(&engine)["positionMs"]
        .as_u64()
        .ok_or("position_missing")?;
    thread::sleep(Duration::from_millis(350));
    if snapshot(&engine)["positionMs"]
        .as_u64()
        .unwrap_or(0)
        .abs_diff(paused)
        > 100
    {
        return Err("pause_not_stable");
    }
    engine
        .handle(PlayerCommand::Play)
        .map_err(|_| "resume_failed")?;
    wait(&engine, 10, |s| {
        s["positionMs"].as_u64().unwrap_or(0) > paused + 200
    })?;
    for target in [duration / 10, duration / 2, duration.saturating_sub(1200)] {
        engine
            .handle(PlayerCommand::Pause)
            .map_err(|_| "pause_failed")?;
        engine
            .handle(PlayerCommand::Seek {
                position: SeekPositionMs::new(target).map_err(|_| "seek_invalid")?,
            })
            .map_err(|_| "seek_failed")?;
        wait(&engine, 10, |s| {
            s["positionMs"]
                .as_u64()
                .is_some_and(|p| p.abs_diff(target) < 1000)
        })?;
        engine
            .handle(PlayerCommand::Play)
            .map_err(|_| "resume_failed")?;
        if target < duration / 2 + 1 {
            wait(&engine, 10, |s| {
                s["positionMs"].as_u64().is_some_and(|p| p > target + 200)
            })?;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut ended = false;
    while Instant::now() < deadline {
        match engine.try_event() {
            Some(NativePlayerEvent::Ended { .. }) => {
                ended = true;
                break;
            }
            Some(NativePlayerEvent::Failed { .. }) => return Err("native_media_failed"),
            _ => thread::sleep(Duration::from_millis(40)),
        }
    }
    if !ended {
        return Err("ended_event_missing");
    }
    engine
        .handle(PlayerCommand::Stop)
        .map_err(|_| "stop_failed")?;
    bridge.revoke();
    if client
        .get(&local)
        .send()
        .map_err(|_| "revoke_check_failed")?
        .status()
        != 404
    {
        return Err("revoke_failed");
    }
    let metrics = bridge.metrics();
    println!(
        "{}",
        serde_json::json!({"nativeAac":true,"muted":true,"durationMs":duration,"head":true,"range206":true,"range416":true,"seekPositions":3,"pauseResume":true,"endedEvent":true,"revoked":true,"nativeRangeRequests":metrics.range.load(Ordering::Relaxed)-before_native,"streamedBytes":metrics.bytes.load(Ordering::Relaxed),"bitrate":descriptor.bitrate})
    );
    Ok(())
}
