// Fixed MIT upstream modules, evaluated with explicit dependencies. Not a sandbox
// for untrusted code: the complete source is checked against upstream-lock.json.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { patchQrCheck } from './patch-qr-check.mjs';
const root = new URL('./upstream/', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('./upstream-lock.json', import.meta.url)));
const require = createRequire(import.meta.url);
function listUpstreamFiles(dir = root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listUpstreamFiles(new URL(`${entry.name}/`, dir), rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error('upstream_integrity_failed');
  }
  return files;
}
export function verifyUpstream(dir = root) {
  const actual = listUpstreamFiles(dir);
  const expectedEntries = Object.entries(lock.files);
  if (actual.length !== expectedEntries.length || actual.some(p => !Object.hasOwn(lock.files, p))) {
    throw new Error('upstream_integrity_failed');
  }
  for (const [path, expected] of expectedEntries) {
    if (createHash('sha256').update(readFileSync(new URL(path, dir))).digest('hex') !== expected) throw new Error('upstream_integrity_failed');
  }
}
export function patchSource(path, source) {
  if (path === 'module/playlist_subscribe.js') {
    const flag = "  query.checkToken = 'v2' // 强制开启checkToken";
    if (!source.includes(flag)) throw new Error('upstream_patch_failed');
    // The fixed HTTP adapter keeps the module's configured body checkToken.
    // It does not download/execute Watchman JS or retry with a new risk token.
    return source.replace(flag, '  // No dynamic Watchman SDK in this managed provider.');
  }
  if (path === 'module/playlist_tracks.js') {
    const begin = source.indexOf('  try {');
    if (begin < 0 || !source.includes('JSON.stringify([...tracks, ...tracks])')) throw new Error('upstream_patch_failed');
    // Preserve the fixed module's request construction. Exactly one transport
    // call; return its real body, propagate every rejection, including 512.
    return source.slice(0, begin) + '  return request(`/api/playlist/manipulate/tracks`, data, createOption(query))\n}\n';
  }
  if (path === 'module/login_qr_check.js') return patchQrCheck(source);
  if (path === 'module/song_url_v1.js') {
    // Remove both eager unlock dependency and the entire alternate-source branch.
    const begin = source.indexOf('  const {\n    matchID,');
    const end = source.indexOf('  const data = {', begin);
    const branch = source.indexOf("  if (query.unblock === 'true') {");
    const next = source.indexOf("  if (data.level == 'sky') {", branch);
    if ([begin,end,branch,next].some(n=>n<0)) throw new Error('upstream_patch_failed');
    source = source.slice(0,begin)+source.slice(end,branch)+source.slice(next);
  }
  if (path === 'util/crypto.js') {
    const line = '    console.log(`eapiResDecrypt error:`, error)';
    if (!source.includes(line)) throw new Error('upstream_patch_failed');
    source = source.replace(line, '    // Host reports a fixed protocol error; never print upstream data.');
  }
  return source;
}
export function loadUpstream(http) {
  verifyUpstream();
  const cache = new Map();
  const option = (q, crypto = '') => ({crypto:q.crypto || crypto || 'eapi',cookie:q.cookie || {},e_r:false,timeout:15000});
  const cookieToJson = s => Object.fromEntries(String(s ?? '').split(';').map(s=>s.trim()).filter(Boolean).map(s=>{const i=s.indexOf('='); return [s.slice(0,i),s.slice(i+1)];}));
  const utilIndex = Object.freeze({
    cookieToJson,
    getCookieHeader: headers => (headers && typeof headers.cookie === 'string' ? headers.cookie : ''),
    hasCookie: cookie => Boolean(cookie && (typeof cookie === 'string' ? cookie.trim() : Object.keys(cookie).length > 0)),
    generateChainId: () => `v1__pc_login_${Date.now()}`,
  });
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (!Object.hasOwn(lock.files,path)) throw new Error('upstream_module_not_allowed');
    if (path.endsWith('.json')) return JSON.parse(readFileSync(new URL(path,root)));
    const module = {exports:{}};
    const scopedRequire = spec => {
      if (spec === '../util/option.js') return option;
      if (spec === '../util/logger.js') return Object.freeze({info(){},warn(){},error(){},debug(){}});
      if (spec === '../util/index.js' || spec === '../util/index') return utilIndex;
      if (spec === 'axios') return {default:http};
      if (['crypto','zlib','crypto-js','node-forge','fzstd','qrcode'].includes(spec)) return require(spec);
      if (spec === './zstd') return load('util/zstd.js');
      if (spec === '../util/crypto') return load('util/crypto.js');
      if (spec === '../util/config.json') return load('util/config.json');
      throw new Error('upstream_dependency_not_allowed');
    };
    const source = patchSource(path, readFileSync(new URL(path,root),'utf8').replace(/\r\n/g,'\n'));
    new vm.Script(`(function(require,module,exports){${source}\n})`,{filename:`fixed-upstream/${path}`}).runInThisContext()(scopedRequire,module,module.exports);
    cache.set(path,module.exports);
    return module.exports;
  }
  return {module:name=>load(`module/${name}.js`),crypto:load('util/crypto.js'),config:load('util/config.json').APP_CONF};
}
if (process.argv[2] === '--verify') { verifyUpstream(); process.stdout.write('fixed upstream verified\n'); }
