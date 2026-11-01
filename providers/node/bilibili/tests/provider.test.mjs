import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import Ajv from 'ajv/dist/2020.js';
import { fixture, response, BVID, view, nav, folder } from './fixture.mjs';
import { runProvider } from '../main.mjs';
import { methods, capabilities, plainTitle, videoCover } from '../provider.mjs';
import { checkedData, API } from '../transport.mjs';
import { resolveInput, publicShortAddress } from '../links.mjs';
import { selectAacCandidates } from '../audio.mjs';
const schema = JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.schema.json', import.meta.url)));
const constants = JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.constants.json', import.meta.url)));
const ajv = new Ajv({ strict: false }); ajv.addSchema(schema);
async function restored(options) { const f = fixture(options); await f.provider.handle('auth.credential.restore', { credential: f.credential }); return f; }
const fault = code => e => e.code === code && e.message === code;
test('video summaries and all parts share the main video cover, normalized to HTTPS', async () => {
  const f = await restored();
  const cover = 'https://i0.hdslb.com/bfs/archive/synthetic-cover.jpg';
  assert.equal((await f.provider.handle('video.resolve', {input:BVID})).coverUrl, cover);
  assert.equal((await f.provider.handle('search.videos', {keyword:'x'})).items[0].coverUrl, cover);
  assert.equal((await f.provider.handle('library.videos', {containerId:'7'})).items[0].coverUrl, cover);
  const parts = await f.provider.handle('video.parts', {bvid:BVID});
  assert.ok(parts.items.every(part => part.coverUrl === cover));
  assert.equal(videoCover('//i1.hdslb.com/bfs/archive/cover.png'), 'https://i1.hdslb.com/bfs/archive/cover.png');
  for (const value of [null, '', 'https://evil.test/a.jpg', 'https://i0.hdslb.com.evil.test/a.jpg', 'https://user@i0.hdslb.com/a.jpg']) assert.equal(videoCover(value), null);
});
test('production write profile is explicit; cold process sends no requests', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const h = await f.provider.handle('system.handshake');
  assert.deepEqual(h.implementedMethods, methods); assert.deepEqual(h.capabilities, capabilities);
  assert.deepEqual(h.capabilities.writeActions, ['favorite.addVideos', 'favorite.removeVideos']); assert.equal(h.capabilities.lyrics, false);
  for (const m of ['lyrics.get', 'library.setLiked', 'auth.credential.refresh']) await assert.rejects(f.provider.handle(m), fault('unsupported_capability'));
  await assert.rejects(f.provider.handle('library.addItems',{}),fault('authentication_required'));
  await assert.rejects(f.provider.handle('search.videos', { keyword: 'x' }), fault('authentication_required'));
  assert.equal(f.calls.length, 0);
});
test('QR wait/scan/confirm checks nav before credential creation, cached polls and cancel/expiry', async () => {
  let time = 100000000; const f = fixture({ now: () => time });
  const qr = await f.provider.handle('auth.qr.start');
  assert.equal(Buffer.from(qr.imageBase64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const poll = () => f.provider.handle('auth.qr.poll', { sessionId: qr.sessionId });
  assert.equal((await poll()).state, 'waitingScan'); assert.equal((await poll()).state, 'waitingScan');
  time += 2001; assert.equal((await poll()).state, 'waitingConfirmation');
  time += 2001; const ready = await poll(); assert.equal(ready.state, 'authenticated'); assert.equal(ready.account.id, '42');
  assert.equal(ready.credential.providerId, 'bilibili'); assert.ok(!JSON.stringify(ready.account).includes('SESSDATA'));
  const f2 = fixture({ now: () => time }); const qr2 = await f2.provider.handle('auth.qr.start');
  assert.equal((await f2.provider.handle('auth.qr.cancel', { sessionId: qr2.sessionId })).state, 'cancelled');
  const f3 = fixture({ now: () => time }); const qr3 = await f3.provider.handle('auth.qr.start'); time += 180001;
  assert.equal((await f3.provider.handle('auth.qr.poll', { sessionId: qr3.sessionId })).state, 'expired');
});
test('QR business expiry and failed confirmation never publish an account', async () => {
  for (const code of [86038, 999]) {
    const f = fixture({ hook: u => u.pathname.endsWith('/poll') ? response({ code }) : undefined });
    const qr = await f.provider.handle('auth.qr.start');
    if (code === 86038) assert.equal((await f.provider.handle('auth.qr.poll', { sessionId: qr.sessionId })).state, 'expired');
    else await assert.rejects(f.provider.handle('auth.qr.poll', { sessionId: qr.sessionId }), fault('upstream_schema_changed'));
    assert.equal(f.provider.account, null);
  }
  const f = fixture({ hook: u => u.pathname.endsWith('/poll') ? response({ code: 0 }) : u.pathname.endsWith('/nav') ? response(null, { code: -101 }) : undefined });
  const qr = await f.provider.handle('auth.qr.start');
  await assert.rejects(f.provider.handle('auth.qr.poll', { sessionId: qr.sessionId }), fault('credential_invalid')); assert.equal(f.provider.account, null);
});
test('Cookie semantics preserve Expires commas, host/domain/path/secure, replacement and expiry', () => {
  let now = Date.now(); const { transport: t } = fixture({ now: () => now });
  const h = new Headers();
  for (const c of ['SESSDATA=old; Domain=.bilibili.com; Path=/; Secure', 'DedeUserID=42; Domain=.bilibili.com; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
    'sid=host-only; Path=/private; Secure', 'evil=bad; Domain=example.com; Path=/', 'root=bad; Domain=com; Path=/']) h.append('set-cookie', c);
  t.acceptCookies(h, 'https://passport.bilibili.com/private/login');
  assert.match(t.jar.getCookieStringSync(API + '/x'), /SESSDATA=old/);
  assert.match(t.jar.getCookieStringSync(API + '/x'), /DedeUserID=42/);
  assert.ok(!t.jar.getCookieStringSync(API + '/x').includes('host-only'));
  assert.ok(!t.jar.getCookieStringSync('http://api.bilibili.com/x').includes('SESSDATA'));
  assert.equal(t.jar.getCookieStringSync('https://upos.bilivideo.com/x'), '');
  assert.equal(t.jar.getCookieStringSync('https://example.com/x'), '');
  t.acceptCookies(new Headers({ 'set-cookie': 'SESSDATA=new; Domain=.bilibili.com; Path=/; Secure' }), 'https://passport.bilibili.com/');
  assert.match(t.jar.getCookieStringSync(API + '/'), /SESSDATA=new/);
  t.acceptCookies(new Headers({ 'set-cookie': 'SESSDATA=; Domain=.bilibili.com; Path=/; Max-Age=0' }), 'https://passport.bilibili.com/');
  assert.ok(!t.jar.getCookieStringSync(API + '/').includes('SESSDATA'));
});
test('credential restore is independent, bounded, and validates confirmed account; network is not expiry', async () => {
  const f = await restored(); assert.equal(f.provider.account.id, '42');
  assert.equal((await f.provider.handle('auth.credential.check')).valid, true);
  const fresh = fixture({ hook: u => u.pathname.endsWith('/nav') ? Promise.reject(new Error('secret_should_not_escape')) : undefined });
  await assert.rejects(fresh.provider.handle('auth.credential.restore', { credential: f.credential }), fault('network_unavailable'));
  assert.equal(fresh.provider.account, null); assert.ok(fresh.transport.credential().payload.includes('SYNTHETIC_TEST_ONLY'));
  assert.throws(() => f.transport.restore({ ...f.credential, providerId: 'netease' }), fault('credential_invalid'));
  assert.throws(() => f.transport.restore({ ...f.credential, payload: 'x'.repeat(65536) }), fault('credential_invalid'));
  await f.provider.handle('auth.logout'); assert.equal(f.transport.jar.getCookieStringSync(API), '');
});
test('all business results pass private strict schema, including part identities and backup payload', async () => {
  const f = await restored();
  const cases = {
    'search.videos': { keyword: '原题', page: 1, pageSize: 20 }, 'video.resolve': { input: BVID },
    'video.parts': { bvid: BVID, page: 1, pageSize: 20 }, 'library.containers': { kind: 'created', page: 1, pageSize: 20 },
    'library.videos': { containerId: '7', page: 1, pageSize: 20 },
    'playback.resolve': { track: { kind: 'videoPart', bvid: BVID, cid: '124' }, preferredQuality: 'aac' },
  };
  for (const [method, params] of Object.entries(cases)) {
    const result = await f.provider.handle(method, params);
    const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/${constants.methods[method].result}` });
    assert.ok(valid(result), `${method}: ${JSON.stringify(valid.errors)}`);
  }
  const parts = await f.provider.handle('video.parts', { bvid: BVID, page: 1, pageSize: 20 });
  assert.deepEqual(parts.items.map(x => x.ref.cid), ['123', '124']);
  assert.equal(parts.items[1].video.partTitle, '第二 P 原题'); assert.equal(parts.items[1].video.partNumber, 2);
  const audio = await f.provider.handle('playback.resolve', cases['playback.resolve']);
  assert.equal(audio.bitrate, 192000); assert.equal(audio.codec, 'aac'); assert.equal(audio.backupUrls.length, 1);
  assert.deepEqual(audio.dash, { initialization: '0-907', indexRange: '908-1047' });
  assert.equal(audio.expiresInSeconds, 0, 'no verified hard expiry; cache age is not media expiry');
  assert.ok(!('Cookie' in audio.headers));
});
test('created and collected folders preserve bounded multiline descriptions without losing the page', async () => {
  for (const intro of ['first line\nsecond line', 'first line\r\nsecond line']) {
    const f = await restored({ hook: u => {
      if (u.pathname.endsWith('/created/list-all')) return response({ list: [{ ...folder, intro }, { ...folder, id: 8, intro: 'single line' }] });
      if (u.pathname.endsWith('/collected/list')) return response({ list: [{ ...folder, intro, attr: 22, mid: 99 }, { ...folder, id: 8, intro: 'single line', attr: 22, mid: 99 }], has_more: false });
    } });
    for (const kind of ['created', 'favorite']) {
      const page = await f.provider.handle('library.containers', { kind, page: 1, pageSize: 20 });
      assert.equal(page.items.length, 2); assert.equal(page.items[0].description, intro);
      const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/${constants.methods['library.containers'].result}` });
      assert.ok(valid(page), JSON.stringify(valid.errors));
    }
  }
  for (const bad of ['bad\0description', 'x'.repeat(4097)]) {
    const f = await restored({ hook: u => u.pathname.endsWith('/created/list-all') ? response({ list: [{ ...folder, intro: bad }] }) : undefined });
    await assert.rejects(f.provider.handle('library.containers', { kind: 'created', page: 1, pageSize: 20 }), fault('upstream_schema_changed'));
  }
});
test('library self/collected owner is response-backed, private requests carry own cookie, no write actions', async () => {
  const f = await restored();
  const own = await f.provider.handle('library.containers', { kind: 'created', page: 1, pageSize: 1 });
  assert.equal(own.items[0].ownerId, '42'); assert.equal(own.items[0].ownership, 'created'); assert.deepEqual(own.items[0].allowedActions, []);
  const collected = await f.provider.handle('library.containers', { kind: 'favorite', page: 1, pageSize: 20 });
  assert.equal(collected.items[0].ownerId, '99'); assert.equal(collected.items[0].ownership, 'collected');
  const videos = await f.provider.handle('library.videos', { containerId: '7', page: 1, pageSize: 20 });
  assert.equal(videos.items[1].availability, 'deleted'); assert.equal(videos.items.length, 2);
  assert.match(f.calls.find(x => x.path.endsWith('/resource/list')).headers.Cookie, /SESSDATA/);
});
test('search strips highlights, omits non-video rows, no fabricated CID', async () => {
  const f = await restored(); const result = await f.provider.handle('search.videos', { keyword: '原题', page: 1, pageSize: 20 });
  assert.equal(result.items[0].title, '原题 & 文本'); assert.equal(result.items[0].durationMs, 7500000);
  assert.ok(!('ref' in result.items[0])); assert.equal(result.items.length, 1);
  assert.equal(plainTitle('A &#x4e2d; &#39; B'), "A 中 ' B");
});
test('API errors distinguish platform risks and item failures without invalidating cookies', async () => {
  for (const [code, context, expected] of [[-101,'','credential_invalid'],[-352,'','verification_required'],[-403,'','verification_required'],[-412,'','rate_limited'],[-404,'video','media_unavailable'],[62002,'video','media_unavailable'],[62004,'video','entitlement_denied'],[11201,'folder','entitlement_denied'],[123456,'','upstream_schema_changed']]) assert.throws(() => checkedData({ code }, context), fault(expected));
  const f = await restored(); await assert.rejects(f.provider.handle('search.videos', { keyword: 'verify-risk' }), fault('verification_required'));
  const before = f.calls.length; await assert.rejects(f.provider.handle('video.resolve', { input: BVID }), fault('verification_required')); assert.equal(f.calls.length, before);
});
test('no AAC is unsupported, highest compatible stream keeps only same-stream validated backups', () => {
  const data = { dash: { audio: [{ codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 192000, baseUrl: 'https://upos.bilivideo.com/a', backupUrl: ['https://evil.test/a', 'https://backup.bilivideo.cn/a'] }] } };
  assert.deepEqual(selectAacCandidates(data).backupUrls, ['https://backup.bilivideo.cn/a']);
  assert.throws(() => selectAacCandidates({ dash: { audio: [{ ...data.dash.audio[0], codecs: 'flac' }] } }), /unsupported_media/);
});
test('BV/AV/standard URLs canonicalize without fetching arbitrary inputs; b23 per-hop boundary', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) assert.equal(publicShortAddress(ip), false);
  assert.deepEqual(await resolveInput(BVID), { bvid: BVID }); assert.deepEqual(await resolveInput('av170001'), { aid: '170001' });
  assert.deepEqual(await resolveInput(`https://www.bilibili.com/video/${BVID}?p=2`), { bvid: BVID });
  let count = 0;
  assert.deepEqual(await resolveInput('https://b23.tv/test', async (url, opts) => { count++; assert.equal(opts.redirect, 'manual'); assert.ok(!opts.headers); return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${BVID}` } }); }), { bvid: BVID });
  assert.equal(count, 1);
  for (const url of ['file:///x', 'http://127.0.0.1/x', 'https://b23.tv.evil.test/x', 'https://www.bilibili.com/login', 'https://user@b23.tv/x', 'https://b23.tv:8080/x']) await assert.rejects(resolveInput(url), fault('invalid_params'));
  for (const location of ['http://192.168.1.1/x', 'https://passport.bilibili.com/login', 'https://www.bilibili.com/', 'https://b23.tv/test']) await assert.rejects(resolveInput('https://b23.tv/test', async () => new Response(null, { status: 302, headers: { location } })), fault('invalid_params'));
});
test('video aggregate may exceed 24h while each playable part remains bounded', async () => {
  const f = await restored({ hook: u => u.pathname.endsWith('/view') ? response({ ...view, duration: 94939 }) : undefined });
  const summary = await f.provider.handle('video.resolve', { input: BVID });
  assert.equal(summary.durationMs, 94939000);
  const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/video` }); assert.ok(valid(summary), JSON.stringify(valid.errors));
  assert.equal((await f.provider.handle('video.parts', { bvid: BVID, page: 1, pageSize: 20 })).items[0].durationMs, 3700000);
});
test('AV resolves via authoritative view; mismatched/unknown CID cannot be resolved for playback', async () => {
  const f = await restored(); assert.equal((await f.provider.handle('video.resolve', { input: 'av170001' })).bvid, BVID);
  assert.equal(f.calls.find(x => x.path.endsWith('/view')).params.aid, '170001');
  await assert.rejects(f.provider.handle('playback.resolve', { track: { kind: 'videoPart', bvid: BVID, cid: '999' }, preferredQuality: 'aac' }), fault('media_unavailable'));
});
test('real NDJSON pipeline coalesces concurrent identical pagination and redacts errors', async () => {
  let unblock; const gate = new Promise(r => { unblock = r; });
  const f = await restored({ hook: async u => { if (u.pathname.includes('/search/')) await gate; } });
  const input = new PassThrough(), output = new PassThrough(); let bytes = '';
  output.on('data', c => { bytes += c; });
  const running = runProvider(f.provider, input, output);
  const frame = (id, method, params) => JSON.stringify({ v: 2, id, method, params }) + '\n';
  input.write(frame('h', 'system.handshake', { protocolVersion: 2, providerId: 'bilibili' }));
  const params = { keyword: 'x', page: 1, pageSize: 20 };
  input.write(frame('1', 'search.videos', params)); input.write(frame('2', 'search.videos', params));
  await new Promise(r => setImmediate(r)); unblock(); input.end(); await running;
  const frames = bytes.trim().split('\n').map(JSON.parse); assert.equal(frames.length, 3); assert.ok(frames.every(x => x.ok));
  assert.equal(f.calls.filter(c => c.path.includes('/search/')).length, 1);
  assert.ok(!bytes.includes('SESSDATA')); assert.ok(!bytes.includes('Cookie')); assert.ok(!bytes.includes('SYNTHETIC_TEST_ONLY'));
});

