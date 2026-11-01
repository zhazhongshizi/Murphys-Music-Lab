import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('./', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refs = JSON.parse(read('reference-lock.json'));
for (const f of refs.files) if (digest(read(f.path)) !== f.sha256) throw new Error('reference_integrity_failed');
const lock = JSON.parse(read('package-lock.json'));
const notices = JSON.parse(read('dependency-notices.json'));
if (Object.keys(lock.packages).length !== notices.length + 1) throw new Error('dependency_inventory_failed');
for (const n of notices) {
  const entry = Object.entries(lock.packages).find(([path,p]) => path.endsWith('/'+n.name) && p.version === n.version);
  if (!entry || n.integrity !== entry[1].integrity || n.resolved !== entry[1].resolved || !n.license || !n.notices.length) throw new Error('dependency_inventory_failed');
  for (const f of n.notices) if (digest(read(f.path)) !== f.sha256) throw new Error('license_integrity_failed');
}
const runtime = JSON.parse(read('../runtime.json'));
const node = new URL('../../../output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe', root);
if (existsSync(node) && digest(readFileSync(node)) !== runtime.executableSha256) throw new Error('node_integrity_failed');
console.log(JSON.stringify({ fixedReferences: refs.files.length, dependencies: notices.length, nodeVersion: runtime.version, resources: 'verified' }));
