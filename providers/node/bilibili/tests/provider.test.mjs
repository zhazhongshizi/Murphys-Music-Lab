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
import { classifySubtitleTrack, selectSubtitleTracks, normalizeSubtitleCues, normalizeSubtitleTimeline, boundSubtitleResult } from '../subtitles.mjs';
const schema = JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.schema.json', import.meta.url)));
const constants = JSON.parse(readFileSync(new URL('../../../../contracts/protocol-v2.constants.json', import.meta.url)));
const ajv = new Ajv({ strict: false }); ajv.addSchema(schema);
async function restored(options) { const f = fixture(options); await f.provider.handle('auth.credential.restore', { credential: f.credential }); return f; }
const fault = code => e => e.code === code && e.message === code;
test('queue title uses the video title only for a single-part video, even when requesting one row', async () => {
  for (const pages of [view.pages.slice(0, 1), view.pages]) {
    const f = await restored({ hook: u => u.pathname === '/x/player/pagelist' ? response(pages) : undefined });
    const result = await f.provider.handle('video.parts', { bvid: BVID, page: 1, pageSize: 1 });
    assert.equal(result.total, pages.length);
    assert.equal(result.items[0].title, pages.length === 1 ? view.title : pages[0].part);
    assert.equal(result.items[0].video.partTitle, pages[0].part);
  }
});
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
test('large collection metadata in video details does not block parts or playback', async () => {
  const detail = { ...view, ugc_season: { sections: [{ episodes: [{ arc: { desc: 'x'.repeat(1600000) } }] }] } };
  const f = await restored({ hook: u => u.pathname === '/x/web-interface/view' ? response(detail) : undefined });
  const parts = await f.provider.handle('video.parts', { bvid: BVID });
  assert.deepEqual(parts.items.map(part => part.ref.cid), ['123', '124']);
  assert.equal(Object.hasOwn(parts.items[0], 'ugc_season'), false);
  const playback = await f.provider.handle('playback.resolve', { track: parts.items[0].ref });
  assert.equal(playback.codec, 'aac');
  assert.deepEqual(playback.track, parts.items[0].ref);
});
test('video details have a bounded response limit and other API limits stay smaller', async () => {
  const f = fixture({
    hook: u => response({ padding: 'x'.repeat(u.pathname === '/x/web-interface/view' ? 4 * 1024 * 1024 : 1024 * 1024) }),
  });
  await assert.rejects(f.transport.api('/x/web-interface/view', { bvid: BVID }), fault('upstream_schema_changed'));
  await assert.rejects(f.transport.api('/x/player/pagelist', { bvid: BVID }), fault('upstream_schema_changed'));
});
test('production write profile is explicit; cold process sends no requests', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const h = await f.provider.handle('system.handshake');
  assert.deepEqual(h.implementedMethods, methods); assert.deepEqual(h.capabilities, capabilities);
  assert.deepEqual(h.capabilities.writeActions, ['favorite.addVideos', 'favorite.removeVideos']); assert.equal(h.capabilities.lyrics, true);
  for (const m of ['lyrics.get', 'library.setLiked', 'auth.credential.refresh']) await assert.rejects(f.provider.handle(m), fault('unsupported_capability'));
  await assert.rejects(f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }), fault('authentication_required'));
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
    'subtitles.get': { track: { kind: 'videoPart', bvid: BVID, cid: '123' } },
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

test('subtitles.get selects manual over AI, isolates P1/P2 CIDs, handles no-track, and never forwards cookies or leaks CDN URLs', async () => {
  const f = await restored();
  const p1 = await f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } });
  assert.equal(p1.source, 'manual');
  assert.equal('timelineEndMs' in p1, false);
  assert.deepEqual(p1.track, { kind: 'videoPart', bvid: BVID, cid: '123' });
  assert.deepEqual(p1.lines, [
    { atMs: 500, endMs: 2250, text: '第一句上 第一句下' },
    { atMs: 3000, endMs: 6000, text: '第二句重叠前' },
    { atMs: 6000, endMs: 7500, text: '第三句接续' },
    { atMs: 18000, endMs: 20000, text: '间奏后第四句' },
  ]);
  const cdnCall = f.calls.find(c => c.host === 'aisubtitle.hdslb.com');
  assert.equal(cdnCall.path, '/bfs/subtitle/manual-zh-123.json');
  assert.equal('Cookie' in cdnCall.headers, false);
  assert.ok(!JSON.stringify(p1).includes('aisubtitle.hdslb.com'));

  const p2 = await f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '124' } });
  assert.equal(p2.source, 'ai');
  assert.equal('timelineEndMs' in p2, false);
  assert.deepEqual(p2.track, { kind: 'videoPart', bvid: BVID, cid: '124' });
  assert.deepEqual(p2.lines, [
    { atMs: 1200, endMs: 3400, text: '第二 P AI 字幕首句' },
    { atMs: 5000, endMs: 7250, text: '第二 P AI 字幕末句' },
  ]);

  const empty = await f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: 'BV17x411w7KE', cid: '123' } });
  assert.equal('timelineEndMs' in empty, false);
  assert.deepEqual(empty, { track: { kind: 'videoPart', bvid: 'BV17x411w7KE', cid: '123' }, source: 'none', lines: [] });
});

