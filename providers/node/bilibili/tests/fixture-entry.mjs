import { fixture } from './fixture.mjs';
import { runProvider } from '../main.mjs';
const f = fixture();
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
