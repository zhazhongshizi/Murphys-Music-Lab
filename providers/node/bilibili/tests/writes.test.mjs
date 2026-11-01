import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, response, view, BVID } from './fixture.mjs';
function setup(mode='') {
  const state={ids:new Set(),posts:[],mode,owner:42};
  const f=fixture({hook:async(u,o)=>{
    if(o.method==='POST') {
      const body=Object.fromEntries(new URLSearchParams(o.body));state.posts.push({path:u.pathname,body,options:o});
      assert.equal(body.csrf,'a'.repeat(32));assert.equal(o.redirect,'error');
      if(state.mode!=='partial') {
        if(u.pathname.endsWith('/deal'))state.ids.add(body.rid);
        else for(const resource of body.resources.split(','))state.ids.delete(resource.split(':')[0]);
      }
      if(state.mode==='lost'||state.mode==='second-lost'&&state.posts.length===2)throw new Error('response lost');
      if(state.mode==='risk')return response(null,{code:-352});
      return response({success_num:1});
    }
    if(state.posts.length&&state.mode==='read-failure'&&u.pathname.endsWith('/ids'))throw new Error('read failed');
    if(u.pathname.endsWith('/ids'))return response([...state.ids].map(id=>({id,bvid:BVID,type:2})));
    if(u.pathname.endsWith('/resource/list'))return response({info:{id:7,title:'Synthetic',intro:'',media_count:state.ids.size,upper:{mid:state.owner}},medias:[],has_more:false});
    if(u.pathname.endsWith('/view')&&u.searchParams.get('bvid')!==BVID)return response({...view,bvid:u.searchParams.get('bvid'),aid:170003});
    return null;
  }});
  f.provider.account={id:'42',displayName:'Synthetic'};
  f.transport.jar.setCookieSync('SESSDATA=SYNTHETIC_TEST_ONLY; Domain=.bilibili.com; Path=/; Secure','https://api.bilibili.com/');
  f.transport.jar.setCookieSync('bili_jct='+ 'a'.repeat(32)+'; Domain=.bilibili.com; Path=/; Secure','https://api.bilibili.com/');
  return {...f,state};
}
const params={containerId:'7',items:[{kind:'video',bvid:BVID}]};
test('same BV submits once; complete ids read confirms existing/missing and batch removal uses aid:2',async()=>{
  const {provider:p,state:s}=setup();
  assert.equal((await p.handle('library.addItems',params)).status,'applied');assert.equal(s.posts.length,1);
  assert.equal(s.posts[0].body.rid,String(view.aid));assert.equal(s.posts[0].body.type,'2');assert.equal(s.posts[0].body.add_media_ids,'7');
  await p.handle('library.addItems',params);assert.equal(s.posts.length,1);
  assert.equal((await p.handle('library.removeItems',params)).status,'applied');assert.equal(s.posts.length,2);
  assert.equal(s.posts[1].path,'/x/v3/fav/resource/batch-del');assert.equal(s.posts[1].body.resources,view.aid+':2');
  await p.handle('library.removeItems',params);assert.equal(s.posts.length,2);
});
for(const mode of ['foreign','missing-owner','missing-csrf','wrong-kind','missing-list'])test(`${mode} fails with zero write requests`,async()=>{
  const f=setup();if(mode==='foreign')f.state.owner=99;if(mode==='missing-owner')f.state.owner=undefined;
  if(mode==='missing-csrf')f.transport.jar.setCookieSync('bili_jct=; Max-Age=0; Domain=.bilibili.com; Path=/','https://api.bilibili.com/');
  if(mode==='missing-list')f.provider.transport.api=(async()=>({list:[]}));
  await assert.rejects(f.provider.handle('library.addItems',mode==='wrong-kind'?{...params,items:[{kind:'song',songId:'1'}]}:params));assert.equal(f.state.posts.length,0);
});
for(const mode of ['lost','partial','read-failure','risk'])test(`Bilibili ${mode} produces pending with no replay; refresh sends no POST`,async()=>{
  const {provider:p,state:s}=setup(mode);
  assert.deepEqual(await p.handle('library.addItems',params),{status:'verificationPending',affectedCount:null});assert.equal(s.posts.length,1);
  s.mode='';const receipt=await p.handle('library.verify',{method:'library.addItems',params});
  assert.equal(receipt.status,mode==='partial'?'verificationPending':'applied');assert.equal(s.posts.length,1);
});
test('multi-video partial outcome stops, never replays preceding items; duplicate BVs are collapsed',async()=>{
  const {provider:p,state:s}=setup('second-lost');
  const result=await p.handle('library.addItems',{...params,items:[...params.items,...params.items,{kind:'video',bvid:'BV17x411w7KD'}]});
  assert.equal(result.status,'verificationPending');assert.equal(s.posts.length,2);assert.notEqual(s.posts[0].body.rid,s.posts[1].body.rid);
});
test('queued write cannot cross a logout epoch',async()=>{
  const {provider:p,state:s}=setup();let release;p.tail=new Promise(r=>release=r);
  const w=p.handle('library.addItems',params),out=p.handle('auth.logout',{});release();await assert.rejects(w,e=>e.code==='cancelled');await out;assert.equal(s.posts.length,0);
});
test('complete resource ids checks a target beyond the first content page',async()=>{
  const {provider:p,state:s}=setup();for(let i=1;i<=200;i++)s.ids.add(String(i));s.ids.add(String(view.aid));
  assert.equal((await p.handle('library.addItems',params)).status,'applied');assert.equal(s.posts.length,0);
});
test('write redirect, 5xx, and a read endpoint used as POST are never retried',async()=>{
  for(const status of [302,500,503]) {
    const f=setup();let calls=0;
    const original=f.transport.fetcher;
    f.transport.fetcher=async(url,o)=>{if(o.method==='POST'){calls++;return new Response('',{status});}return original(url,o);};
    assert.equal((await f.provider.handle('library.addItems',params)).status,'verificationPending');assert.equal(calls,1);
    await assert.rejects(f.transport.write('/x/web-interface/nav',{},()=>{}));assert.equal(calls,1);
  }
});