test('subtitle track classification and priority selection avoid mislabeling missing metadata as AI', async () => {
  assert.equal(classifySubtitleTrack({ lan: 'zh-CN', type: 0 }), 'manual');
  assert.equal(classifySubtitleTrack({ lan: 'zh-CN' }), 'unknown');
  assert.equal(classifySubtitleTrack({ lan: 'en-US', type: undefined, ai_type: 0, ai_status: 0 }), 'unknown');
  assert.equal(classifySubtitleTrack({ lan: 'ai-zh' }), 'ai');
  assert.equal(classifySubtitleTrack({ lan: 'zh-CN', type: 1 }), 'ai');
  assert.equal(classifySubtitleTrack({ lan: 'zh-CN', ai_type: 1 }), 'ai');
  assert.equal(classifySubtitleTrack({ lan: 'zh-CN', ai_status: 2 }), 'ai');

  const ordered = selectSubtitleTracks([
    { lan: 'en-US', type: 1, subtitle_url: '//aisubtitle.hdslb.com/ai-en.json' },
    { lan: 'zh-CN', type: 1, subtitle_url: '//aisubtitle.hdslb.com/ai-zh.json' },
    { lan: 'ja', subtitle_url: '//aisubtitle.hdslb.com/unk-ja.json' },
    { lan: 'zh-Hant', subtitle_url: '//aisubtitle.hdslb.com/unk-zh.json' },
    { lan: 'en-US', type: 0, subtitle_url: '//aisubtitle.hdslb.com/man-en.json' },
    { lan: 'zh-CN', type: 0, subtitle_url: '' },
    { lan: 'zh-Hans', type: 0, subtitle_url: '//aisubtitle.hdslb.com/man-zh-1.json' },
    { lan: 'zh-CN', type: 0, subtitle_url: '//aisubtitle.hdslb.com/man-zh-2.json' },
  ]);
  assert.deepEqual(ordered.map(x => [x.source, x.rawUrl]), [
    ['manual', '//aisubtitle.hdslb.com/man-zh-1.json'],
    ['manual', '//aisubtitle.hdslb.com/man-zh-2.json'],
    ['manual', '//aisubtitle.hdslb.com/man-en.json'],
    ['unknown', '//aisubtitle.hdslb.com/unk-zh.json'],
    ['unknown', '//aisubtitle.hdslb.com/unk-ja.json'],
    ['ai', '//aisubtitle.hdslb.com/ai-zh.json'],
    ['ai', '//aisubtitle.hdslb.com/ai-en.json'],
  ]);

  // Falls back to next track if first parses cleanly with 0 valid cues; preserves 'unknown' label.
  const f = await restored({
    hook: u => {
      if (u.pathname === '/x/player/wbi/v2') {
        return response({
          bvid: BVID,
          cid: 123,
          need_login_subtitle: false,
          subtitle: {
            subtitles: [
              { lan: 'zh-CN', type: 0, subtitle_url: 'https://aisubtitle.hdslb.com/empty.json' },
              { lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/unk.json' },
            ],
          },
        });
      }
      if (u.pathname === '/empty.json') return new Response(JSON.stringify({ body: [{ from: 1, to: 1, content: '无效区间' }] }), { status: 200 });
      if (u.pathname === '/unk.json') return new Response(JSON.stringify({ body: [{ from: 2.5, to: 4.0, content: '回退未知来源' }] }), { status: 200 });
    },
  });
  const res = await f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } });
  assert.equal(res.source, 'unknown');
  assert.deepEqual(res.lines, [{ atMs: 2500, endMs: 4000, text: '回退未知来源' }]);
});

