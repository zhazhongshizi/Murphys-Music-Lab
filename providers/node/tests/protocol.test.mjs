import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { decodeRequest, readFrames, MAX_LINE_BYTES } from '../shared/framing.mjs';
const hello = providerId=>({v:2,id:'hello',method:'system.handshake',params:{protocolVersion:2,providerId}});
const bytes = value=>Buffer.from(JSON.stringify(value));
test('strict lexical framing and bounded input',async()=>{
  assert.deepEqual(decodeRequest(bytes(hello('netease'))),hello('netease'));
  const good=JSON.stringify(hello('netease'));
  for(const bad of ['', '\ufeff'+good, good.replace('"v":2','"v":2.0'),good.replace('"v":2','"v":2e0'),good.replace('"v":2','"v":2,"v":2'),good.replace('"v":2','"v":2,"\\u0076":2'),good.replace('"protocolVersion":2','"protocolVersion":2,"protocolVersion":2'),good.replace('"protocolVersion":2','"protocolVersion":1e999')])assert.throws(()=>decodeRequest(Buffer.from(bad)));
  assert.throws(()=>decodeRequest(Buffer.from([0xff])));
  assert.throws(()=>decodeRequest(Buffer.alloc(MAX_LINE_BYTES+1,32)));
  assert.throws(()=>decodeRequest(Buffer.from('{"v":2,"id":"x","method":"x","params":'+ '['.repeat(128)+'0'+']'.repeat(128)+'}')));
  const frames=[];
  for await(const frame of readFrames(Readable.from([Buffer.from(good.slice(0,7)),Buffer.from(good.slice(7)+'\r\n'+good+'\n')])))frames.push(frame);
  assert.equal(frames.length,2);
  await assert.rejects(async()=>{for await(const _ of readFrames(Readable.from([Buffer.from(good)]))){}},/unterminated_frame/);
});
for(const providerId of ['netease','bilibili'])test(`bundled executable handshake without PATH: ${providerId}`,()=>{
  const input=JSON.stringify(hello(providerId))+'\n'+JSON.stringify({v:2,id:'ping',method:'system.ping',params:{}})+'\n';
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../handshake-probe.mjs',import.meta.url)),providerId],{input,encoding:'utf8',env:{SystemRoot:process.env.SystemRoot,PATH:''},timeout:5000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  const frames=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(frames.length,2);assert.equal(frames[0].result.provider.id,providerId);
  assert.equal(frames[0].result.provider.name,`${providerId}-provider`);
  assert.deepEqual(frames[0].result.implementedMethods,['system.handshake','system.ping']);
  assert.deepEqual(frames[1].result,{alive:true});
});
test('bad handshake, duplicate IDs and extra params terminate without echoing input',()=>{
  const path=fileURLToPath(new URL('../handshake-probe.mjs',import.meta.url));
  for(const input of [JSON.stringify(hello('bilibili'))+'\n',JSON.stringify(hello('netease'))+'\n'+JSON.stringify(hello('netease'))+'\n',JSON.stringify({...hello('netease'),params:{...hello('netease').params,cookie:'SYNTHETIC_SECRET'}})+'\n']){
    const r=spawnSync(process.execPath,[path,'netease'],{input,encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(r.status,2);assert.equal(r.stderr,'provider_probe_protocol_failure\n');assert.ok(!r.stdout.includes('SYNTHETIC_SECRET'));
  }
});
