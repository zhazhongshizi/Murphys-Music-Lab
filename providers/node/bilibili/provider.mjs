// API shapes: BBPlayer @ e2e7f52759ad8c79f54ab28021b43df473f849ed.
// Exact source/permission notice: reference/ and README.md. No mobile runtime.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { Transport } from './transport.mjs';
import { fail, ProviderFault } from './fault.mjs';
import { BV, DIGITS, resolveInput } from './links.mjs';
import { imageKey, signWbi, selectAacCandidates, USER_AGENT } from './audio.mjs';
import { writeContext, pendingWrite, verifiedWrite } from '../shared/write.mjs';

const constants = JSON.parse(readFileSync(new URL('../../../contracts/protocol-v2.constants.json', import.meta.url)));
export const capabilities = { ...constants.capabilities.bilibili };
export const methods = ['system.handshake', 'system.ping', 'auth.qr.start', 'auth.qr.poll', 'auth.qr.cancel',
  'auth.credential.restore', 'auth.credential.check', 'auth.logout', 'search.videos', 'video.resolve',
  'video.parts', 'library.containers', 'library.videos', 'playback.resolve', 'library.container', 'library.verify', 'library.addItems', 'library.removeItems'];
export const version = '0.1.0';
function id(v) {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) fail('upstream_schema_changed');
  const s = String(v); if (!DIGITS.test(s)) fail('upstream_schema_changed'); return s;
}
function str(v, max = 512, empty = false) {
  if (typeof v !== 'string' || (!empty && !v.length) || [...v].length > max || /[\r\n\0]/.test(v)) fail('upstream_schema_changed');
  return v;
}
function description(v) {
  if (typeof v !== 'string' || [...v].length > 4096 || /\0/.test(v)) fail('upstream_schema_changed');
  return v;
}
function int(v, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('upstream_schema_changed'); return v;
}
function duration(v, max = 86400000) {
  if (typeof v === 'string' && /^\d+:\d{2}(:\d{2})?$/.test(v)) v = v.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  return int(v * 1000, max);
}
export function plainTitle(v) {
  const text = str(v, 4096).replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, (full, e) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    if (entities[e]) return entities[e];
    const code = e.toLowerCase().startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
  });
  return str(text);
}
export function videoCover(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol) || !['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.hash || url.href.length > 2048) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}
function bvid(v) { if (typeof v !== 'string' || !BV.test(v)) fail('upstream_schema_changed'); return v; }
export function video(v, search = false) {
  const availability = v.attr === 9 || v.attr === 1 ? 'deleted' : v.state === -4 ? 'processing'
    : v.state < 0 ? 'unavailable' : 'unknown';
  return { bvid: bvid(v.bvid), aid: id(v.aid ?? v.id), title: search ? plainTitle(v.title) : str(v.title),
    uploader: str(v.owner?.name ?? v.upper?.name ?? v.author ?? '未知 UP 主'), durationMs: duration(v.duration ?? 0, 864000000000),
    coverUrl: videoCover(v.pic ?? v.cover), availability };
}
function folder(v, account, created) {
  const owner = id(v.mid ?? v.upper?.mid);
  return { id: id(v.id), kind: 'favoriteFolder', ownership: created && owner === account ? 'created' : 'collected',
    ownerId: owner, title: str(v.title), description: description(v.intro ?? ''),
    itemCount: int(v.media_count, 10000000), allowedActions: [] };
}
function array(v) { if (!Array.isArray(v)) fail('upstream_schema_changed'); return v; }
function paged(items, page, pageSize, total = items.length) {
  const offset = (page - 1) * pageSize;
  return { page, hasMore: offset + pageSize < total, total, items: items.slice(offset, offset + pageSize) };
}
export class BilibiliProvider {
  constructor(transport = new Transport(), { now = () => Date.now(), linkFetch } = {}) {
    this.transport = transport; this.now = now; this.linkFetch = linkFetch;
    this.account = null; this.session = null; this.keys = null; this.epoch = 0;
    this.inflight = new Map(); this.tail = Promise.resolve(); this.blocked = null;
  }
  async nav() {
    const d = await this.transport.api('/x/web-interface/nav');
    if (d?.isLogin === false) fail('credential_invalid');
    if (d?.isLogin !== true) fail('upstream_schema_changed');
    const account = { id: id(d.mid), displayName: str(d.uname) };
    this.keys = { img: imageKey(d.wbi_img?.img_url), sub: imageKey(d.wbi_img?.sub_url), until: this.now() + 3600000 };
    return account;
  }
  async signed(path, params, context = '') {
    if (!this.keys || this.keys.until <= this.now()) {
      const account = await this.nav();
      if (!this.account || account.id !== this.account.id) fail('credential_invalid');
    }
    return this.transport.api(path, signWbi(params, this.keys.img, this.keys.sub, Math.floor(this.now() / 1000)), context);
  }
  async handle(method, params = {}) {
    if (!methods.includes(method)) fail('unsupported_capability');
    if (method === 'system.handshake') return { protocolVersion: 2, provider: { id: 'bilibili', name: 'bilibili-provider', version }, maxLineBytes: 1048576, capabilities, implementedMethods: methods };
    if (method === 'system.ping') return { alive: true };
    const paging = ['search.videos', 'video.parts', 'library.containers', 'library.videos'].includes(method);
    const p = paging ? { page: 1, pageSize: 20, ...params } : params;
    const readonly=constants.methods[method].semantics==='readOnly';
    if(method.startsWith('library.')&&!readonly)this.readRevision=(this.readRevision??0)+1;
    const key = readonly
      ? JSON.stringify([this.epoch, this.readRevision??0, method, Object.keys(p).sort().map(k => [k, p[k]])]) : null;
    if (key && this.inflight.has(key)) return this.inflight.get(key);
    if(method==='auth.logout')this.epoch++;
    const epoch=this.epoch,account=this.account?.id;
    const job = this.tail.then(async () => {
      if (this.blocked && method !== 'auth.logout') throw this.blocked;
      try { return ['library.addItems','library.removeItems'].includes(method)?await this.write(method,p,epoch,account):method==='library.verify'?await this.write(p.method,p.params,epoch,account,true):await this.perform(method, p); }
      catch (e) {
        if (e instanceof ProviderFault && ['rate_limited', 'verification_required', 'credential_invalid'].includes(e.code)) this.blocked = e;
        throw e;
      }
    });
    this.tail = job.catch(() => {});
    if (key) { this.inflight.set(key, job); job.finally(() => this.inflight.delete(key)).catch(() => {}); }
    return job;
  }
  async view(params) {
    const d = await this.transport.api('/x/web-interface/view', params, 'video');
    video(d); return d;
  }
  async containerDetail(containerId) {
    const info=(await this.transport.api('/x/v3/fav/resource/list',{media_id:containerId,pn:1,ps:1},'folder'))?.info;
    if(!info||id(info.id)!==containerId)fail('upstream_schema_changed');
    const owner=id(info.upper?.mid);
    if(info.mid!==undefined&&id(info.mid)!==owner)fail('entitlement_denied');
    const result=folder(info,this.account.id,true);
    if(result.ownerId===this.account.id) {
      const d=await this.transport.api('/x/v3/fav/folder/created/list-all',{up_mid:this.account.id},'folder');
      const own=array(d?.list).find(x=>id(x.id)===containerId);
      if(own) {
        if(own.mid!==undefined&&id(own.mid)!==this.account.id)fail('entitlement_denied');
        if(own.upper?.mid!==undefined&&id(own.upper.mid)!==this.account.id)fail('entitlement_denied');
        result.allowedActions=['favorite.addVideos','favorite.removeVideos'];
      }
    }
    return result;
  }
  async favoriteIds(containerId) {
    const rows=array(await this.transport.api('/x/v3/fav/resource/ids',{media_id:containerId},'folder'));
    if(rows.length>100000)fail('upstream_schema_changed');
    return new Set(rows.filter(x=>x.type===2).map(x=>id(x.id)));
  }
  async write(method,p,epoch,account,verifyOnly=false) {
    const ctx=writeContext(this,epoch,account,fail);ctx.check();
    if(!Array.isArray(p.items)||!p.items.length||p.items.length>100||p.items.some(x=>x.kind!=='video'))fail('invalid_params');
    if((await this.nav()).id!==account)fail('credential_invalid');ctx.check();
    this.transport.csrf(); // Fail before any write, even for an already met goal.
    const detail=await this.containerDetail(p.containerId);ctx.check();
    const add=method==='library.addItems';
    if(!detail.allowedActions.includes(add?'favorite.addVideos':'favorite.removeVideos'))fail('entitlement_denied');
    const aids=[];
    for(const bv of new Set(p.items.map(x=>bvid(x.bvid)))) {
      const v=await this.view({bvid:bv});ctx.check();if(v.bvid!==bv)fail('upstream_schema_changed');aids.push(id(v.aid));
    }
    const before=await this.favoriteIds(p.containerId);ctx.check();
    const needed=aids.filter(x=>before.has(x)!==add);
    if(!needed.length)return verifiedWrite();
    if(verifyOnly)return pendingWrite();
    try {
      // Each video gets at most one POST. Stop on the first ambiguous failure;
      // preceding applied items are not resubmitted as a batch.
      if(add)for(const aid of needed) {
        await this.transport.write('/x/v3/fav/resource/deal',{rid:aid,type:'2',add_media_ids:p.containerId,del_media_ids:''},ctx.beforeSend);ctx.check();
      } else {
        await this.transport.write('/x/v3/fav/resource/batch-del',{resources:needed.map(x=>x+':2').join(','),media_id:p.containerId,platform:'web'},ctx.beforeSend);ctx.check();
      }
      const after=await this.favoriteIds(p.containerId);ctx.check();
      return aids.every(x=>after.has(x)===add)?verifiedWrite():pendingWrite();
    } catch(e) {if(ctx.sent)return pendingWrite();throw e;}
  }
  async perform(method, p) {
    if(method==='library.container') {if(!this.account)fail('authentication_required');return this.containerDetail(p.containerId);}
    if (method === 'auth.qr.start') {
      if (this.account || this.session) fail('invalid_params');
      const d = await this.transport.passport('/x/passport-login/web/qrcode/generate');
      const key = str(d.qrcode_key, 256);
      let url; try { url = new URL(d.url); } catch { fail('upstream_schema_changed'); }
      if (url.protocol !== 'https:' || !((url.hostname === 'passport.bilibili.com' && url.pathname === '/h5-app/passport/login/scan') || (url.hostname === 'account.bilibili.com' && url.pathname === '/h5/account-h5/auth/scan-web')) || url.username || url.password || url.port || url.hash) fail('upstream_schema_changed');
      const sessionId = randomUUID(), expiresAtMs = this.now() + 180000;
      const png = await QRCode.toBuffer(url.href, { type: 'png', width: 256 });
      this.session = { id: sessionId, key, expiresAtMs, last: 0, result: null };
      return { sessionId, mimeType: 'image/png', imageBase64: png.toString('base64'), expiresAtMs, pollAfterMs: 2000 };
    }
    if (method === 'auth.qr.poll' || method === 'auth.qr.cancel') {
      const s = this.session; if (!s || s.id !== p.sessionId) fail('invalid_params');
      if (method === 'auth.qr.cancel') { this.session = null; this.transport.reset(); return { sessionId: s.id, state: 'cancelled' }; }
      if (this.now() >= s.expiresAtMs) return { sessionId: s.id, state: 'expired' };
      if (s.result && (this.account || this.now() - s.last < 2000)) return s.result;
      const d = await this.transport.passport('/x/passport-login/web/qrcode/poll', { qrcode_key: s.key });
      const state = ({ 86101: 'waitingScan', 86090: 'waitingConfirmation', 86038: 'expired' })[d?.code];
      let result;
      if (state) result = { sessionId: s.id, state };
      else if (d?.code === 0) {
        const account = await this.nav();
        const credential = this.transport.credential();
        this.account = account; this.epoch++;
        result = { sessionId: s.id, state: 'authenticated', account, credential };
      } else fail('upstream_schema_changed');
      s.result = result; s.last = this.now(); return result;
    }
    if (method === 'auth.credential.restore') {
      if (this.account || this.session) fail('invalid_params');
      this.transport.restore(p.credential); this.keys = null;
      this.account = await this.nav(); this.epoch++; return { account: this.account };
    }
    if (method === 'auth.logout') {
      // Local sign-out only; no silent refresh, no upstream write endpoint.
      this.transport.reset(); this.account = null; this.session = null; this.keys = null;
      this.blocked = null; this.epoch++; this.inflight.clear(); return { upstreamRevoked: false };
    }
    if (!this.account) fail('authentication_required');
    if (method === 'auth.credential.check') {
      try {
        const account = await this.nav();
        if (account.id !== this.account.id) fail('credential_invalid');
        return { valid: true, account };
      } catch (e) { if (e.code === 'credential_invalid') { this.account = null; return { valid: false }; } throw e; }
    }
    const { page = 1, pageSize = 20 } = p;
    if (method === 'video.resolve') return video(await this.view(await resolveInput(p.input, this.linkFetch)));
    if (method === 'video.parts' || method === 'playback.resolve') {
      const b = method === 'video.parts' ? p.bvid : p.track?.bvid;
      if (!BV.test(b) || (method === 'playback.resolve' && p.track?.kind !== 'videoPart')) fail('invalid_params');
      const d = await this.view({ bvid: b }); if (d.bvid !== b) fail('upstream_schema_changed');
      const pages = array(await this.transport.api('/x/player/pagelist', { bvid: b }, 'video'));
      if (!pages.length || pages.length > 10000) fail('media_unavailable');
      const tracks = pages.map((part, index) => ({ ref: { kind: 'videoPart', bvid: b, cid: id(part.cid) },
        title: str(part.part), artist: str(d.owner?.name), creatorKind: 'uploader', album: str(d.title),
        durationMs: duration(part.duration), coverUrl: videoCover(d.pic), availability: 'unknown',
        video: { title: str(d.title), partTitle: str(part.part), partNumber: int(part.page ?? index + 1, 10000) } }));
      if (new Set(tracks.map(t => t.ref.cid)).size !== tracks.length || tracks.some((t, i) => t.video.partNumber !== i + 1)) fail('upstream_schema_changed');
      if (method === 'video.parts') return { ...paged(tracks, page, pageSize), bvid: b };
      const track = tracks.find(t => t.ref.cid === p.track.cid); if (!track) fail('media_unavailable');
      const play = await this.signed('/x/player/wbi/playurl', { bvid: b, cid: track.ref.cid, fnval: '16', fnver: '0', fourk: '0' }, 'video');
      let audio; try { audio = selectAacCandidates(play); } catch(e) { fail(e.message === 'upstream_schema_changed' ? 'upstream_schema_changed' : 'unsupported_media'); }
      return { track: track.ref, quality: 'aac', codec: 'aac', bitrate: audio.bitrate, url: audio.url,
        backupUrls: audio.backupUrls, ...(audio.dash ? { dash: audio.dash } : {}), headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': USER_AGENT },
        // No verified hard expiry is supplied by this API adapter. Zero means
        // unknown, not already expired; a cache age must not fail active media.
        expiresInSeconds: 0, durationMs: track.durationMs };
    }
    if (method === 'search.videos') {
      const d = await this.signed('/x/web-interface/wbi/search/type', { keyword: p.keyword, search_type: 'video', page: String(page), page_size: String(pageSize) });
      const items = [];
      for (const item of array(d.result ?? [])) {
        if (item.type !== 'video') continue;
        try { items.push(video(item, true)); } catch { /* One malformed/non-video row cannot poison the whole page. */ }
      }
      const total = int(d.numResults);
      return { page, hasMore: page < int(d.numPages), total, items };
    }
    if (method === 'library.containers') {
      const created = p.kind === 'created';
      const d = created
        ? await this.transport.api('/x/v3/fav/folder/created/list-all', { up_mid: this.account.id }, 'folder')
        : await this.transport.api('/x/v3/fav/folder/collected/list', { up_mid: this.account.id, pn: String(page), ps: String(pageSize), platform: 'web' }, 'folder');
      // collected/list also returns followed seasons (attr=0); these are not
      // favorite folders and must never be sent to fav/resource/list.
      const list = array(d?.list ?? []).filter(v => created || (v.attr & 2) !== 0);
      const items = list.map(v => folder(v, this.account.id, created));
      if (created) return paged(items, page, pageSize);
      if (typeof d.has_more !== 'boolean') fail('upstream_schema_changed');
      return { page, hasMore: d.has_more, total: null, items };
    }
    if (method === 'library.videos') {
      // Translate logical pages to bounded upstream pages. Desktop/Remote and
      // whole-folder readers must not pass their larger page sizes to Bilibili.
      const offset = (page - 1) * pageSize;
      const first = Math.floor(offset / 20) + 1;
      const last = Math.ceil((offset + pageSize) / 20);
      const rows = []; let more = false; let total = 0;
      for (let pn = first; pn <= last; pn++) {
        const d = await this.transport.api('/x/v3/fav/resource/list', { media_id: p.containerId, pn: String(pn), ps: '20' }, 'folder');
        if (typeof d.has_more !== 'boolean') fail('upstream_schema_changed');
        total = int(d.info?.media_count);
        rows.push(...array(d.medias ?? []));
        more = d.has_more;
        if (!more) break;
      }
      const within = offset % 20;
      const selected = rows.slice(within, within + pageSize);
      const items = [];
      for (const item of selected) {
        if (item.type !== 2) continue;
        try { items.push(video(item)); } catch { /* Unidentifiable deleted rows cannot become fake TrackRefs. */ }
      }
      return { page, hasMore: more || rows.length > within + pageSize, total, items };
    }
    fail('unsupported_capability');
  }
}
