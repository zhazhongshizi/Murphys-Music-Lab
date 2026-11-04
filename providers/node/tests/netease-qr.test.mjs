import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {qrKey,qrImage,qrState} from '../netease/qr.ts';
import {patchQrCheck} from '../netease/patch-qr-check.mjs';
const read=name=>readFileSync(new URL(`../fixtures/upstream/netease/${name}.js.txt`,import.meta.url),'utf8');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7b8AAAAASUVORK5CYII=';
function module(source){
  const context={module:{exports:{}},require:name=>{
    if(name==='../util/option.js')return ()=>({});
    if(name==='qrcode')return {toDataURL:async()=>`data:image/png;base64,${png}`};
    if(name==='../util/index')return {getCookieHeader:()=>'',hasCookie:()=>false};
    throw new Error('unexpected_dependency');
  }};
  vm.runInNewContext(source,context);return context.module.exports;
}
test('exact upstream key/create wrappers map to private v2 image',async()=>{
  const key=await module(read('login_qr_key'))({},async(path,data)=>{assert.equal(path,'/api/login/qrcode/unikey');assert.equal(data.type,3);return {body:{code:200,unikey:'SYNTHETIC_QR'},cookie:[]};});
  assert.equal(qrKey(key),'SYNTHETIC_QR');
  const image=await module(read('login_qr_create'))({key:'SYNTHETIC_QR',qrimg:true});
  assert.deepEqual(qrImage(image,'fixture-session',200000),{sessionId:'fixture-session',mimeType:'image/png',imageBase64:png,expiresAtMs:200000,pollAfterMs:2000});
});
for(const [code,state] of [[800,'expired'],[801,'waitingScan'],[802,'waitingConfirmation']])test(`QR upstream code ${code}`,async()=>{
  const value=await module(patchQrCheck(read('login_qr_check')))({key:'fixture'},async()=>({body:{code},cookie:[]}));
  assert.deepEqual(await qrState(value,'fixture',()=>{throw new Error('must_not_check_account');}),{sessionId:'fixture',state});
});
test('803 checks account once and returns secrets only in private credential',async()=>{
  let checks=0;
  const response=await module(patchQrCheck(read('login_qr_check')))({key:'fixture'},async()=>({body:{code:803},cookie:['MUSIC_U=SYNTHETIC_TEST_ONLY','__csrf=SYNTHETIC_TEST_ONLY']}));
  const result=await qrState(response,'fixture',async cookie=>{checks++;assert.ok(cookie.includes('MUSIC_U='));return {id:'42',displayName:'Fixture',cookie:'SHOULD_NOT_COPY'};});
  assert.equal(checks,1);assert.equal(result.state,'authenticated');assert.deepEqual(result.account,{id:'42',displayName:'Fixture'});
  assert.equal(result.credential.providerId,'netease');
  assert.ok(result.credential.payload.includes('SYNTHETIC_TEST_ONLY'));
});
test('patch eliminates undefined result without retry or raw error leakage',async()=>{
  const source=read('login_qr_check');let calls=0;
  await assert.rejects(module(patchQrCheck(source))({},async()=>{calls++;throw new Error('SYNTHETIC_SECRET');}),/^Error: netease_qr_request_failed$/);
  assert.equal(calls,1);assert.throws(()=>patchQrCheck(source.replace('result.cookie,','changed.cookie,')),/baseline_mismatch/);
});
test('malformed, unknown state, empty credential and failed account remain failures',async()=>{
  for(const response of [{body:{code:999}},{body:{code:803,cookie:''}},{body:{code:803,cookie:'X'.repeat(65536)}},{}])await assert.rejects(qrState(response,'fixture',async()=>({id:'42',displayName:'Fixture'})),/upstream_schema_changed/);
  await assert.rejects(qrState({body:{code:803,cookie:'SYNTHETIC'}},'fixture',async()=>{throw new Error('network_unavailable');}),/network_unavailable/);
  assert.throws(()=>qrImage({body:{code:200,data:{qrimg:'data:image/png;base64,YmFk'}}},'fixture',1),/upstream_schema_changed/);
});
