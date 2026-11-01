// Explicit manual-spikes probe ONLY. No real auth, private library or cookies.
// Synthetic account/credential lets the real Registry/Provider/Controller path
// exercise legal public media without treating it as user login acceptance.
import { Transport, API } from '../transport.mjs';
import { BilibiliProvider } from '../provider.mjs';
import { runProvider } from '../main.mjs';
import { BV } from '../links.mjs';
import { fail } from '../fault.mjs';
const [flag, bvid] = process.argv.slice(2);
if (flag !== '--public-probe' || !BV.test(bvid)) process.exit(2);
const t = new Transport();
t.restore = c => { if (c?.payload !== 'SYNTHETIC_PUBLIC_PROBE') fail('credential_invalid'); };
const api = t.api.bind(t);
t.api = async (path, params = {}, context = '') => {
  if (path === '/x/web-interface/nav') {
    const result = await t.request(API + path, false);
    if (![0, -101].includes(result.code) || !result.data?.wbi_img) fail('upstream_schema_changed');
    return { ...result.data, isLogin: true, mid: 42, uname: 'Synthetic public-media probe' };
  }
  if (!['/x/web-interface/view', '/x/player/pagelist', '/x/player/wbi/playurl'].includes(path)) fail('unsupported_capability');
  const query = typeof params === 'string' ? new URLSearchParams(params) : new URLSearchParams(params);
  if (query.get('bvid') !== bvid) fail('invalid_params');
  return api(path, params, context);
};
await runProvider(new BilibiliProvider(t));
