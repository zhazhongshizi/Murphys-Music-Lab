// WBI permutation and API shape reference: BBPlayer e2e7f52759ad8c79f54ab28021b43df473f849ed.
// See ../README.md and ../fixtures/upstream/bilibili/LICENSE.
import { createHash } from 'node:crypto';
const table = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
export function imageKey(value) {
  const name = new URL(value).pathname.split('/').at(-1);
  const match = /^([a-f0-9]{32})\.[a-z0-9]+$/.exec(name);
  if (!match) throw new Error('upstream_schema_changed');
  return match[1];
}
export function signWbi(params, img, sub, seconds) {
  if (!/^[a-f0-9]{32}$/.test(img) || !/^[a-f0-9]{32}$/.test(sub) || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error('invalid_wbi_input');
  const key = table.map(i=>(img+sub)[i]).join('').slice(0,32);
  const values = {...params,wts:String(seconds)};
  const query = Object.keys(values).sort().map(k=> {
    if (typeof values[k] !== 'string') throw new Error('invalid_wbi_input');
    return `${encodeURIComponent(k)}=${encodeURIComponent(values[k].replace(/[!'()*]/g,''))}`;
  }).join('&');
  return `${query}&w_rid=${createHash('md5').update(query+key).digest('hex')}`;
}
export function allowedCdn(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (!u.port || u.port === '443') && !u.username && !u.password && !u.hash
      && (u.hostname.endsWith('.bilivideo.com') || u.hostname.endsWith('.bilivideo.cn') || u.hostname === 'upos-hz-mirrorakam.akamaized.net');
  } catch { return false; }
}
export function selectAac(data) {
  const {url,bitrate,codec}=selectAacCandidates(data);
  return {url,bitrate,codec};
}
export function selectAacCandidates(data) {
  const options = (Array.isArray(data?.dash?.audio) ? data.dash.audio : [])
    .filter(a=>a.mimeType === 'audio/mp4' || a.mime_type === 'audio/mp4')
    .filter(a=>a.codecs === 'mp4a.40.2' && Number.isSafeInteger(a.bandwidth) && a.bandwidth > 0)
    .sort((a,b)=>b.bandwidth-a.bandwidth);
  for (const audio of options) {
    const urls = [audio.baseUrl ?? audio.base_url,...(audio.backupUrl ?? audio.backup_url ?? [])];
    const valid=[...new Set(urls.filter(allowedCdn))].slice(0,9);
    if (valid.length) {
      const segment=audio.SegmentBase??audio.segment_base;
      const initialization=segment?.Initialization??segment?.initialization;
      const indexRange=segment?.indexRange??segment?.index_range;
      if (segment && (!/^0-[0-9]{1,7}$/.test(initialization)||!/^\d{1,7}-\d{1,7}$/.test(indexRange))) throw new Error('upstream_schema_changed');
      return {url:valid[0],backupUrls:valid.slice(1),bitrate:audio.bandwidth,codec:'aac',...(segment?{dash:{initialization,indexRange}}:{})};
    }
  }
  throw new Error('unsupported_media');
}
async function json(path) {
  const response = await fetch(`https://api.bilibili.com${path}`, {
    headers:{'User-Agent':USER_AGENT,Referer:'https://www.bilibili.com/'},
    redirect:'error', signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`bilibili_http_${response.status}`);
  const reader = response.body.getReader();
  const chunks=[]; let length=0;
  try {
    while (true) {const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>1048576)throw new Error('upstream_response_too_large');chunks.push(value);}
  } finally {await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
}
// Manual public-media probe only. Production browsing must still be ready-gated.
// No cookie files, account APIs, favorites, login or write operations are accessed.
export async function resolvePublicProbe(bvid) {
  if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid)) throw new Error('invalid_bvid');
  const view = await json(`/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0 || !Number.isSafeInteger(view.data?.pages?.[0]?.cid)) throw new Error('video_unavailable');
  const cid = String(view.data.pages[0].cid);
  const nav = await json('/x/web-interface/nav');
  const keys = nav.data?.wbi_img;
  if (!keys) throw new Error('wbi_unavailable');
  const query = signWbi({bvid,cid,fnval:'16',fnver:'0',fourk:'0'},imageKey(keys.img_url),imageKey(keys.sub_url),Math.floor(Date.now()/1000));
  const result = await json(`/x/player/wbi/playurl?${query}`);
  if (result.code !== 0) throw new Error('playurl_unavailable');
  return {...selectAac(result.data),bvid,cid};
}
