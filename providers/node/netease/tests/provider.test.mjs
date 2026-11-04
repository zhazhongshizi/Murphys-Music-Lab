import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import Ajv from 'ajv/dist/2020.js';
import { NeteaseProvider, methods } from '../provider.mjs';
import { Transport, ProviderFault, parseUpstreamJson } from '../transport.mjs';
import { verifyUpstream, patchSource } from '../upstream-loader.mjs';
import { runProvider } from '../main.mjs';
const schema=JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.schema.json',import.meta.url)));
const constants=JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.constants.json',import.meta.url)));
const ajv=new Ajv({strict:false});ajv.addSchema(schema);
const track=n=>({id:n,name:`song ${n}`,ar:[{name:'artist'}],al:{name:'album',picUrl:'https://p1.music.126.net/a.jpg'},dt:120000});
const playlist=(n,owner='1',subscribed=false)=>({id:n,name:`list ${n}`,creator:{userId:owner},subscribed,trackCount:3,description:''});
class Fake {
  constructor(){this.calls=[];this.cookie='SYNTHETIC_ONLY';this.mode='';this.delayMs=0;}
  reset(){} setCookie(c){this.cookie=c;} restore(c){assert.equal(c.providerId,'netease');}
  credential(){return {version:1,providerId:'netease',payload:JSON.stringify({cookie:this.cookie})};}
  async call(name,p={}){
    this.calls.push([name,p]);
    if(this.delayMs>0)await new Promise(r=>setTimeout(r,this.delayMs));
    if(this.mode==='network')throw new ProviderFault('network_unavailable',true);
    if(this.mode==='limit')throw new ProviderFault('rate_limited',true,2000);
    if(this.mode==='verify')return {body:{code:8821,verifyId:'v1'},cookie:[]};
    if(this.mode==='expired')return {body:{code:301},cookie:[]};
    if(this.mode==='playlist403'&&name==='playlist_detail')return {body:{code:403},cookie:[]};
    if(this.mode==='playback460Top'&&name==='song_url_v1')return {body:{code:-460},cookie:[]};
    if(this.mode==='playback460Data'&&name==='song_url_v1')return {body:{code:200,data:[{id:1,url:null,code:-460,fee:0,freeTrialInfo:null}]},cookie:[]};
    if(this.mode==='search460'&&name==='cloudsearch')return {body:{code:-460},cookie:[]};
    if(this.mode==='vip'&&name==='song_url_v1')return {body:{code:200,data:[{id:1,url:null,code:-110,fee:1,freeTrialInfo:null}]},cookie:[]};
    if(this.mode==='grey'&&name==='song_url_v1')return {body:{code:200,data:[{id:1,url:null,code:404,fee:8,freeTrialInfo:null}]},cookie:[]};
    const data={
      login_status:{data:{code:200,account:{id:1},profile:{userId:1,nickname:'fixture'}}},
      logout:{code:200},
      cloudsearch:{result:{songCount:3,songs:[track(1),track(2)]}},search:{result:{playlistCount:1,playlists:[playlist(1)]}},
      user_playlist:{more:false,playlist:[{...playlist(1),specialType:5},playlist(2,'2',true),playlist(3)]},
      playlist_detail:{playlist:{...playlist(p.id??1),trackIds:[{id:1},{id:2},{id:3}]}},likelist:{ids:[1,2,3]},
      song_detail:{songs:(p.ids??'1').split(',').filter(n=>n!=='3').map(n=>n==='99'?{id:99,name:null,dt:0}:track(n))},
      lyric_new:{lrc:{lyric:'[00:01.00]line'},tlyric:{lyric:'[00:01.00]翻译'},romalrc:{lyric:'   '}},
      song_url_v1:{data:[{id:1,url:'https://m801.music.126.net/a.mp3',type:'mp3',br:320000,time:120000,expi:1200,fee:0,freeTrialInfo:this.mode==='trial'?{}:null}]},
    };
    if(!data[name])throw new Error('fixture missing');
    return {body:{code:200,...data[name]},cookie:[]};
  }
}
async function ready(){const t=new Fake(),p=new NeteaseProvider(t);await p.handle('auth.credential.restore',{credential:t.credential()});return {t,p};}
test('fixed sources verified; patch removes all unlock loading and QR undefined result at runtime',async()=>{
  verifyUpstream();
  const temp=mkdtempSync(join(tmpdir(),'netease-upstream-'));
  try {
    cpSync(new URL('../upstream/',import.meta.url),temp,{recursive:true});
    verifyUpstream(pathToFileURL(`${temp}/`));
    writeFileSync(join(temp,'extra.txt'),'unexpected');
    assert.throws(()=>verifyUpstream(pathToFileURL(`${temp}/`)),/upstream_integrity_failed/);
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
  const s=patchSource('module/song_url_v1.js',readFileSync(new URL('../upstream/module/song_url_v1.js',import.meta.url),'utf8'));
  assert.doesNotMatch(s,/require\(['"](?:dotenv|@neteasecloud)/);assert.doesNotMatch(s,/if \(query.unblock/);
  const calls=[];
  const t=new Transport(async(url)=>{
    calls.push(url.href);
    if(url.pathname.endsWith('/sk/get'))throw new Error('should not be called when key preset');
    return new Response(JSON.stringify({code:200,data:[{id:1,url:'https://m801.music.126.net/a.mp3',type:'mp3',br:128000,time:1000,expi:1200,fee:0,freeTrialInfo:null}]}),{headers:{'content-type':'application/json'}});
  });
  t.key={version:1,publicKey:Buffer.alloc(32,7).toString('base64'),sk:'k'};
  const r=await t.call('song_url_v1',{id:'1',level:'standard',unblock:'true'});
  assert.equal(r.body.code,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0],'https://interface3.music.163.com/xeapi/song/enhance/player/url/v1');
});
test('write profile still gates unlogged requests and omits refresh without network',async()=>{
  const t=new Fake(),p=new NeteaseProvider(t);
  await assert.rejects(p.handle('search.songs',{keyword:'x',page:1,pageSize:2}),e=>e.code==='authentication_required');
  for(const method of ['library.setLiked','library.setSubscribed','library.addItems','library.removeItems'])await assert.rejects(p.handle(method,{}),e=>e.code==='authentication_required');
  await assert.rejects(p.handle('auth.credential.refresh',{}),e=>e.code==='unsupported_capability');
  assert.equal(t.calls.length,0);assert.ok(methods.includes('library.addItems'));assert.ok(!methods.includes('auth.credential.refresh'));
});
test('all read projections satisfy frozen v2 schema and actual quality',async()=>{
  const {p}=await ready();
  const cases={
    'search.songs':{keyword:'x',page:1,pageSize:2},'search.playlists':{keyword:'x',page:1,pageSize:2},
    'song.detail':{songId:'1'},'library.containers':{kind:'created',page:1,pageSize:2},
    'library.likes':{page:2,pageSize:2},'library.tracks':{containerId:'1',page:1,pageSize:2},
    'lyrics.get':{songId:'1'},'playback.resolve':{track:{kind:'song',songId:'1'},preferredQuality:'flac'},
  };
  for(const [m,params] of Object.entries(cases)){
    const result=await p.handle(m,params);const check=ajv.compile({$ref:`${schema.$id}#/$defs/${constants.methods[m].result}`});
    assert.ok(check(result),`${m}: ${JSON.stringify(check.errors)}`);
    if(m==='playback.resolve')assert.equal(result.quality,'320k');
    if(m==='library.likes'){assert.equal(result.items[0].availability,'unavailable');assert.equal(result.hasMore,false);}
    if(m==='lyrics.get')assert.equal(result.romanization,null);
  }
  const deleted=await p.handle('song.detail',{songId:'99'});
  assert.equal(deleted.availability,'deleted');
});
test('filtered container pagination and likes preserve ID identity/order and >53-bit precision',async()=>{
  const {p}=await ready();const page=await p.handle('library.containers',{kind:'favorite',page:1,pageSize:1});
  assert.deepEqual(page.items.map(p=>p.id),['2']);assert.equal(page.total,1);
  assert.equal(parseUpstreamJson('{"id":9999999999999999999}').id,'9999999999999999999');
});
test('likes display matches the liked playlist across pages, refresh and reordered/missing song details; membership stays separate',async()=>{
  const {p,t}=await ready(),call=t.call.bind(t);
  let ordered=[9,3,7,1];
  t.call=async(name,q)=>{
    if(name==='user_playlist')return {body:{code:200,more:false,playlist:[
      {...playlist(8),name:'我喜欢的音乐'},
      {...playlist(6,'2'),specialType:5},
      {...playlist(5),name:'Renamed liked playlist',specialType:5},
    ]}};
    if(name==='playlist_detail'){
      assert.equal(q.id,'5');
      return {body:{code:200,playlist:{...playlist(5),trackCount:ordered.length,trackIds:ordered.map(id=>({id}))}}};
    }
    if(name==='song_detail')return {body:{code:200,songs:q.ids.split(',').reverse().filter(id=>id!=='3').map(track)}};
    return call(name,q);
  };
  const first=await p.handle('library.likes',{page:1,pageSize:2});
  const second=await p.handle('library.likes',{page:2,pageSize:2});
  const detail=await p.handle('library.tracks',{containerId:'5',page:1,pageSize:4});
  const ids=page=>page.items.map(t=>t.ref.songId);
  assert.deepEqual([...ids(first),...ids(second)],ids(detail));
  assert.deepEqual(ids(first),['9','3']);assert.deepEqual(ids(second),['7','1']);
  assert.equal(first.items[1].availability,'unavailable');
  assert.equal(first.total,4);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
  assert.equal(t.calls.some(([name])=>name==='likelist'),false);
  ordered=[1,7,3,9];
  assert.deepEqual(ids(await p.handle('library.likes',{page:1,pageSize:2})),['1','7']);
  assert.deepEqual(await p.handle('library.likeIds',{}),['1','2','3']);
});
test('liked playlist lookup follows container pagination and supports empty playlists',async()=>{
  const {p,t}=await ready(),offsets=[];
  t.call=async(name,q)=>{
    if(name==='user_playlist'){
      offsets.push(q.offset);
      return {body:{code:200,more:q.offset===0,playlist:q.offset===0
        ?[playlist(8),{...playlist(6,'2'),specialType:5}]
        :[{...playlist(5),specialType:5}]}};
    }
    assert.equal(name,'playlist_detail');assert.equal(q.id,'5');
    return {body:{code:200,playlist:{...playlist(5),trackCount:0,trackIds:[]}}};
  };
  assert.deepEqual(await p.handle('library.likes',{page:1,pageSize:2}),{page:1,total:0,hasMore:false,items:[]});
  assert.deepEqual(offsets,[0,2]);
});
test('missing or truncated liked playlist fails without falling back to unordered IDs',async()=>{
  for(const mode of ['missing','truncated','denied']) {
    const {p,t}=await ready(),calls=[];
    t.call=async(name)=>{
      calls.push(name);
      if(name==='user_playlist')return {body:{code:200,more:false,playlist:mode==='missing'?[playlist(8)]:[{...playlist(5),specialType:5}]}};
      assert.equal(name,'playlist_detail');
      return mode==='denied'?{body:{code:403}}:{body:{code:200,playlist:{...playlist(5),trackIds:[{id:1}]}}};
    };
    await assert.rejects(p.handle('library.likes',{page:1,pageSize:2}),e=>e.code===(mode==='denied'?'entitlement_denied':'upstream_schema_changed'));
    assert.deepEqual(calls,mode==='missing'?['user_playlist']:['user_playlist','playlist_detail']);
  }
});
test('preview is never returned as full playback; failures classified; no automatic retries',async()=>{
  const {p,t}=await ready();
  t.mode='trial';await assert.rejects(p.handle('playback.resolve',{track:{kind:'song',songId:'1'},preferredQuality:'auto'}),e=>e.code==='preview_only');
  t.mode='vip';await assert.rejects(p.handle('playback.resolve',{track:{kind:'song',songId:'1'},preferredQuality:'auto'}),e=>e.code==='entitlement_denied');
  t.mode='grey';await assert.rejects(p.handle('playback.resolve',{track:{kind:'song',songId:'1'},preferredQuality:'auto'}),e=>e.code==='media_unavailable');
  t.mode='playback460Top';await assert.rejects(p.handle('playback.resolve',{track:{kind:'song',songId:'1'},preferredQuality:'auto'}),e=>e.code==='media_unavailable');
  t.mode='playback460Data';await assert.rejects(p.handle('playback.resolve',{track:{kind:'song',songId:'1'},preferredQuality:'auto'}),e=>e.code==='media_unavailable');
  assert.equal(p.blocked,null);
  t.mode='playlist403';await assert.rejects(p.handle('library.tracks',{containerId:'1',page:1,pageSize:2}),e=>e.code==='entitlement_denied');
  t.mode='expired';await assert.rejects(p.handle('search.songs',{keyword:'x'}),e=>e.code==='credential_invalid');
  t.mode='search460';await assert.rejects(p.handle('search.songs',{keyword:'x'}),e=>e.code==='verification_required');
  p.blocked=null;
  t.mode='verify';await assert.rejects(p.handle('search.songs',{keyword:'x'}),e=>e.code==='verification_required');
  const before=t.calls.length;await assert.rejects(p.handle('library.likes',{page:1,pageSize:2}),e=>e.code==='verification_required');assert.equal(t.calls.length,before);
  t.mode='';
  const out=await p.handle('auth.logout',{});assert.equal(out.upstreamRevoked,true);
  await p.handle('auth.credential.restore',{credential:t.credential()});
  t.mode='limit';await assert.rejects(p.handle('search.songs',{keyword:'x'}),e=>e.code==='rate_limited'&&e.retryAfterMs===2000);
});
test('real Transport + loadUpstream executes QR start/poll and preserves classified faults in login_qr_check',async()=>{
  let qrPollMode='waiting';
  const t=new Transport(async(url)=>{
    if(url.pathname.endsWith('/login/qrcode/unikey'))return new Response(JSON.stringify({code:200,unikey:'SYNTHETIC_QR_KEY_123456'}),{headers:{'content-type':'application/json'}});
    if(url.pathname.endsWith('/login/qrcode/client/login')){
      if(qrPollMode==='rate_limited')return new Response('',{status:429,headers:{'retry-after':'5'}});
      if(qrPollMode==='waiting')return new Response(JSON.stringify({code:801}),{headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify({code:803}),{headers:{'content-type':'application/json','set-cookie':'MUSIC_U=SYNTHETIC_QR_COOKIE; Path=/; HttpOnly'}});
    }
    if(url.pathname.endsWith('/w/nuser/account/get'))return new Response(JSON.stringify({code:200,account:{id:'9007199254740993'},profile:{userId:'9007199254740993',nickname:'QRUser'}}),{headers:{'content-type':'application/json'}});
    throw new Error(`unexpected ${url.href}`);
  });
  const p=new NeteaseProvider(t);
  const start=await p.handle('auth.qr.start',{});
  assert.equal(start.mimeType,'image/png');
  assert.ok(start.imageBase64.length>64);
  const wait=await p.handle('auth.qr.poll',{sessionId:start.sessionId});
  assert.equal(wait.state,'waitingScan');
  p.session.last=0;qrPollMode='authenticated';
  const authed=await p.handle('auth.qr.poll',{sessionId:start.sessionId});
  assert.equal(authed.state,'authenticated');
  assert.equal(authed.account.id,'9007199254740993');
  assert.match(authed.credential.payload,/SYNTHETIC_QR_COOKIE/);
  await p.handle('auth.logout',{});
  const start2=await p.handle('auth.qr.start',{});
  qrPollMode='rate_limited';
  await assert.rejects(p.handle('auth.qr.poll',{sessionId:start2.sessionId}),e=>e.code==='rate_limited'&&e.retryAfterMs===5000);
});
test('runProvider pipe coalesces concurrent identical read requests and bounds execution',async()=>{
  const t=new Fake();t.delayMs=25;
  const p=new NeteaseProvider(t);
  await p.handle('auth.credential.restore',{credential:t.credential()});
  t.calls.length=0;
  const input=new PassThrough(),output=new PassThrough();
  const lines=[];output.on('data',chunk=>lines.push(chunk.toString('utf8')));
  const running=runProvider(p,input,output);
  input.write(JSON.stringify({v:2,id:'h1',method:'system.handshake',params:{protocolVersion:2,providerId:'netease'}})+'\n');
  await new Promise(r=>setTimeout(r,10));
  input.write(JSON.stringify({v:2,id:'s1',method:'search.songs',params:{keyword:'夜航',page:1,pageSize:20}})+'\n');
  input.write(JSON.stringify({v:2,id:'s2',method:'search.songs',params:{pageSize:20,page:1,keyword:'夜航'}})+'\n');
  input.end();
  await running;
  const frames=lines.join('').trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(frames.length,3);
  assert.equal(t.calls.filter(([name])=>name==='cloudsearch').length,1);
  assert.deepEqual(frames.filter(f=>f.id!=='h1').map(f=>[f.id,f.ok,f.result.items.length]),[['s1',true,2],['s2',true,2]]);
});
test('fixed transport emits only allowed upstream requests, preserves safe cookies, no key/temp files',async()=>{
  const calls=[];const t=new Transport(async(url,options)=>{
    calls.push([url.href,options]);return new Response(JSON.stringify({code:200,ids:[1]}),{headers:{'content-type':'application/json','set-cookie':'MUSIC_U=SYNTHETIC_ONLY; Path=/; HttpOnly'}});
  });
  const r=await t.call('likelist',{uid:'1'});assert.equal(r.body.code,200);assert.equal(calls.length,1);
  assert.equal(calls[0][0],'https://interfacepc.music.163.com/eapi/song/like/get');assert.equal(calls[0][1].redirect,'error');
  assert.match(t.credential().payload,/SYNTHETIC_ONLY/);assert.doesNotMatch(t.cookieString(),/HttpOnly|Path=/);
});
