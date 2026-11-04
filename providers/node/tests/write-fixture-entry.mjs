// Explicit synthetic-only host integration executable. Never loaded by production.
import { appendFileSync } from 'node:fs';
import { NeteaseProvider } from '../netease/provider.mjs';
import { runProvider as netRun } from '../netease/main.mjs';
import { runProvider as biliRun } from '../bilibili/main.mjs';
import { fixture, response, view } from '../bilibili/tests/fixture.mjs';
const [source,audit,mode='']=process.argv.slice(2);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let likes=new Set(['1']),members=new Set(['1']),subscribed=false;
async function onWrite(kind,data) {
  appendFileSync(audit,JSON.stringify({kind,data})+'\n');
  if(mode==='stall')await new Promise(()=>{});
  if(mode==='delay-sent')await delay(150);
}
if(source==='netease') {
  const t={reset(){},restore(){},async call(name,p={},send){
    if(send) {
      send();await onWrite(name,p);
      if(name==='like'){if(p.like==='true')likes.add(p.id);else likes.delete(p.id);}
      if(name==='playlist_tracks')for(const id of p.tracks.split(',')){if(p.op==='add')members.add(id);else members.delete(id);}
      if(name==='playlist_subscribe')subscribed=p.t===1;
      if(mode==='lost')throw new Error('synthetic lost response');
      return {body:{code:200}};
    }
    if(name==='login_status')return {body:{code:200,data:{account:{id:42},profile:{nickname:'Synthetic'}}}};
    if(name==='playlist_detail_dynamic')return {body:{code:200,subscribed}};
    if(name==='likelist'){const captured=[...likes];if(mode==='delay-read')await delay(150);return {body:{code:200,ids:captured}};}
    if(name==='playlist_detail'){
      if(mode==='delay-preflight')await delay(500);
      return {body:{code:200,playlist:{id:p.id,name:'Synthetic',creator:{userId:mode==='foreign'?99:42},userId:mode==='foreign'?99:42,subscribed,trackCount:members.size,trackIds:[...members].map(id=>({id}))}}};
    }
    if(name==='user_playlist')return {body:{code:200,more:false,playlist:[{id:'7',creator:{userId:42},subscribed:false}]}};
    if(name==='logout')return {body:{code:200}};
    throw new Error('unexpected synthetic call');
  }};
  await netRun(new NeteaseProvider(t));
} else if(source==='bilibili') {
  const f=fixture({hook:async(u,o)=>{
    if(o.method==='POST') {
      const p=Object.fromEntries(new URLSearchParams(o.body));await onWrite(u.pathname,p);
      if(u.pathname.endsWith('/deal'))members.add(p.rid);else for(const id of p.resources.split(','))members.delete(id.split(':')[0]);
      if(mode==='lost')throw new Error('synthetic lost response');return response({success_num:1});
    }
    if(u.pathname.endsWith('/resource/list'))return response({info:{id:7,title:'Synthetic',intro:'',media_count:members.size,upper:{mid:mode==='foreign'?99:42}},medias:[],has_more:false});
    if(u.pathname.endsWith('/resource/ids'))return response([...members].map(id=>({id,type:2,bvid:view.bvid})));
    return null;
  }});
  const restore=f.transport.restore.bind(f.transport);
  f.transport.restore=c=>{restore(c.payload==='SYNTHETIC_TEST_ONLY'?f.credential:c);f.transport.jar.setCookieSync('bili_jct='+'a'.repeat(32)+'; Domain=.bilibili.com; Path=/; Secure','https://api.bilibili.com/');};
  await biliRun(f.provider);
} else throw new Error('unsupported synthetic source');