test('subtitle cue normalization handles edge intervals, ordering, same-start, overlap, UTF-8 CJK truncation, 5000-line cap, and nul rejection', () => {
  const longCjk = '测试中文字幕'.repeat(40) + '🎵'; // > 512 UTF-8 bytes
  const cues = normalizeSubtitleCues({
    body: [
      { from: -0.5, to: 1.0, content: '负起点丢弃' },
      { from: 2.0, to: 2.0, content: '零长度丢弃' },
      { from: 3.0001, to: 3.0004, content: '舍入归零丢弃' },
      { from: 86400, to: 86405, content: '超上限丢弃' },
      { from: 5.0, to: 6.0, content: '   \r\n  ' },
      { from: 4.0, to: 5.2, content: '较短同起点' },
      { from: 4.0, to: 8.5, content: '较长同起点\r\n换行合并' },
      { from: 1.1236, to: 2.5, content: '首句小数' },
      { from: 7.0, to: 9.0, content: longCjk },
      { from: 86399.5, to: 86410, content: '末句钳制到上限' },
    ],
  });
  assert.equal(cues[0].atMs, 1124);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[1].atMs, 4000);
  assert.equal(cues[1].endMs, 7000); // clamped from 8500 due to overlap with 7000
  assert.equal(cues[1].text, '较长同起点 换行合并');
  assert.equal(cues[2].atMs, 7000);
  assert.ok(Buffer.byteLength(cues[2].text, 'utf8') <= 512);
  assert.ok(cues[2].text.length <= 512);
  assert.ok(!/[\uD800-\uDFFF]/.test(cues[2].text));
  assert.equal(cues[3].atMs, 86399500);
  assert.equal(cues[3].endMs, 86400000);

  const many = Array.from({ length: 5050 }, (_, i) => ({ from: i, to: i + 0.5, content: `行${i}` }));
  const capped = normalizeSubtitleCues({ body: many });
  assert.equal(capped.length, 5000);
  assert.equal(capped[4999].atMs, 4999000);

  assert.throws(() => normalizeSubtitleCues({ body: 'not-array' }), fault('upstream_schema_changed'));
  assert.throws(() => normalizeSubtitleCues({ body: [{ from: 0, to: 1, content: 'bad\0text' }] }), fault('upstream_schema_changed'));
});

test('subtitles.get distinguishes login-required, -101, untrusted CDN URLs, redirects, malformed JSON, and network timeouts', async () => {
  const loginReq = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2' ? response({ bvid: BVID, cid: 123, need_login_subtitle: true, subtitle: { subtitles: [] } }) : undefined,
  });
  await assert.rejects(
    loginReq.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
    fault('authentication_required'),
  );
  // authentication_required must not poison subsequent calls on the session.
  assert.equal((await loginReq.provider.handle('video.resolve', { input: BVID })).bvid, BVID);

  const code101 = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2' ? response(null, { code: -101 }) : undefined,
  });
  await assert.rejects(
    code101.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
    fault('credential_invalid'),
  );

  for (const badUrl of [
    'http://aisubtitle.hdslb.com/sub.json',
    'https://evil.test/sub.json',
    'https://aisubtitle.hdslb.com.evil.test/sub.json',
    'https://subtitle.bilibili.com/sub.json',
    'https://user@aisubtitle.hdslb.com/sub.json',
    'https://aisubtitle.hdslb.com:8443/sub.json',
    'https://aisubtitle.hdslb.com/sub.json#hash',
  ]) {
    const f = await restored({
      hook: u => u.pathname === '/x/player/wbi/v2'
        ? response({ bvid: BVID, cid: 123, need_login_subtitle: false, subtitle: { subtitles: [{ lan: 'zh-CN', type: 0, subtitle_url: badUrl }] } })
        : undefined,
    });
    await assert.rejects(
      f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
      fault('upstream_schema_changed'),
    );
  }

  for (const [mode, expected] of [['redirect', 'upstream_schema_changed'], ['bad-json', 'upstream_schema_changed'], ['timeout', 'network_unavailable']]) {
    const f = await restored({
      hook: u => {
        if (u.hostname === 'aisubtitle.hdslb.com') {
          if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://aisubtitle.hdslb.com/other.json' } });
          if (mode === 'bad-json') return new Response('{invalid', { status: 200 });
          if (mode === 'timeout') return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        }
      },
    });
    await assert.rejects(
      f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
      fault(expected),
    );
  }
});