test('QR accepts current account endpoint and legacy passport endpoint, rejects lookalikes', async () => {
  for (const url of ['https://account.bilibili.com/h5/account-h5/auth/scan-web?key=SYNTHETIC', 'https://passport.bilibili.com/h5-app/passport/login/scan?key=SYNTHETIC']) {
    const f = fixture({ hook:u=>u.pathname.endsWith('/generate')?response({url,qrcode_key:'SYNTHETIC'}):undefined });
    const qr = await f.provider.handle('auth.qr.start');
    assert.equal(qr.mimeType,'image/png');
    await f.provider.handle('auth.qr.cancel',{sessionId:qr.sessionId});
  }
  for (const url of ['http://account.bilibili.com/h5/account-h5/auth/scan-web', 'https://account.bilibili.com.evil.test/h5/account-h5/auth/scan-web', 'https://account.bilibili.com/other', 'https://user@account.bilibili.com/h5/account-h5/auth/scan-web']) {
    const f = fixture({ hook:u=>u.pathname.endsWith('/generate')?response({url,qrcode_key:'SYNTHETIC'}):undefined });
    await assert.rejects(f.provider.handle('auth.qr.start'),fault('upstream_schema_changed'));
  }
});

test('favorite contents translate logical pages to upstream pages of twenty without gaps', async () => {
  const all = Array.from({length:73},(_,i)=>({...view,aid:1000+i,title:`Item ${i}`,type:2,attr:0}));
  const f = await restored({hook:u=>{
    if (!u.pathname.endsWith('/resource/list')) return;
    assert.equal(u.searchParams.get('ps'),'20');
    const n=Number(u.searchParams.get('pn'));
    return response({info:{media_count:all.length},medias:all.slice((n-1)*20,n*20),has_more:n*20<all.length});
  }});
  const p1=await f.provider.handle('library.videos',{containerId:'7',page:1,pageSize:50});
  const p2=await f.provider.handle('library.videos',{containerId:'7',page:2,pageSize:50});
  assert.equal(p1.items.length,50); assert.equal(p1.hasMore,true);
  assert.equal(p2.items.length,23); assert.equal(p2.hasMore,false);
  assert.deepEqual([...p1.items,...p2.items].map(x=>x.title),all.map(x=>x.title));
  const small=await f.provider.handle('library.videos',{containerId:'7',page:2,pageSize:7});
  assert.deepEqual(small.items.map(x=>x.title),all.slice(7,14).map(x=>x.title));
});
