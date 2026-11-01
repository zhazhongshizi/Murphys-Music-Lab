// Mutation checks run only on a fresh synthetic copy, never on the package.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] || join(repo, 'src-tauri/resources'));
const root = mkdtempSync(join(repo, 'output/provider-g-resource-tests-'));
cpSync(source, root, { recursive: true });
function verify(success, label) {
  const p = spawnSync(process.execPath, [join(repo, 'scripts/stage-node-resources.mjs'), '--verify', root], { encoding: 'utf8', windowsHide: true });
  if ((p.status === 0) !== success) throw Error(`${label}: ${p.stderr || p.stdout}`);
}
verify(true, 'valid resource copy');
const modulePath = join(root, 'providers/node/netease/provider.mjs');
const bytes = readFileSync(modulePath);
writeFileSync(modulePath, Buffer.concat([bytes, Buffer.from('\n// synthetic tamper\n')]));
verify(false, 'changed resource hash'); writeFileSync(modulePath, bytes);
const extra = join(root, 'providers/node/netease/upstream/extra.js');
writeFileSync(extra, '// synthetic unlisted upstream file');
const loader = await import(pathToFileURL(join(root, 'providers/node/netease/upstream-loader.mjs')).href);
let rejected = false;
try { loader.verifyUpstream(); } catch (e) { rejected = e.message === 'upstream_integrity_failed'; }
if (!rejected) throw Error('Packaged verifyUpstream accepted an extra file');
verify(false, 'extra resource'); unlinkSync(extra);
const manifestPath = join(root, 'provider-manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes); manifest.providers.find(p => p.id === 'bilibili').protocolVersion = 99;
writeFileSync(manifestPath, JSON.stringify(manifest));
verify(false, 'wrong protocol metadata'); writeFileSync(manifestPath, manifestBytes);
const runtimePath = join(root, 'providers/node/runtime.json');
const runtimeBytes = readFileSync(runtimePath); const runtime = JSON.parse(runtimeBytes); runtime.version = '0.0.0';
writeFileSync(runtimePath, JSON.stringify(runtime)); verify(false, 'runtime pin drift'); writeFileSync(runtimePath, runtimeBytes);
verify(true, 'restored copy');
console.log(`Provider resource checks: 7 passed (including packaged upstream extra-file rejection). Synthetic copy: ${root}`);
