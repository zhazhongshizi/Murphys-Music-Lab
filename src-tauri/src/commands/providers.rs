//! Desktop-only business commands. Remote's router does not register these.
use crate::{AppState, State};
use crate::multi_provider::{OnlineProviderId,protocol::Error};
use serde_json::Value;
use crate::multi_provider::writes::WriteRequest;
#[tauri::command]
pub(crate) async fn provider_likes(state:State<'_,AppState>)->Result<Value,String> {
    let r=state.registry.clone();
    tauri::async_runtime::spawn_blocking(move||r.sync_netease_likes()).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
fn fault(e:Error)->String {
    match e {Error::Upstream(code)=>serde_json::to_value(code).unwrap().as_str().unwrap().to_owned(), _=>e.to_string()}
}
fn new_provider(id:OnlineProviderId)->Result<(),String> {
    if matches!(id,OnlineProviderId::Netease|OnlineProviderId::Bilibili) {Ok(())} else {Err("unsupported_capability".into())}
}
#[tauri::command]
pub(crate) async fn provider_write(request:WriteRequest,state:State<'_,AppState>)->Result<Value,String> {
    let r=state.registry.clone();
    tauri::async_runtime::spawn_blocking(move||request.execute(&r,false)).await.map_err(|_|"outcome_unknown".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_verify_write(request:WriteRequest,state:State<'_,AppState>)->Result<Value,String> {
    let r=state.registry.clone();
    tauri::async_runtime::spawn_blocking(move||request.execute(&r,true)).await.map_err(|_|"verification_failed".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) fn provider_status(provider_id:OnlineProviderId,state:State<'_,AppState>)->Result<crate::multi_provider::lifecycle::ProviderSnapshot,String> {
    state.registry.snapshot(provider_id).map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_login(provider_id:OnlineProviderId,state:State<'_,AppState>)->Result<Value,String> {
    new_provider(provider_id)?;let r=state.registry.clone();
    tauri::async_runtime::spawn_blocking(move||r.login(provider_id)).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_poll(provider_id:OnlineProviderId,session_id:String,state:State<'_,AppState>)->Result<Value,String> {
    new_provider(provider_id)?;let r=state.registry.clone();let g=r.generation(provider_id).map_err(fault)?;
    tauri::async_runtime::spawn_blocking(move||r.poll(provider_id,g,&session_id)).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_cancel(provider_id:OnlineProviderId,session_id:String,state:State<'_,AppState>)->Result<(),String> {
    new_provider(provider_id)?;let r=state.registry.clone();let g=r.generation(provider_id).map_err(fault)?;
    tauri::async_runtime::spawn_blocking(move||r.cancel(provider_id,g,&session_id)).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_restore(provider_id:OnlineProviderId,state:State<'_,AppState>)->Result<bool,String> {
    new_provider(provider_id)?;let r=state.registry.clone();
    tauri::async_runtime::spawn_blocking(move||r.restore(provider_id)).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
#[tauri::command]
pub(crate) async fn provider_check(provider_id:OnlineProviderId,state:State<'_,AppState>)->Result<bool,String> {
    new_provider(provider_id)?;let r=state.registry.clone();let g=r.ready_generation(provider_id).map_err(fault)?;
    tauri::async_runtime::spawn_blocking(move||{
        let v=r.request(provider_id,g,"auth.credential.check",serde_json::json!({})).map_err(fault)?;
        if v["ok"]!=true{return Err(fault(Error::Upstream(serde_json::from_value(v["error"]["code"].clone()).map_err(|_|"provider_unavailable")?)));}
        v["result"]["valid"].as_bool().ok_or("upstream_schema_changed".into())
    }).await.map_err(|_|"provider_unavailable".to_string())?
}
#[tauri::command]
pub(crate) async fn provider_logout(provider_id:OnlineProviderId,state:State<'_,AppState>)->Result<(),String> {
    new_provider(provider_id)?;let r=state.registry.clone();let playback=state.playback_session.clone();
    tauri::async_runtime::spawn_blocking(move|| {
        // Stop only the matching source; queue/history are intentionally retained.
        if let Some(p)=&playback {
            let _=p.invalidate_provider_at(provider_id.into(),p.play_intent_token());
        }
        let res=r.sign_out(provider_id).map_err(fault);
        if let Some(p)=&playback {
            let _=p.invalidate_provider_at(provider_id.into(),p.play_intent_token());
        }
        res
    }).await.map_err(|_|"provider_unavailable".to_string())?
}
#[tauri::command]
pub(crate) async fn provider_read(provider_id:OnlineProviderId,method:String,params:Value,state:State<'_,AppState>)->Result<Value,String> {
    new_provider(provider_id)?;
    let n=state.netease.clone();let b=state.bilibili.clone();
    tauri::async_runtime::spawn_blocking(move||match provider_id {
        OnlineProviderId::Netease=>n.ok_or(Error::Unavailable)?.read(&method,params),
        OnlineProviderId::Bilibili=>b.ok_or(Error::Unavailable)?.read(&method,params),
        _=>Err(Error::Context),
    }).await.map_err(|_|"provider_unavailable".to_string())?.map_err(fault)
}
