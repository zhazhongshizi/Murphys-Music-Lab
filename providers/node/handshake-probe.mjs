// Explicit step-2 probe. No auth, network, HTTP listener or production integration.
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { readFrames, MAX_LINE_BYTES } from './shared/framing.mjs';
const constants = JSON.parse(readFileSync(new URL('../../contracts/protocol-v2.constants.json', import.meta.url)));
const providerId = process.argv[2];
if (!['netease', 'bilibili'].includes(providerId) || process.argv.length !== 3) process.exit(2);
let handshaken = false;
const ids = new Set();
try {
  for await (const request of readFrames(process.stdin)) {
    if (ids.has(request.id) || ids.size >= 10000) throw new Error('request_id_reused');
    ids.add(request.id);
    let result;
    if (!handshaken) {
      if (request.method !== 'system.handshake' || Object.keys(request.params).sort().join(',') !== 'protocolVersion,providerId'
          || request.params.protocolVersion !== 2 || request.params.providerId !== providerId) throw new Error('handshake_mismatch');
      handshaken = true;
      result = {protocolVersion:2,provider:{id:providerId,name:constants.providerNames[providerId],version:'0.1.0-spike'},maxLineBytes:MAX_LINE_BYTES,capabilities:constants.capabilities[providerId],implementedMethods:['system.handshake','system.ping']};
    } else if (request.method === 'system.ping' && Object.keys(request.params).length === 0) {
      result = {alive:true};
    } else throw new Error('probe_method_not_supported');
    if (!process.stdout.write(JSON.stringify({v:2,id:request.id,ok:true,result,warnings:[]})+'\n')) await once(process.stdout,'drain');
  }
} catch {
  process.stderr.write('provider_probe_protocol_failure\n');
  process.exitCode = 2;
}
