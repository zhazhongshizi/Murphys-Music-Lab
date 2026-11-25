import { fixture, response, view } from './fixture.mjs';
import { runProvider } from '../main.mjs';
const coverFault = process.argv[3];
const f = fixture({ hook: url => {
  const bvid = url.searchParams.get('bvid');
  if (bvid === 'BV17x411w7KE') {
    if (url.pathname === '/x/web-interface/view') return response({ ...view, bvid });
    if (url.pathname === '/x/player/pagelist') return response(view.pages.slice(0, 1));
  }
  if (url.pathname !== '/x/web-interface/view' || url.searchParams.get('bvid') !== 'BV17x411w7KD') return;
  if (coverFault === 'rate_limited') return response(null, { status: 429 });
  if (coverFault === 'verification_required') return response(null, { code: -352 });
} });
const restore = f.transport.restore.bind(f.transport);
f.transport.restore = c => restore(c.payload === 'SYNTHETIC_TEST_ONLY' ? f.credential : c);
// Tests may supply a synthetic *verified* lifetime. The production adapter has
// no verified lifetime and returns zero, never this command-line override.
const expiry = Number(process.argv[2] ?? 0);
if (!Number.isSafeInteger(expiry) || expiry < 0 || expiry > 86400) throw new Error('invalid_fixture_expiry');
const handle = f.provider.handle.bind(f.provider);
f.provider.handle = async (method, params) => {
  const result = await handle(method, params);
  return method === 'playback.resolve' ? { ...result, expiresInSeconds: expiry } : result;
};
await runProvider(f.provider);
