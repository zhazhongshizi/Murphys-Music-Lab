//! Explicit isolated public-media probe. Synthetic auth is not real login evidence.
use qqmusic_gui_lib::{multi_provider::{bilibili::{self, BilibiliService}, registry::ProviderRegistry, protocol::Error, secrets::{Store, Prepared}, OnlineProviderId},
    playback::{PlaybackController, PlaybackQuality}, player::{WindowsMediaPlayerEngine, TrackSummary, NativePlayerEvent}, provider::{ProviderLaunch, ProviderRequestPort, ProviderRequest, ProviderReply, ProviderError}};
use serde_json::json;
use std::{sync::Arc, path::Path, time::{Duration,Instant}, thread};
use zeroize::Zeroizing;
struct Synthetic;
impl Store for Synthetic {
    fn read(&self)->Result<Option<Zeroizing<Vec<u8>>>,Error> { Ok(Some(Zeroizing::new(serde_json::to_vec(&json!({"version":1,"providerId":"bilibili","payload":"SYNTHETIC_PUBLIC_PROBE"})).unwrap()))) }
    fn prepare(&self,_:&[u8])->Result<Box<dyn Prepared>,Error>{Err(Error::Storage)}
    fn delete(&self)->Result<(),Error>{Ok(())}
}
struct NoQq;
impl ProviderRequestPort for NoQq {
    fn request(&self,_:ProviderRequest)->Result<ProviderReply,ProviderError>{panic!("public Bilibili probe cannot call QQ")}
}
fn wait(p:&PlaybackController,seconds:u64,predicate:impl Fn(&serde_json::Value)->bool)->Result<(), &'static str>{
    let until=Instant::now()+Duration::from_secs(seconds);
    while Instant::now()<until {
        if matches!(p.try_native_event(),Some(NativePlayerEvent::Failed{..})){return Err("native_failed");}
        if predicate(&serde_json::to_value(p.snapshot()).unwrap()){return Ok(());}
        thread::sleep(Duration::from_millis(50));
    }
    Err("native_timeout")
}
fn run()->Result<(), &'static str>{
    let args:Vec<_>=std::env::args().skip(1).collect();
    if args.len()<2 || args.len()>3 || args[0]!="--public-probe" {return Err("explicit_public_probe_required");}
    let bvid=&args[1]; let part=args.get(2).map(|p|p.parse::<usize>()).transpose().map_err(|_|"invalid_part")?.unwrap_or(1);
    if part==0 || part>10000 {return Err("invalid_part");}
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let node=root.join("output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe");
    let mut r=bilibili::registration(root,&node).map_err(|_|"registration_failed")?;
    r.launch=ProviderLaunch::new(&node).map_err(|_|"launch_failed")?.args([root.join("providers/node/bilibili/tests/public-native-entry.mjs").into_os_string(),"--public-probe".into(),bvid.into()]).current_dir(root).map_err(|_|"launch_failed")?;
    let mut registry=ProviderRegistry::default();registry.register(r,Arc::new(Synthetic)).map_err(|_|"registration_failed")?;
    registry.restore(OnlineProviderId::Bilibili).map_err(|_|"public_keys_unavailable")?;
    let service=Arc::new(BilibiliService::new(Arc::new(registry)));
    let page=(part-1)/100+1;
    let parts=service.read("video.parts",json!({"bvid":bvid,"page":page,"pageSize":100})).map_err(|_|"public_parts_unavailable")?;
    let selected=parts["items"].as_array().and_then(|xs|xs.get((part-1)%100)).ok_or("part_unavailable")?;
    let track=bilibili::queue_track_from_provider_track(selected).map_err(|_|"invalid_track")?;
    let native=WindowsMediaPlayerEngine::new().map_err(|_|"native_unavailable")?;
    let player=PlaybackController::new(Arc::new(NoQq),Box::new(native)).with_bilibili(service.clone());
    player.set_muted(true).map_err(|_|"mute_failed")?;
    let result=player.resolve_load_and_play(TrackSummary{source:None,id:track.id,title:track.title,artist:track.artist},PlaybackQuality::Auto).map_err(|_|"production_resolve_failed")?;
    wait(&player,30,|s|s["durationMs"].as_u64().is_some_and(|d|d>5000)).map_err(|_|"open_timeout")?;
    let duration=serde_json::to_value(player.snapshot()).unwrap()["durationMs"].as_u64().ok_or("missing_duration")?;
    wait(&player,15,|s|s["positionMs"].as_u64().unwrap_or(0)>300).map_err(|_|"initial_play_timeout")?;
    player.pause().map_err(|_|"pause_failed")?; wait(&player,5,|s|s["state"]=="paused")?;
    thread::sleep(Duration::from_millis(150));let paused=serde_json::to_value(player.snapshot()).unwrap()["positionMs"].as_u64().unwrap_or(0);
    thread::sleep(Duration::from_millis(350));if serde_json::to_value(player.snapshot()).unwrap()["positionMs"].as_u64().unwrap_or(0).abs_diff(paused)>100{return Err("pause_not_stable");}
    player.play().map_err(|_|"resume_failed")?;wait(&player,10,|s|s["positionMs"].as_u64().unwrap_or(0)>paused+200)?;
    for target in [duration/10,duration/2,duration.saturating_sub(1200)] {
        eprintln!("public_probe_seek:targetMs={target},durationMs={duration}");
        player.pause().map_err(|_|"pause_failed")?;player.seek(target).map_err(|_|"seek_failed")?;
        wait(&player,25,|s|s["positionMs"].as_u64().unwrap_or(0).abs_diff(target)<1000).map_err(|_|"seek_position_timeout")?;
        player.play().map_err(|_|"resume_failed")?;
        if target<duration/2+1{wait(&player,15,|s|s["positionMs"].as_u64().unwrap_or(0)>target+200)?;}
    }
    let until=Instant::now()+Duration::from_secs(15);let mut ended=false;
    while Instant::now()<until {
        match player.try_native_event(){Some(NativePlayerEvent::Ended{..})=>{ended=true;break;},Some(NativePlayerEvent::Failed{..})=>return Err("native_failed"),_=>thread::sleep(Duration::from_millis(40))}
    }
    if !ended{return Err("ended_missing");}
    player.stop().map_err(|_|"stop_failed")?;
    service.registry.sign_out(OnlineProviderId::Bilibili).map_err(|_|"probe_logout_failed")?;
    println!("{}",json!({"probe":"production-bilibili-public","syntheticAuth":true,"part":part,"durationMs":duration,"quality":result.quality,"bitrate":result.bitrate,"seekPoints":3,"pauseResume":true,"ended":true,"muted":true}));
    Ok(())
}
fn main(){if let Err(code)=run(){eprintln!("bilibili_production_probe_failed:{code}");std::process::exit(2);}}
