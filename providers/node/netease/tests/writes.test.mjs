import test from 'node:test';
import assert from 'node:assert/strict';
import { NeteaseProvider } from '../provider.mjs';
import { loadUpstream } from '../upstream-loader.mjs';
import { Transport } from '../transport.mjs';
function fixture(mode='') {
  const state={likes:new Set(['1']),members:new Set(Array.from({length:250},(_,i)=>String(i+1))),subscribed:false,writes:[],reads:[],owner:'42',mode};
  const t={reset(){},restore(){},credential(){return {version:1,providerId:'netease',payload:'SYNTHETIC_TEST_ONLY'};},async call(name,p={},send){
    state.reads.push(name);
    if(send) {
      send();state.writes.push([name,p]);
      if(state.mode==='rejected')return {body:{code:403}};
      if(state.mode!=='partial') {
        if(name==='like') {if(p.like==='true')state.likes.add(p.id);else state.likes.delete(p.id);}
        if(name==='playlist_subscribe')state.subscribed=p.t===1;
        if(name==='playlist_tracks')for(const id of p.tracks.split(',')){if(p.op==='add')state.members.add(id);else state.members.delete(id);}
      }
      if(state.mode==='lost')throw new Error('private secret must never escape');
      return {body:{code:200}};
    }
    if(state.writes.length&&state.mode==='read-failure')throw new Error('read failed');
    if(name==='login_status')return {body:{code:200,data:{account:{id:42},profile:{nickname:'Synthetic'}}}};
    if(name==='likelist')return {body:{code:200,ids:[...state.likes]}};
    if(name==='playlist_detail_dynamic')return {body:{code:200,subscribed:state.subscribed}};
    if(name==='playlist_detail')return {body:{code:200,playlist:{id:p.id,name:'Target',creator:state.owner?{userId:state.owner}:null,userId:state.conflict??state.owner,trackCount:state.members.size,trackIds:[...state.members].map(id=>({id})),subscribed:state.subscribed}}};
    if(name==='user_playlist')return {body:{code:200,more:false,playlist:[{id:'2',creator:{userId:state.owner},subscribed:false}]}};
    if(name==='logout')return {body:{code:200}};
    throw new Error('unexpected fixture call');
  }};
  const provider=new NeteaseProvider(t);provider.account={id:'42',displayName:'Synthetic'};return {provider,state,t};
}
for(const scenario of ['success','512','disconnect','timeout'])test(`actual fixed playlist_tracks module never resubmits: ${scenario}`,async()=>{
  const module=loadUpstream(()=>{throw new Error('unused');}).module('playlist_tracks');let calls=0;
  const invoke=()=>module({op:'add',pid:'2',tracks:'1,2'},async(uri,data)=>{
    calls++;assert.equal(uri,'/api/playlist/manipulate/tracks');assert.deepEqual(JSON.parse(data.trackIds),['1','2']);
    if(scenario!=='success'){const e=new Error(scenario);if(scenario==='512')e.body={code:512};throw e;}
    return {body:{code:200},status:200};
  });
  if(scenario==='success')assert.equal((await invoke()).body.code,200);else await assert.rejects(invoke());
  assert.equal(calls,1);
});
for(const scenario of ['success','512','disconnect','500'])test(`actual encrypted transport + loaded module sends once: ${scenario}`,async()=>{
  let calls=0;const t=new Transport(async()=>{calls++;if(scenario==='disconnect')throw new Error('disconnected');return new Response(JSON.stringify({code:scenario==='512'?512:200}),{status:scenario==='500'?500:200,headers:{'content-type':'application/json'}});});
  const p=t.call('playlist_tracks',{pid:'2',op:'add',tracks:'1,2'});
  if(['disconnect','500'].includes(scenario))await assert.rejects(p);else assert.equal((await p).body.code,scenario==='512'?512:200);
  assert.equal(calls,1);
});
test('liked, unlike, subscription and contents use explicit goals and complete membership; no-op count unknown',async()=>{
  const {provider:p,state:s}=fixture();
  for(const [method,params] of [
    ['library.setLiked',{songId:'3',liked:true}],['library.setLiked',{songId:'1',liked:false}],
    ['library.setSubscribed',{containerId:'2',subscribed:true}],['library.setSubscribed',{containerId:'2',subscribed:false}],
    ['library.removeItems',{containerId:'2',items:[{kind:'song',songId:'250'}]}],
    ['library.addItems',{containerId:'2',items:[{kind:'song',songId:'300'}]}],
  ])assert.deepEqual(await p.handle(method,params),{status:'applied',affectedCount:null});
  assert.equal(s.writes.length,6);
  assert.equal((await p.handle('library.addItems',{containerId:'2',items:[{kind:'song',songId:'300'}]})).status,'applied');assert.equal(s.writes.length,6);
});
for(const mode of ['foreign','missing','conflict','not-listed'])test(`ownership ${mode} refuses content with zero write`,async()=>{
  const {provider:p,state:s}=fixture();
  if(mode==='foreign')s.owner='99';if(mode==='missing')s.owner=null;if(mode==='conflict')s.conflict='99';
  await assert.rejects(p.handle('library.addItems',{containerId:mode==='not-listed'?'3':'2',items:[{kind:'song',songId:'300'}]}));assert.equal(s.writes.length,0);
});
test('subscription of another owner is independent of editing rights',async()=>{
  const {provider:p,state:s}=fixture();s.owner='99';
  assert.equal((await p.handle('library.setSubscribed',{containerId:'2',subscribed:true})).status,'applied');assert.equal(s.writes.length,1);
});
for(const mode of ['lost','read-failure','partial','rejected'])test(`sent ${mode} is pending, never resubmitted; verification is read only`,async()=>{
  const {provider:p,state:s}=fixture(mode);const params={songId:'3',liked:true};
  assert.deepEqual(await p.handle('library.setLiked',params),{status:'verificationPending',affectedCount:null});assert.equal(s.writes.length,1);
  s.mode='';const r=await p.handle('library.verify',{method:'library.setLiked',params});
  assert.equal(r.status,['partial','rejected'].includes(mode)?'verificationPending':'applied');assert.equal(s.writes.length,1);
});
test('queued write is cancelled by logout before send',async()=>{
  const {provider:p,state:s}=fixture();let release;const gate=new Promise(r=>release=r);p.tail=gate;
  const write=p.handle('library.setLiked',{songId:'3',liked:true});const logout=p.handle('auth.logout',{});release();
  await assert.rejects(write,e=>e.code==='cancelled');await logout;assert.equal(s.writes.length,0);
});
test('own-list permission proof pages until the target, never uses a stale collected label',async()=>{
  const {provider:p,state:s,t}=fixture();const call=t.call.bind(t);
  t.call=async(name,q,send)=>name==='user_playlist'?(q.offset===0?{body:{code:200,more:true,playlist:Array.from({length:100},(_,i)=>({id:String(1000+i),creator:{userId:42}}))}}:{body:{code:200,more:false,playlist:[{id:2,creator:{userId:42},subscribed:false}]}}):call(name,q,send);
  assert.equal((await p.handle('library.addItems',{containerId:'2',items:[{kind:'song',songId:'300'}]})).status,'applied');assert.equal(s.writes.length,1);
});
test('loaded like and subscription modules preserve explicit boolean/direction with one call and no dynamic SDK',async()=>{
  const upstream=loadUpstream(()=>{throw new Error('no SDK HTTP');});
  for(const liked of [true,false]) {
    let calls=0;await upstream.module('like')({id:'3',like:String(liked)},async(uri,data)=>{calls++;assert.equal(uri,'/api/radio/like');assert.equal(data.like,liked);return {body:{code:200}};});assert.equal(calls,1);
  }
  for(const t of [1,2]) {
    let calls=0;await upstream.module('playlist_subscribe')({id:'7',t},async(uri,data,options)=>{calls++;assert.equal(uri,t===1?'/api/playlist/subscribe':'/api/playlist/unsubscribe');assert.equal(data.id,'7');assert.equal(options.crypto,'eapi');return {body:{code:200}};});assert.equal(calls,1);
  }
});
