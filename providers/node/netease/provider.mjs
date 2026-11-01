import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { qrKey, qrImage, qrState } from './qr.ts';
import { Transport, ProviderFault, fail } from './transport.mjs';
import { writeContext, pendingWrite, verifiedWrite } from '../shared/write.mjs';
const constants=JSON.parse(readFileSync(new URL('../../../contracts/protocol-v2.constants.json',import.meta.url)));
export const capabilities={...constants.capabilities.netease};
export const methods=Object.keys(constants.methods).filter(m=>constants.methods[m].providers.includes('netease')&&m!=='auth.credential.refresh');
export const version='0.1.0';
function id(value) {
  if(typeof value==='number'&&!Number.isSafeInteger(value)) fail('upstream_schema_changed');
  const s=String(value);if(!/^[1-9][0-9]{0,19}$/.test(s))fail('upstream_schema_changed');return s;
}
function str(v,max=4096) {if(typeof v!=='string'||[...v].length>max)fail('upstream_schema_changed');return v;}
function int(v,max=Number.MAX_SAFE_INTEGER) {if(!Number.isSafeInteger(v)||v<0||v>max)fail('upstream_schema_changed');return v;}
function ok(response, context='') {
  const b=response?.body;if(!b||typeof b!=='object')fail('upstream_schema_changed');
  const code=b.code??b.data?.code;
  if(code===301||code===401||code===20004)fail('credential_invalid');
  if(code===429||code===405||code===-462) {
    const raw=b.retryAfterMs??b.data?.retryAfterMs;
    const retryAfterMs=Number.isSafeInteger(raw)&&raw>0&&raw<=86400000?raw:undefined;
    throw new ProviderFault('rate_limited',true,retryAfterMs);
  }
  if(code===8821||Boolean(b.verifyId||b.verifyUrl||b.data?.verifyId||b.data?.verifyUrl)||(code===-460&&context!=='playback'))fail('verification_required');
  if(context==='playback'&&code===-460)fail('media_unavailable');
  if(context==='playlist'&&code===403)fail('entitlement_denied');
  if(context==='playlist'&&code===404)fail('media_unavailable');
  if(code!==200)fail('upstream_schema_changed');return b;
}
function imageUrl(value) {
  if(!value)return null;
  const u=new URL(str(value,4096));
  if(!['http:','https:'].includes(u.protocol)||!u.hostname.endsWith('.music.126.net'))return null;
  u.protocol='https:';return u.href;
}
export function song(s) {
  if(!s||typeof s!=='object')fail('upstream_schema_changed');
  const songId=id(s.id);
  if(s.name===null)return {ref:{kind:'song',songId},title:'歌曲不可用',artist:'未知艺人',creatorKind:'artist',album:'',durationMs:int(s.dt??s.duration??0,86400000),coverUrl:null,availability:'deleted'};
  const artists=s.ar??s.artists,album=s.al??s.album;
  if(!Array.isArray(artists)||!album||typeof album!=='object')fail('upstream_schema_changed');
  const artist=artists.filter(Boolean).map(a=>str(a.name??'',256)).filter(Boolean).join(' / ')||'未知艺人';
  return {ref:{kind:'song',songId},title:str(s.name,512),artist,creatorKind:'artist',album:str(album.name??'',512),durationMs:int(s.dt??s.duration,86400000),coverUrl:imageUrl(album.picUrl),availability:s.noCopyrightRcmd?'unavailable':'unknown'};
}
function container(p,account) {
  const owner=id(p.creator?.userId??p.userId);
  const ownership=owner===account&&p.subscribed!==true?'created':'collected';
  return {id:id(p.id),kind:'playlist',ownership,ownerId:owner,title:str(p.name,512),description:str(p.description??'',4096),itemCount:int(p.trackCount??0,10000000),allowedActions:[]};
}
function canonicalParams(method,p={}) {
  const paged=['search.songs','search.playlists','library.containers','library.likes','library.tracks'].includes(method);
  const norm=paged?{page:1,pageSize:20,...p}:{...p};
  return Object.keys(norm).sort().map(k=>[k,norm[k]]);
}
export class NeteaseProvider {
  constructor(transport=new Transport()) {this.transport=transport;this.account=null;this.session=null;this.blocked=null;this.epoch=0;this.inflight=new Map();this.tail=Promise.resolve();}
  async accountInfo() {
    const b=ok(await this.transport.call('login_status'));const d=b.data??b;
    if(!d.account||!d.profile)fail('credential_invalid');
    return {id:id(d.account.id??d.profile.userId),displayName:str(d.profile.nickname,512)};
  }
  async handle(method,p) {
    if(!methods.includes(method))fail('unsupported_capability');
    if(method==='system.handshake')return {protocolVersion:2,provider:{id:'netease',name:'netease-provider',version},maxLineBytes:1048576,capabilities,implementedMethods:methods};
    if(method==='system.ping')return {alive:true};
    // Serialize network operations and coalesce identical in-flight reads. The
    // host shares this process between desktop/Remote. No background request loop.
    const readonly=constants.methods[method].semantics==='readOnly';
    if(method.startsWith('library.')&&!readonly)this.readRevision=(this.readRevision??0)+1;
    const key=readonly?JSON.stringify([this.epoch,this.readRevision??0,method,canonicalParams(method,p)]):null;
    if(key&&this.inflight.has(key))return this.inflight.get(key);
    if(method==='auth.logout')this.epoch++;
    const epoch=this.epoch,account=this.account?.id;
    if(method==='library.verify'&&p.method==='library.setLiked'&&!this.account)fail('authentication_required');
    const job=this.tail.then(()=>method.startsWith('library.')&&constants.methods[method].semantics==='neverReplay'
      ?this.write(method,p,epoch,account):method==='library.verify'?this.write(p.method,p.params,epoch,account,true):this.dispatch(method,p));
    this.tail=job.catch(()=>{});
    if(key){this.inflight.set(key,job);job.then(()=>this.inflight.delete(key),()=>this.inflight.delete(key));}
    return job;
  }
  async dispatch(method,p) {
    if(this.blocked&&method!=='auth.logout')throw this.blocked;
    try { return await this.perform(method,p); }
    catch(e) {if(e instanceof ProviderFault&&['verification_required','rate_limited'].includes(e.code))this.blocked=e;throw e;}
  }
  async perform(method,p) {
    if(method==='auth.qr.start') {
      if(this.account||this.session)fail('invalid_params');
      const key=qrKey(await this.transport.call('login_qr_key'));
      const sessionId=randomUUID(),expires=Date.now()+180000;
      const image=qrImage(await this.transport.call('login_qr_create',{key,qrimg:true}),sessionId,expires);
      this.session={key,id:sessionId,expires,last:0,result:null};return image;
    }
    if(method==='auth.qr.poll'||method==='auth.qr.cancel') {
      const s=this.session;if(!s||s.id!==p.sessionId)fail('invalid_params');
      if(method.endsWith('cancel')){this.session=null;return {sessionId:p.sessionId,state:'cancelled'};}
      if(Date.now()>=s.expires)return {sessionId:s.id,state:'expired'};
      if(s.result&&Date.now()-s.last<2000)return s.result;
      const response=await this.transport.call('login_qr_check',{key:s.key});
      const state=await qrState(response,s.id,async cookie=>{this.transport.setCookie(cookie);return this.accountInfo();});
      if(state.state==='authenticated') {this.epoch++;this.account=state.account;state.credential=this.transport.credential();}
      s.result=state;s.last=Date.now();return state;
    }
    if(method==='auth.credential.restore') {if(this.account)fail('invalid_params');this.transport.restore(p.credential);this.account=await this.accountInfo();this.epoch++;return {account:this.account};}
    if(method==='auth.logout') {
      const hadAccount=Boolean(this.account);
      let upstreamRevoked=false;
      if(hadAccount){try{await this.transport.call('logout');upstreamRevoked=true;}catch{}}
      this.transport.reset();this.account=null;this.session=null;this.blocked=null;this.epoch++;
      return {upstreamRevoked};
    }
    if(!this.account)fail('authentication_required');
    if(method==='auth.credential.check') {try{return {valid:true,account:await this.accountInfo()};}catch(e){if(e.code==='credential_invalid')return {valid:false};throw e;}}
    if(method==='library.container')return this.containerDetail(p.containerId);
    if(method==='library.likeIds')return [...await this.likedIds()];
    const {page=1,pageSize=20}=p,offset=(page-1)*pageSize;
    const pageResult=(items,total)=>({page,total,hasMore:total===null?items.length>pageSize:offset+pageSize<total,items:items.slice(0,pageSize)});
    if(method==='search.songs') {
      const b=ok(await this.transport.call('cloudsearch',{keywords:p.keyword,type:1,limit:pageSize,offset}));
      const r=b.result??{};if(typeof r!=='object'||!Array.isArray(r.songs??[]))fail('upstream_schema_changed');
      return pageResult((r.songs??[]).map(song),int(r.songCount??0));
    }
    if(method==='search.playlists') {
      const r=ok(await this.transport.call('search',{keywords:p.keyword,type:1000,limit:pageSize,offset})).result??{};
      if(typeof r!=='object'||!Array.isArray(r.playlists??[]))fail('upstream_schema_changed');
      return pageResult((r.playlists??[]).map(v=>container(v,this.account.id)),int(r.playlistCount??0));
    }
    if(method==='song.detail')return (await this.details([p.songId]))[0];
    if(method==='library.containers') {
      const list=[];let cursor=0;
      while(list.length<=offset+pageSize) {
        const b=ok(await this.transport.call('user_playlist',{uid:this.account.id,limit:100,offset:cursor}));
        if(!Array.isArray(b.playlist))fail('upstream_schema_changed');
        list.push(...b.playlist.map(v=>container(v,this.account.id)).filter(v=>v.ownership===(p.kind==='created'?'created':'collected')));
        cursor+=b.playlist.length;
        if(!b.more||b.playlist.length===0)return pageResult(list.slice(offset,offset+pageSize),list.length);
        if(cursor>10000)fail('upstream_schema_changed');
      }
      return pageResult(list.slice(offset,offset+pageSize+1),null);
    }
    if(method==='library.likes'||method==='library.tracks') {
      const b=ok(await this.transport.call(method==='library.likes'?'likelist':'playlist_detail',method==='library.likes'?{uid:this.account.id}:{id:p.containerId}),method==='library.tracks'?'playlist':'');
      const raw=method==='library.likes'?b.ids:b.playlist?.trackIds?.map(t=>t.id);
      if(!Array.isArray(raw))fail('upstream_schema_changed');
      const ids=raw.slice(offset,offset+pageSize).map(id);
      return pageResult(ids.length?await this.details(ids):[],raw.length);
    }
    if(method==='lyrics.get') {
      const b=ok(await this.transport.call('lyric_new',{id:p.songId}));
      const clean=v=>typeof v==='string'&&v.trim()?str(v,65536):null;
      return {songId:p.songId,original:clean(b.lrc?.lyric),translation:clean(b.tlyric?.lyric),romanization:clean(b.romalrc?.lyric)};
    }
    if(method==='playback.resolve') {
      if(p.track.kind!=='song')fail('invalid_params');
      const level={auto:'lossless',flac:'lossless','320k':'exhigh','128k':'standard'}[p.preferredQuality];if(!level)fail('unsupported_capability');
      const b=ok(await this.transport.call('song_url_v1',{id:p.track.songId,level}),'playback');
      const r=b.data?.find(v=>id(v.id)===p.track.songId);if(!r)fail('upstream_schema_changed');
      if(r.freeTrialInfo&&r.freeTrialInfo!=='null')fail('preview_only');
      if(!r.url)fail(r.code===403||r.code===-110||r.fee===1||r.fee===4?'entitlement_denied':'media_unavailable');
      const codec=String(r.type).toLowerCase();if(!['flac','mp3'].includes(codec))fail('unsupported_media');
      const u=new URL(r.url);if(!['http:','https:'].includes(u.protocol)||!u.hostname.endsWith('.music.126.net')||u.username||u.password||u.port)fail('upstream_schema_changed');u.protocol='https:';
      const bitrate=int(r.br,10000000),durationMs=int(r.time??(await this.details([p.track.songId]))[0].durationMs,86400000);
      return {track:p.track,quality:codec==='flac'?'flac':bitrate>=256000?'320k':'128k',codec,bitrate,url:u.href,headers:{},expiresInSeconds:int(r.expi,86400),durationMs};
    }
    fail('unsupported_capability');
  }
  async playlist(containerId) {
    const b=ok(await this.transport.call('playlist_detail',{id:containerId}),'playlist');
    const p=b.playlist;
    if(!p||id(p.id)!==containerId||!Array.isArray(p.trackIds)||int(p.trackCount,100000)!==p.trackIds.length)fail('upstream_schema_changed');
    return p;
  }
  async containerDetail(containerId) {
    const p=await this.playlist(containerId),result=container(p,this.account.id);
    // Owner from fresh detail, and inclusion in the confirmed account's own
    // playlist listing. Subscription alone grants no content permission.
    if(result.ownerId===this.account.id&&p.subscribed!==true&&(p.userId===undefined||id(p.userId)===this.account.id)) {
      let offset=0;
      for(let n=0;n<100;n++) {
        const b=ok(await this.transport.call('user_playlist',{uid:this.account.id,limit:100,offset}));
        if(!Array.isArray(b.playlist)||typeof b.more!=='boolean')fail('upstream_schema_changed');
        const found=b.playlist.find(x=>id(x.id)===containerId);
        if(found) {
          if(id(found.creator?.userId)!==this.account.id||found.subscribed===true)fail('entitlement_denied');
          if(found.userId!==undefined&&id(found.userId)!==this.account.id)fail('entitlement_denied');
          result.allowedActions=['playlist.addTracks','playlist.removeTracks'];break;
        }
        if(!b.more)break;
        if(!b.playlist.length||n===99)fail('upstream_schema_changed');offset+=b.playlist.length;
      }
    }
    if(result.ownerId!==this.account.id)result.allowedActions=['playlist.subscribe','playlist.unsubscribe'];
    return result;
  }
  async likedIds() {
    const ids=ok(await this.transport.call('likelist',{uid:this.account.id})).ids;
    if(!Array.isArray(ids)||ids.length>100000)fail('upstream_schema_changed');return new Set(ids.map(id));
  }
  async subscriptionState(containerId) {
    const b=ok(await this.transport.call('playlist_detail_dynamic',{id:containerId}));
    if(typeof b.subscribed!=='boolean'||b.id!==undefined&&id(b.id)!==containerId)fail('upstream_schema_changed');
    return b.subscribed;
  }
  async write(method,p,epoch,account,verifyOnly=false) {
    const ctx=writeContext(this,epoch,account,fail);ctx.check();
    if(this.blocked)throw this.blocked;
    if((await this.accountInfo()).id!==account)fail('credential_invalid');ctx.check();
    let target,read,send;
    if(method==='library.setLiked') {
      target=p.liked;read=async()=> (await this.likedIds()).has(p.songId)===target;
      send=()=>this.transport.call('like',{id:p.songId,like:String(target)},ctx.beforeSend);
    } else if(method==='library.setSubscribed') {
      await this.containerDetail(p.containerId);ctx.check();
      target=p.subscribed;
      read=async()=> (await this.subscriptionState(p.containerId))===target;
      send=()=>this.transport.call('playlist_subscribe',{id:p.containerId,t:target?1:2},ctx.beforeSend);
    } else {
      if(!Array.isArray(p.items)||p.items.length<1||p.items.length>100||p.items.some(x=>x.kind!=='song'))fail('invalid_params');
      const detail=await this.containerDetail(p.containerId);ctx.check();
      const action=method==='library.addItems'?'playlist.addTracks':'playlist.removeTracks';
      if(!detail.allowedActions.includes(action))fail('entitlement_denied');
      const ids=[...new Set(p.items.map(x=>id(x.songId)))];target=method==='library.addItems';
      read=async()=> {const set=new Set((await this.playlist(p.containerId)).trackIds.map(x=>id(x.id)));return ids.every(x=>set.has(x)===target);};
      send=()=>this.transport.call('playlist_tracks',{pid:p.containerId,op:target?'add':'del',tracks:ids.join(',')},ctx.beforeSend);
    }
    if(await read()){ctx.check();return verifiedWrite();}ctx.check();
    if(verifyOnly)return pendingWrite();
    // Error after beforeSend may mean the platform applied it. Readback is one
    // bounded attempt, never a retry of the write (including code 512).
    try {ok(await send());ctx.check();const matches=await read();ctx.check();return matches?verifiedWrite():pendingWrite();}
    catch(e){if(ctx.sent)return pendingWrite();throw e;}
  }
  async details(ids) {
    const b=ok(await this.transport.call('song_detail',{ids:ids.join(',')}));if(!Array.isArray(b.songs))fail('upstream_schema_changed');
    const mapped=new Map(b.songs.map(s=>[id(s.id),song(s)]));
    return ids.map(key=>mapped.get(key)??{ref:{kind:'song',songId:key},title:'歌曲不可用',artist:'未知艺人',creatorKind:'artist',album:'',durationMs:0,coverUrl:null,availability:'unavailable'});
  }
}
