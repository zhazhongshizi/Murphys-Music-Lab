// NDJSON only; all API and secret data remain within this private pipe.
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { readFrames } from '../shared/framing.mjs';
import { NeteaseProvider } from './provider.mjs';
import { ProviderFault } from './transport.mjs';
const schema=JSON.parse(readFileSync(new URL('../../../contracts/protocol-v2.schema.json',import.meta.url)));
const constants=JSON.parse(readFileSync(new URL('../../../contracts/protocol-v2.constants.json',import.meta.url)));
const ajv=new Ajv({strict:false});ajv.addSchema(schema);
const validators=new Map();
function valid(def,v){if(!validators.has(def))validators.set(def,ajv.compile({$ref:`${schema.$id}#/$defs/${def}`}));return validators.get(def)(v);}
export async function runProvider(provider, input=process.stdin, output=process.stdout) {
  let handshake=false;const ids=new Set();const pending=new Set();
  let writeChain=Promise.resolve();
  const sendFrame=response=>{
    const frame=JSON.stringify(response)+'\n';
    if(Buffer.byteLength(frame)>1048577)throw new Error('response_too_large');
    writeChain=writeChain.then(async()=>{if(!output.write(frame))await once(output,'drain');});
    return writeChain;
  };
  const processRequest=async(r,spec)=>{
    let response;
    try {
      if(!spec)throw new ProviderFault('invalid_params');
      const result=await provider.handle(r.method,r.params);
      if(!valid(spec.result,result))throw new ProviderFault('upstream_schema_changed');
      response={v:2,id:r.id,ok:true,result,warnings:[]};
    }catch(e) {
      const error=e instanceof ProviderFault?{code:e.code,retryable:e.retryable,...(e.retryAfterMs===undefined?{}:{retryAfterMs:e.retryAfterMs})}:{code:'upstream_schema_changed',retryable:false};
      response={v:2,id:r.id,ok:false,error};
    }
    await sendFrame(response);
  };
  try {
    for await(const r of readFrames(input)) {
      if(ids.has(r.id))throw new Error('duplicate_request');ids.add(r.id);
      if(ids.size>100000)throw new Error('request_limit');
      const spec=constants.methods[r.method];
      const okParams=Boolean(spec&&spec.providers.includes('netease')&&valid(spec.params,r.params));
      if(!handshake) {
        if(!okParams||r.method!=='system.handshake'||r.params.providerId!=='netease'||r.params.protocolVersion!==2)throw new Error('handshake');
        handshake=true;
        await processRequest(r,spec);
        continue;
      }
      if(r.method==='system.handshake') {
        await processRequest(r,null);
        continue;
      }
      const task=processRequest(r,okParams?spec:null);
      pending.add(task);
      task.then(()=>pending.delete(task),()=>pending.delete(task));
      if(pending.size>=32)await Promise.race(pending);
    }
    await Promise.all(pending);
    await writeChain;
  }catch {process.stderr.write('netease_protocol_failure\n');process.exitCode=2;}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runProvider(new NeteaseProvider());
