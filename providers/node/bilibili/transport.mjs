import { CookieJar } from 'tough-cookie';
import { USER_AGENT } from './audio.mjs';
import { fail, ProviderFault } from './fault.mjs';

export const API = 'https://api.bilibili.com';
export const PASSPORT = 'https://passport.bilibili.com';
const COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut']);
const PATHS = new Set([
  '/x/v3/fav/resource/ids',
  '/x/web-interface/nav', '/x/v3/fav/folder/created/list-all',
  '/x/v3/fav/folder/collected/list', '/x/v3/fav/resource/list',
  '/x/web-interface/view', '/x/player/pagelist',
  '/x/web-interface/wbi/search/type', '/x/player/wbi/playurl',
  '/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll',
]);
export function checkedData(body, context = '') {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.code)) fail('upstream_schema_changed');
  const c = body.code;
  if (c === 0) return body.data;
  if (c === -101) fail('credential_invalid'); // nav/API: account not logged in
  if (c === -412) fail('rate_limited', true);
  if (c === -352) fail('verification_required'); // risk validation; never credential loss
  if (c === -403) fail('verification_required'); // WBI signature failure, no auto clock adjustment
  if (c === -404 || (context === 'video' && c === 62002)) fail('media_unavailable');
  if (context === 'video' && c === 62004) fail('entitlement_denied'); // review/visibility
  if (c === -102 || c === -111 || (context === 'folder' && [11003, 11201].includes(c))) fail('entitlement_denied');
  fail('upstream_schema_changed');
}
export class Transport {
  constructor(fetcher = fetch, now = () => Date.now()) {
    this.fetcher = fetcher; this.now = now; this.reset();
  }
  reset() { this.jar = new CookieJar(); }
  acceptCookies(headers, url) {
    // Fetch exposes each Set-Cookie header separately. Expires commas are data.
    if (typeof headers.getSetCookie !== 'function') fail('upstream_schema_changed');
    for (const cookie of headers.getSetCookie()) {
      try { this.jar.setCookieSync(cookie, url, { now: new Date(this.now()) }); }
      catch { /* Invalid/domain-mismatched cookies are not account credentials. */ }
    }
  }
  credential() {
    const jar = this.jar.serializeSync();
    jar.cookies = jar.cookies.filter(c => COOKIE_NAMES.has(c.key));
    const credential = { version: 1, providerId: 'bilibili', payload: JSON.stringify(jar) };
    if (Buffer.byteLength(JSON.stringify(credential)) > 65536) fail('upstream_schema_changed');
    return credential;
  }
  restore(c) {
    if (c?.version !== 1 || c.providerId !== 'bilibili' || typeof c.payload !== 'string'
        || Buffer.byteLength(JSON.stringify(c)) > 65536) fail('credential_invalid');
    try {
      const value = JSON.parse(c.payload);
      if (!Array.isArray(value.cookies) || value.cookies.length > 64 || value.cookies.some(cookie =>
        !COOKIE_NAMES.has(cookie.key) || !['bilibili.com', 'api.bilibili.com', 'passport.bilibili.com'].includes(cookie.domain))) fail('credential_invalid');
      this.jar = CookieJar.deserializeSync(value);
      if (!this.jar.getCookiesSync(API + '/x/web-interface/nav', { now: new Date(this.now()) }).some(c => c.key === 'SESSDATA')) fail('credential_invalid');
    } catch { fail('credential_invalid'); }
  }
  async request(url, cookies = true, write = null) {
    const u = new URL(url);
    if (![API, PASSPORT].includes(u.origin) || (write ? u.origin !== API || !['/x/v3/fav/resource/deal', '/x/v3/fav/resource/batch-del'].includes(u.pathname) || u.search : !PATHS.has(u.pathname)) || u.username || u.password || u.hash) fail('invalid_params');
    const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' };
    const cookie = cookies ? this.jar.getCookieStringSync(u.href, { now: new Date(this.now()) }) : '';
    if (cookie) headers.Cookie = cookie;
    let response;
    if (write) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    write?.beforeSend();
    try { response = await this.fetcher(u.href, { headers, ...(write ? { method: 'POST', body: write.body } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { fail('network_unavailable', true); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status === 412) {
        const s = response.headers.get('retry-after');
        const ms = s && /^\d+$/.test(s) ? Number(s) * 1000 : undefined;
        throw new ProviderFault('rate_limited', true, ms > 0 && ms <= 86400000 ? ms : undefined);
      }
      // A CDN/proxy 401/403 is not proof that stored API cookies have expired.
      if (response.status === 403) fail('verification_required');
      fail('network_unavailable', true);
    }
    if (cookies) this.acceptCookies(response.headers, u.href);
    const reader = response.body?.getReader();
    if (!reader) fail('upstream_schema_changed');
    const chunks = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 1048576) fail('upstream_schema_changed');
        chunks.push(value);
      }
    } catch (e) { if (e instanceof ProviderFault) throw e; fail('network_unavailable', true); }
    finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { fail('upstream_schema_changed'); }
  }
  async api(path, params = {}, context = '') {
    const q = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    return checkedData(await this.request(`${API}${path}${q ? '?' + q : ''}`), context);
  }
  csrf() {
    const cookies = this.jar.getCookiesSync(API + '/x/v3/fav/resource/deal', { now: new Date(this.now()) });
    const tokens = cookies.filter(c => c.key === 'bili_jct');
    if (tokens.length !== 1 || !/^[a-fA-F0-9]{32}$/.test(tokens[0].value)) fail('authentication_required');
    return tokens[0].value;
  }
  async write(path, params, beforeSend) {
    const body = new URLSearchParams({ ...params, csrf: this.csrf() }).toString();
    return checkedData(await this.request(API + path, true, { body, beforeSend }));
  }
  async passport(path, params = {}) {
    return checkedData(await this.request(`${PASSPORT}${path}?${new URLSearchParams(params)}`));
  }
}
