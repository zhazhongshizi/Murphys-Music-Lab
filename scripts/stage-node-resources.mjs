// Production resource staging and exact inventory, shared by all release entrypoints.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, destination] = process.argv.slice(2);
if (!['--stage', '--verify', '--inventory', '--handshakes'].includes(mode) || !destination) throw Error('Expected --stage/--inventory/--verify/--handshakes RESOURCE_ROOT');
const root = resolve(destination);
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const resourceNames = ['provider', 'node', 'providers', 'contracts', 'licenses'];
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) throw Error(`Unsupported resource entry: ${p}`);
    return e.isDirectory() ? files(join(dir, e.name), p) : [p];
  }).sort();
}
function copy(rel) {
  const dst = join(root, rel); mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(repo, rel), dst, { recursive: true, dereference: false });
}
function checkPath(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.includes(':') || path.split('/').some(s => !s || s === '.' || s === '..')) throw Error('Unsafe resource path');
  if (!resourceNames.includes(path.split('/')[0])) throw Error(`Unexpected resource root: ${path}`);
}
function forbidden(path) {
  // Dependency licenses and runtime JS/TS are retained. Test and development assets are not shipped.
  return /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|manual-spikes|provider-state|logs?|coverage|\.github|\.git|examples?|docs|\.bin)(\/|$)/i.test(path)
    || /\.js\.txt$|\.(pdb|log|sqlite3?|db|py[co])$/i.test(path)
    || /(^|\/)(public-media-probe|handshake|write-fixture-entry|fake-provider|provider-media-probe|bilibili-production-probe)[^/]*$/i.test(path)
    || /(^|\/)(credentials?|cookies?|qq-device|device|auth)[^/]*\.json$/i.test(path);
}
if (mode === '--stage') {
  const runtime = json(join(repo, 'providers/node/runtime.json'));
  const official = join(repo, `output/node-${runtime.version}/bundled/node-v${runtime.version}-win-x64`);
  const archive = join(repo, `output/node-${runtime.version}/node-v${runtime.version}-win-x64.zip`);
  if (sha(archive) !== runtime.archiveSha256 || sha(join(official, 'node.exe')) !== runtime.executableSha256) throw Error('Pinned Node input hash mismatch');
  mkdirSync(join(root, 'node'), { recursive: true });
  for (const name of ['node.exe', 'LICENSE']) cpSync(join(official, name), join(root, 'node', name));
  copy('providers/node/runtime.json');
  copy('providers/node/shared');
  for (const name of ['protocol-v2.schema.json', 'protocol-v2.constants.json']) copy(`contracts/${name}`);
  const production = {
    netease: ['main.mjs', 'provider.mjs', 'transport.mjs', 'qr.ts', 'upstream-loader.mjs', 'patch-qr-check.mjs', 'upstream-lock.json', 'upstream', 'package.json', 'package-lock.json', 'README.md', 'WRITES.md'],
    bilibili: ['main.mjs', 'provider.mjs', 'transport.mjs', 'audio.mjs', 'fault.mjs', 'links.mjs', 'package.json', 'package-lock.json', 'README.md'],
  };
  for (const [id, entries] of Object.entries(production)) {
    for (const entry of entries) copy(`providers/node/${id}/${entry}`);
    const cwd = join(root, 'providers/node', id);
    const installed = spawnSync(process.execPath, [join(official, 'node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', windowsHide: true });
    if (installed.status !== 0) throw Error(`Locked production install failed (${id}): ${installed.stderr || installed.stdout}`);
    // npm's dependency archives include development fixtures; discard only these known non-runtime entries.
    const modules = join(cwd, 'node_modules');
    function prune(dir, prefix = '') {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const p = join(dir, e.name);
        if (e.isSymbolicLink() || forbidden(rel) || e.name === '.package-lock.json') rmSync(p, { recursive: e.isDirectory(), force: true });
        else if (e.isDirectory()) prune(p, rel);
      }
    }
    prune(modules);
    const lock = json(join(cwd, 'package-lock.json'));
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path || pkg.dev) continue;
      if (json(join(cwd, path, 'package.json')).version !== pkg.version) throw Error(`Locked dependency mismatch: ${id}/${path}`);
    }
  }
  console.log('Staged pinned Node and locked production providers (no install on user machines).');
}
async function descriptions() {
  const providers = [];
  for (const id of ['netease', 'bilibili']) {
    const base = `providers/node/${id}`;
    const mod = await import(pathToFileURL(join(root, base, 'provider.mjs')).href);
    const pkg = json(join(root, base, 'package.json'));
    if (pkg.version !== mod.version) throw Error('Provider version mismatch');
    providers.push({ id, name: `${id}-provider`, version: mod.version, protocolVersion: 2,
      executable: 'node/node.exe', entrypoint: `${base}/main.mjs`, packageLock: `${base}/package-lock.json`,
      capabilities: mod.capabilities, implementedMethods: mod.methods,
      ...(id === 'netease' ? { upstream: json(join(root, base, 'upstream-lock.json')) } : {}) });
  }
  return providers;
}
if (mode === '--inventory') {
  const runtime = json(join(root, 'providers/node/runtime.json'));
  const providers = await descriptions();
  const guard = join(root, '.inventory-guard'); mkdirSync(guard);
  try {
    const p = spawnSync(join(root, 'provider/qqmusic-provider.exe'), ['--device-path', join(guard, 'device.json')], { input: '{"v":1,"id":"inventory","method":"system.handshake","params":{"protocolVersion":1}}\n', encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (p.status !== 0) throw Error('QQ inventory handshake failed');
    const frames = p.stdout.trim().split('\n');
    if (frames.length !== 1) throw Error('QQ stdout contamination');
    const frame = JSON.parse(frames[0]);
    if (!frame.ok || frame.result.provider.mode !== 'live') throw Error('Production QQ provider required');
    providers.unshift({ id: 'qqmusic', ...frame.result.provider, protocolVersion: frame.result.protocol.version, executable: 'provider/qqmusic-provider.exe', capabilities: frame.result.capabilities, implementedMethods: frame.result.implementedMethods });
  } finally { rmSync(guard, { recursive: true }); }
  const inventory = resourceNames.flatMap(name => files(join(root, name), name)).map(path => ({ path, size: statSync(join(root, path)).size, sha256: sha(join(root, path)) }));
  for (const f of inventory) { checkPath(f.path); if (forbidden(f.path)) throw Error(`Forbidden production resource: ${f.path}`); }
  writeJson(join(root, 'provider-manifest.json'), { schemaVersion: 1, runtime: { ...runtime, executable: 'node/node.exe', license: 'node/LICENSE', manifest: 'providers/node/runtime.json' }, providers, files: inventory });
}
if (mode === '--verify') {
  const manifest = json(join(root, 'provider-manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.providers.length !== 3) throw Error('Invalid multi-provider manifest');
  const runtime = json(join(root, 'providers/node/runtime.json'));
  const sourceRuntime = json(join(repo, 'providers/node/runtime.json'));
  for (const [key, value] of Object.entries(sourceRuntime)) if (runtime[key] !== value || manifest.runtime[key] !== value) throw Error(`Runtime pin drift: ${key}`);
  if (sha(join(root, 'node/node.exe')) !== runtime.executableSha256) throw Error('Runtime hash mismatch');
  const actual = resourceNames.flatMap(name => files(join(root, name), name));
  const expected = new Set();
  for (const f of manifest.files) {
    checkPath(f.path);
    if (expected.has(f.path) || forbidden(f.path)) throw Error(`Duplicate/forbidden resource: ${f.path}`);
    expected.add(f.path);
    if (statSync(join(root, f.path)).size !== f.size || sha(join(root, f.path)) !== f.sha256) throw Error(`Resource size/hash mismatch: ${f.path}`);
  }
  if (actual.length !== expected.size || actual.some(p => !expected.has(p))) throw Error('Resource file set differs from manifest');
  for (const p of await descriptions()) {
    if (JSON.stringify(manifest.providers.find(x => x.id === p.id)) !== JSON.stringify(p)) throw Error(`Provider metadata drift: ${p.id}`);
  }
  const qq = manifest.providers.find(p => p.id === 'qqmusic');
  if (qq?.name !== 'qqmusic-provider' || qq?.version !== '0.1.0' || qq?.protocolVersion !== 1 || qq?.mode !== 'live') throw Error('Invalid QQ provider metadata');
  const upstream = await import(pathToFileURL(join(root, 'providers/node/netease/upstream-loader.mjs')).href);
  upstream.verifyUpstream();
  for (const path of ['module/song_url_v1.js', 'module/login_qr_check.js', 'util/crypto.js', 'module/playlist_tracks.js', 'module/playlist_subscribe.js']) {
    const source = readFileSync(join(root, 'providers/node/netease/upstream', path), 'utf8').replace(/\r\n/g, '\n');
    const patched = upstream.patchSource(path, source);
    if (patched === source || (path.endsWith('playlist_tracks.js') && (patched.includes('[...tracks, ...tracks]') || patched.includes('catch')))) throw Error(`Upstream patch missing: ${path}`);
  }
  // Extra upstream files must still be refused after packaging (without mutating the package).
  const temp = join(root, 'providers/node/netease/upstream');
  if (Object.keys(json(join(root, 'providers/node/netease/upstream-lock.json')).files).length !== files(temp).length) throw Error('Upstream file set mismatch');
  console.log(`Verified all ${actual.length} resource paths, sizes and SHA-256 values; three providers; five load-time patches.`);
}
if (mode === '--handshakes') {
  const manifest = json(join(root, 'provider-manifest.json'));
  for (const id of ['netease', 'bilibili']) {
    const descriptor = manifest.providers.find(p => p.id === id);
    for (const [name, params, success] of [
      ['valid', { protocolVersion: 2, providerId: id }, true],
      ['wrong-name', { protocolVersion: 2, providerId: id === 'netease' ? 'bilibili' : 'netease' }, false],
      ['wrong-version', { protocolVersion: 1, providerId: id }, false],
    ]) {
      const child = spawnSync(join(root, 'node/node.exe'), [join(root, descriptor.entrypoint)], {
        cwd: root, input: JSON.stringify({ v: 2, id: `guard-${name}`, method: 'system.handshake', params }) + '\n',
        encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, NODE_OPTIONS: '', NODE_PATH: '' },
      });
      if (child.error) throw child.error;
      if (!success) {
        if (child.status !== 2 || child.stdout !== '') throw Error(`Invalid handshake accepted: ${id}/${name}`);
        continue;
      }
      const lines = child.stdout.trim().split('\n');
      if (child.status !== 0 || child.stderr !== '' || lines.length !== 1) throw Error(`Handshake failed/stdout contaminated: ${id}`);
      const r = JSON.parse(lines[0]);
      if (r.v !== 2 || !r.ok || r.result.provider.id !== id || r.result.provider.name !== descriptor.name || r.result.provider.version !== descriptor.version || r.result.protocolVersion !== descriptor.protocolVersion || JSON.stringify(r.result.capabilities) !== JSON.stringify(descriptor.capabilities) || JSON.stringify(r.result.implementedMethods) !== JSON.stringify(descriptor.implementedMethods)) throw Error(`Handshake metadata mismatch: ${id}`);
    }
  }
  console.log('Two production Node providers: exact identity/version/capabilities, clean stdout, wrong name/version rejected.');
}
