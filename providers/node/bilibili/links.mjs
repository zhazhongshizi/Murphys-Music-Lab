import { fail } from './fault.mjs';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
export const BV = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
export const DIGITS = /^[1-9][0-9]{0,19}$/;
function target(input) {
  if (BV.test(input)) return { bvid: input };
  if (/^av[1-9][0-9]{0,19}$/i.test(input)) return { aid: input.slice(2) };
  return null;
}
function checkedUrl(value) {
  let u; try { u = new URL(value); } catch { fail('invalid_params'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.port || u.username || u.password || u.hash
      || !['b23.tv', 'www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(u.hostname)) fail('invalid_params');
  return u;
}
function standard(u) {
  if (u.hostname === 'b23.tv') return null;
  const match = /^\/video\/([^/]+)\/?$/.exec(u.pathname);
  const result = match && target(match[1]);
  if (!result) fail('invalid_params');
  return result;
}
export function publicShortAddress(value) {
  if (isIP(value) === 4) {
    const [a,b,c] = value.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 192 && b === 0)
      && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
  }
  return isIP(value) === 6 && /^[23]/.test(value) && !value.toLowerCase().startsWith('2001:db8:');
}
async function shortHead(value) {
  const u = checkedUrl(value); if (u.hostname !== 'b23.tv' || u.protocol !== 'https:') fail('invalid_params');
  let addresses;
  try { addresses = await lookup(u.hostname, { all: true }); } catch { fail('network_unavailable', true); }
  if (!addresses.length || addresses.some(a => !publicShortAddress(a.address))) fail('invalid_params');
  // Pin DNS into the HTTPS connection while retaining hostname TLS validation.
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(u, { method: 'HEAD', signal: AbortSignal.timeout(10000),
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, r => {
      const headers = new Headers(); if (r.headers.location) headers.set('location', r.headers.location);
      r.resume(); resolve({ status: r.statusCode, headers, body: null });
    });
    req.on('error', () => reject(new Error('shortlink_network_failure'))); req.end();
  });
}
// Only b23.tv short URLs are fetched; standard links are parsed locally. No
// Cookie or account headers ever travel to this redirect resolver.
export async function resolveInput(value, fetcher = shortHead) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) fail('invalid_params');
  const input = value.trim(), direct = target(input); if (direct) return direct;
  let u = checkedUrl(input), seen = new Set();
  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = standard(u); if (result) return result;
    if (!/^\/[A-Za-z0-9]{1,32}\/?$/.test(u.pathname) || seen.has(u.href) || redirects === 3) fail('invalid_params');
    seen.add(u.href);
    // Upgrade shortlink HTTP before any request. Host is exact, no IP literals.
    u.protocol = 'https:';
    let r;
    try { r = await fetcher(u.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { fail('network_unavailable', true); }
    await r.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(r.status)) fail('invalid_params');
    const next = r.headers.get('location'); if (!next) fail('invalid_params');
    u = checkedUrl(new URL(next, u).href);
  }
  fail('invalid_params');
}