test('subtitles.get passes NDJSON runProvider schema check without leaking secrets or subtitle_url', async () => {
  const f = await restored();
  const input = new PassThrough(), output = new PassThrough();
  let bytes = '';
  output.on('data', c => { bytes += c; });
  const running = runProvider(f.provider, input, output);
  const frame = (id, method, params) => JSON.stringify({ v: 2, id, method, params }) + '\n';
  input.write(frame('h', 'system.handshake', { protocolVersion: 2, providerId: 'bilibili' }));
  input.write(frame('s1', 'subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }));
  input.end();
  await running;
  const frames = bytes.trim().split('\n').map(JSON.parse);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].ok, true);
  assert.equal(frames[1].result.source, 'manual');
  assert.ok(!bytes.includes('aisubtitle.hdslb.com'));
  assert.ok(!bytes.includes('SESSDATA'));
});

test('subtitles.get rejects mismatched/missing upstream cid or bvid with upstream_schema_changed', async () => {
  const wrongCid = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2'
      ? response({
        bvid: BVID,
        cid: 123,
        need_login_subtitle: false,
        subtitle: {
          subtitles: [
            { id: 102, lan: 'zh-CN', lan_doc: '中文（中国）', type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/manual-zh-123.json' },
          ],
        },
      })
      : undefined,
  });
  await assert.rejects(
    wrongCid.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '124' } }),
    fault('upstream_schema_changed'),
  );

  for (const payload of [
    { bvid: BVID, need_login_subtitle: false, subtitle: { subtitles: [] } },
    { bvid: 'BV17x411w7KE', cid: 123, need_login_subtitle: false, subtitle: { subtitles: [] } },
  ]) {
    const f = await restored({
      hook: u => u.pathname === '/x/player/wbi/v2' ? response(payload) : undefined,
    });
    await assert.rejects(
      f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
      fault('upstream_schema_changed'),
    );
  }
});

test('subtitles.get rejects missing or malformed upstream subtitle structure instead of returning none', async () => {
  for (const payload of [
    {},
    { bvid: BVID, cid: 123 },
    { bvid: BVID, cid: 123, subtitle: null },
    { bvid: BVID, cid: 123, subtitle: [] },
    { bvid: BVID, cid: 123, subtitle: {} },
    { bvid: BVID, cid: 123, need_login_subtitle: 'true', subtitle: { subtitles: [] } },
  ]) {
    const f = await restored({
      hook: u => u.pathname === '/x/player/wbi/v2' ? response(payload) : undefined,
    });
    await assert.rejects(
      f.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
      fault('upstream_schema_changed'),
    );
  }
});

