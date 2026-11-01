// Scoped adaptation of API Enhanced 4.41.1 util/request.js (MIT; see upstream/LICENSE).
// Only weapi/eapi/xeapi used by our fixed modules; no shared temp files, automatic
// key/token retries, random IP, alternate music sources, or unfiltered logging.
import { randomUUID } from 'node:crypto';
import { loadUpstream } from './upstream-loader.mjs';
export class ProviderFault extends Error {
  constructor(code, retryable=false, retryAfterMs) { super(code); this.code=code; this.retryable=retryable; this.retryAfterMs=retryAfterMs; }
}
export const fail = code => { throw new ProviderFault(code); };
const UA='NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)';
const HOSTS = new Set(['music.163.com','interface.music.163.com','interfacepc.music.163.com','interface3.music.163.com']);
export function parseUpstreamJson(text) {
  return JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context.source:value);
}
function cookies(value) {
  const out={};
  for(const part of value.split(';')) {
    const i=part.indexOf('='); if(i<1) continue;
    const k=part.slice(0,i).trim(),v=part.slice(i+1).trim();
    if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(k)) continue;
    if(!/^[A-Za-z0-9_.$-]+$/.test(k)||/[\r\n]/.test(v)) fail('upstream_schema_changed');
    out[k]=v;
  }
  return out;
}
export class Transport {
  constructor(fetcher=fetch) {
    this.fetcher=fetcher; this.cookie={}; this.deviceId=randomUUID().replaceAll('-','');
    this.key=null; this.keyFlight=null; this.sessionId=''; this.sessionKey='';
    this.upstream=loadUpstream(settings=>this.http(settings));
  }
  reset() { this.cookie={}; this.key=null; this.sessionId='';this.sessionKey=''; }
  setCookie(value) { Object.assign(this.cookie,cookies(value)); }
  cookieString() { return Object.entries(this.cookie).map(([k,v])=>`${k}=${v}`).join('; '); }
  credential() { return {version:1,providerId:'netease',payload:JSON.stringify({cookie:this.cookieString(),deviceId:this.deviceId})}; }
  restore(c) {
    if(c.version!==1||c.providerId!=='netease'||Buffer.byteLength(JSON.stringify(c))>65536) fail('credential_invalid');
    let payload;try{payload=JSON.parse(c.payload);}catch{fail('credential_invalid');}
    if(typeof payload.cookie!=='string'||!payload.cookie.trim()||(payload.deviceId!==undefined&&!/^[a-f0-9]{32}$/.test(payload.deviceId))) fail('credential_invalid');
    this.reset();this.setCookie(payload.cookie); if(payload.deviceId)this.deviceId=payload.deviceId;
  }
  async http({url,headers={},data}) {
    const u=new URL(url); if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.port||u.username||u.password) fail('upstream_schema_changed');
    let res;
    try { res=await this.fetcher(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:data,redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { throw new ProviderFault('network_unavailable',true); }
    if(res.status===429) {
      const v=res.headers.get('retry-after'); const n=v&&/^\d+$/.test(v)?Number(v)*1000:undefined;
      throw new ProviderFault('rate_limited',true,Number.isSafeInteger(n)&&n<=86400000?n:undefined);
    }
    if(!res.ok) throw new ProviderFault(res.status===401?'credential_invalid':res.status===403?'verification_required':'network_unavailable',res.status>=500);
    const chunks=[];let size=0;
    for await(const chunk of res.body) { size+=chunk.length;if(size>16*1024*1024) fail('upstream_schema_changed');chunks.push(chunk); }
    const body=Buffer.concat(chunks); const ct=res.headers.get('content-type')||'';
    let parsed=body;
    if(ct.includes('json')||body[0]===123){try{parsed=parseUpstreamJson(body.toString('utf8'));}catch{fail('upstream_schema_changed');}}
    return {data:parsed,status:res.status,headers:{'set-cookie':res.headers.getSetCookie(), 'x-encr-ssid':res.headers.get('x-encr-ssid'),'x-encr-sskey':res.headers.get('x-encr-sskey')}};
  }
  async ensureKey() {
    if(this.key)return this.key;
    if(!this.keyFlight)this.keyFlight=this.upstream.module('register_xeapikey')({deviceId:this.deviceId}).then(r=>this.key=r.body).finally(()=>this.keyFlight=null);
    return this.keyFlight;
  }
  async request(uri,data,options,beforeSend) {
    const conf=this.upstream.config,enc=this.upstream.crypto;
    const c={...this.cookie,...(typeof options.cookie==='string'?cookies(options.cookie):options.cookie),deviceId:this.deviceId,os:'pc',appver:'3.1.17.204416',__remember_me:'true'};
    const header={os:c.os,appver:c.appver,deviceId:this.deviceId,osver:'Microsoft-Windows-10',__csrf:c.__csrf||'',channel:'netease',requestId:`${Date.now()}_0001`};
    for(const k of ['MUSIC_U','MUSIC_A','NMTID'])if(c[k])header[k]=c[k];
    let url,body,headers={'User-Agent':UA};
    if(options.crypto==='weapi') {
      url=conf.domain+'/weapi/'+uri.slice(5);headers.Referer=conf.domain;headers.Cookie=Object.entries(c).map(([k,v])=>`${k}=${v}`).join('; ');
      body=enc.weapi({...data,e_r:false,csrf_token:c.__csrf||''});
    } else if(options.crypto==='xeapi') {
      const key=await this.ensureKey();
      url=conf.xeapiDomain+'/xeapi/'+uri.slice(5);
      headers={...headers,'X-Client-Enc-State':'ENCRYPTED','x-aeapi':'true','x-deviceid':this.deviceId,'x-sdeviceid':this.deviceId,'x-os':'android','x-osver':'16','x-appver':'9.1.65','x-buildver':String(Math.floor(Date.now()/1000))};
      if(c.MUSIC_U)headers['x-music-u']=c.MUSIC_U;
      headers.Cookie=Object.entries({...c,os:'android',appver:'9.1.65'}).map(([k,v])=>`${k}=${v}`).join('; ');
      body=enc.xeapi(uri,data,{publicKeyState:key,sessionId:this.sessionId,sessionKey:this.sessionKey,os:'android'});
    } else if(options.crypto==='eapi') {
      url=conf.eapiDomain+'/eapi/'+uri.slice(5);headers.Cookie=Object.entries(header).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');
      body=enc.eapi(uri,{...data,e_r:false,header});
    } else fail('unsupported_capability');
    beforeSend?.();
    const res=await this.http({url,headers,data:new URLSearchParams(body).toString()});
    const setCookies=res.headers['set-cookie'];
    for(const line of setCookies)this.setCookie(line.split(';',1)[0]);
    if(res.headers['x-encr-ssid']&&res.headers['x-encr-sskey']) {this.sessionId=res.headers['x-encr-ssid'];this.sessionKey=res.headers['x-encr-sskey'];}
    let result=res.data;
    if(Buffer.isBuffer(result)) {try{result=options.crypto==='xeapi'?enc.xeapiResDecrypt(result):parseUpstreamJson(result.toString('utf8'));}catch{fail('upstream_schema_changed');}}
    return {status:res.status,body:result,cookie:setCookies};
  }
  async call(name,query={},beforeSend) {
    let transportFault;
    try {return await this.upstream.module(name)({...query,cookie:{...this.cookie}},async(uri,data,opt)=>{
      try{return await this.request(uri,data,opt,beforeSend);}catch(e){if(e instanceof ProviderFault)transportFault=e;throw e;}
    });}catch(e){throw transportFault??e;}
  }
}