test('subtitles.get bounds 3000x360-byte cue payload strictly under 1 MiB NDJSON frame limit without crashing runProvider', async () => {
  const cueText = '中'.repeat(120); // 120 * 3 = 360 UTF-8 bytes
  assert.equal(Buffer.byteLength(cueText, 'utf8'), 360);
  const rawBody = JSON.stringify({
    body: Array.from({ length: 3000 }, (_, i) => ({
      from: i * 1.5,
      to: i * 1.5 + 1.0,
      content: cueText,
    })),
  });
  assert.ok(Buffer.byteLength(rawBody, 'utf8') > 1_048_576, 'raw CDN JSON should exceed 1 MiB');
  assert.ok(Buffer.byteLength(rawBody, 'utf8') < 2 * 1024 * 1024, 'raw CDN JSON should fit 2 MiB CDN cap');

  const f = await restored({
    hook: u => {
      if (u.pathname === '/x/player/wbi/v2') {
        return response({
          bvid: BVID,
          cid: 123,
          need_login_subtitle: false,
          subtitle: {
            subtitles: [{ lan: 'zh-CN', type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/large-3000.json' }],
          },
        });
      }
      if (u.pathname === '/bfs/subtitle/large-3000.json') {
        return new Response(rawBody, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    },
  });

  const input = new PassThrough(), output = new PassThrough();
  let bytes = '';
  output.on('data', c => { bytes += c; });
  const running = runProvider(f.provider, input, output);
  const frame = (id, method, params) => JSON.stringify({ v: 2, id, method, params }) + '\n';
  input.write(frame('h', 'system.handshake', { protocolVersion: 2, providerId: 'bilibili' }));
  input.write(frame('s-large', 'subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }));
  input.write(frame('ping-after', 'system.ping', {}));
  input.end();
  await running;

  const rawLines = bytes.trimEnd().split('\n');
  assert.equal(rawLines.length, 3);
  const frames = rawLines.map(JSON.parse);
  const largeIdx = frames.findIndex(x => x.id === 's-large');
  const pingIdx = frames.findIndex(x => x.id === 'ping-after');
  assert.notEqual(largeIdx, -1);
  assert.notEqual(pingIdx, -1);

  const largeFrameBytes = Buffer.byteLength(rawLines[largeIdx] + '\n', 'utf8');
  assert.ok(largeFrameBytes <= 1_048_576, `NDJSON frame ${largeFrameBytes} exceeded 1 MiB`);

  const largeFrame = frames[largeIdx];
  assert.equal(largeFrame.ok, true);
  assert.equal(largeFrame.result.source, 'manual');
  assert.ok(largeFrame.result.lines.length > 0 && largeFrame.result.lines.length < 3000);
  assert.equal(largeFrame.result.timelineEndMs, 4_499_500);
  assert.ok(largeFrame.result.lines.at(-1).endMs < 4_499_500);
  for (let i = 0; i < largeFrame.result.lines.length; i++) {
    const line = largeFrame.result.lines[i];
    assert.ok(line.atMs >= 0 && line.endMs > line.atMs);
    if (i > 0) assert.ok(largeFrame.result.lines[i - 1].endMs <= line.atMs);
  }
  assert.equal(frames[pingIdx].ok, true);
  assert.deepEqual(frames[pingIdx].result, { alive: true });
});

test('subtitles.get 50-minute 3000x360 ASCII fixture (cid=127) emits timelineEndMs=3000000 within 1 MiB NDJSON frame', async () => {
  const f = await restored();
  const input = new PassThrough(), output = new PassThrough();
  let bytes = '';
  output.on('data', c => { bytes += c; });
  const running = runProvider(f.provider, input, output);
  const frame = (id, method, params) => JSON.stringify({ v: 2, id, method, params }) + '\n';
  input.write(frame('h', 'system.handshake', { protocolVersion: 2, providerId: 'bilibili' }));
  input.write(frame('s-127', 'subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '127' } }));
  input.end();
  await running;

  const rawLines = bytes.trimEnd().split('\n');
  assert.equal(rawLines.length, 2);
  const frameBytes = Buffer.byteLength(rawLines[1] + '\n', 'utf8');
  assert.ok(frameBytes <= 1_048_576, `NDJSON frame ${frameBytes} exceeded 1 MiB`);
  const parsed = JSON.parse(rawLines[1]);
  assert.equal(parsed.ok, true);
  const result = parsed.result;
  assert.equal(result.source, 'manual');
  assert.ok(result.lines.length > 2000 && result.lines.length < 3000, `unexpected line count ${result.lines.length}`);
  assert.equal(result.timelineEndMs, 3_000_000);
  assert.ok(result.lines.at(-1).endMs < 3_000_000);
  const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/${constants.methods['subtitles.get'].result}` });
  assert.ok(valid(result), JSON.stringify(valid.errors));
});

test('5005-line short cues and boundSubtitleResult tail trimming preserve timelineEndMs while untruncated omits it', async () => {
  const shortBody = Array.from({ length: 5005 }, (_, i) => ({
    from: i * 0.5,
    to: i * 0.5 + 0.4,
    content: `L${i}`,
  }));
  const timeline = normalizeSubtitleTimeline({ body: shortBody });
  assert.equal(timeline.lines.length, 5000);
  assert.equal(timeline.timelineEndMs, 2_502_400);

  const untruncated = normalizeSubtitleTimeline({ body: shortBody.slice(0, 10) });
  assert.equal(untruncated.lines.length, 10);
  assert.equal(untruncated.timelineEndMs, undefined);

  const track = { kind: 'videoPart', bvid: BVID, cid: '123' };
  const untruncatedBounded = boundSubtitleResult(track, 'manual', untruncated.lines, untruncated.timelineEndMs);
  assert.equal('timelineEndMs' in untruncatedBounded, false);

  const tailTrimmed = boundSubtitleResult(track, 'manual', untruncated.lines, undefined, 320);
  assert.ok(tailTrimmed.lines.length > 0 && tailTrimmed.lines.length < 10);
  assert.equal(tailTrimmed.timelineEndMs, untruncated.lines.at(-1).endMs);
  assert.ok(Buffer.byteLength(JSON.stringify(tailTrimmed), 'utf8') <= 320);

  const f = await restored({
    hook: u => {
      if (u.pathname === '/x/player/wbi/v2') {
        return response({
          bvid: BVID,
          cid: 123,
          need_login_subtitle: false,
          subtitle: {
            subtitles: [{ lan: 'zh-CN', type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/short-5005.json' }],
          },
        });
      }
      if (u.pathname === '/bfs/subtitle/short-5005.json') {
        return new Response(JSON.stringify({ body: shortBody }), { status: 200 });
      }
    },
  });
  const res = await f.provider.handle('subtitles.get', { track });
  assert.equal(res.lines.length, 5000);
  assert.equal(res.timelineEndMs, 2_502_400);
  const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/${constants.methods['subtitles.get'].result}` });
  assert.ok(valid(res), JSON.stringify(valid.errors));
});

test('subtitles.get handles empty, login-required, malformed non-empty, stateful cid=126 recovery, and mixed tracks', async () => {
  // 1. Legal empty subtitles: [] (need_login_subtitle: false) -> source: 'none', lines: []
  const legalEmpty = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2'
      ? response({ bvid: BVID, cid: 123, need_login_subtitle: false, subtitle: { subtitles: [] } })
      : undefined,
  });
  const emptyRes = await legalEmpty.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } });
  assert.deepEqual(emptyRes, { track: { kind: 'videoPart', bvid: BVID, cid: '123' }, source: 'none', lines: [] });
  assert.equal('timelineEndMs' in emptyRes, false);

  // 2. Login required (need_login_subtitle: true with [] or [{}]) -> authentication_required
  for (const subtitles of [[], [{}]]) {
    const loginReq = await restored({
      hook: u => u.pathname === '/x/player/wbi/v2'
        ? response({ bvid: BVID, cid: 123, need_login_subtitle: true, subtitle: { subtitles } })
        : undefined,
    });
    await assert.rejects(
      loginReq.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
      fault('authentication_required'),
    );
  }

  // 3. Malformed non-empty subtitles: [{}] (need_login_subtitle: false) -> upstream_schema_changed
  const malformed = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2'
      ? response({ bvid: BVID, cid: 123, need_login_subtitle: false, subtitle: { subtitles: [{}] } })
      : undefined,
  });
  await assert.rejects(
    malformed.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } }),
    fault('upstream_schema_changed'),
  );

  // 3b. Stateful fixture cid=126: 1st call fails with upstream_schema_changed, 2nd call succeeds on same instance
  const stateful = await restored();
  await assert.rejects(
    stateful.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '126' } }),
    fault('upstream_schema_changed'),
  );
  const recovered = await stateful.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '126' } });
  assert.equal(recovered.source, 'manual');
  assert.equal('timelineEndMs' in recovered, false);
  assert.deepEqual(recovered.lines, [
    { atMs: 500, endMs: 2000, text: '恢复后第一句' },
    { atMs: 3000, endMs: 5000, text: '恢复后第二句' },
  ]);

  // 4. Mixed [{}, null, validTrack] -> skips bad entries and uses validTrack
  const mixed = await restored({
    hook: u => u.pathname === '/x/player/wbi/v2'
      ? response({
        bvid: BVID,
        cid: 123,
        need_login_subtitle: false,
        subtitle: {
          subtitles: [
            {},
            null,
            { id: 102, lan: 'zh-CN', type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/manual-zh-123.json' },
          ],
        },
      })
      : undefined,
  });
  const mixedRes = await mixed.provider.handle('subtitles.get', { track: { kind: 'videoPart', bvid: BVID, cid: '123' } });
  assert.equal(mixedRes.source, 'manual');
  assert.equal('timelineEndMs' in mixedRes, false);
  assert.equal(mixedRes.lines.length, 4);
});
