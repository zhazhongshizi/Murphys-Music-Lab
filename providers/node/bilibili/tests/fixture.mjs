// Entirely synthetic HTTP fixture. No real account, credentials or media.
import { Transport } from '../transport.mjs';
import { BilibiliProvider } from '../provider.mjs';
export const BVID = 'BV17x411w7KC';
export const view = { bvid: BVID, aid: 170001, title: '视频原题', pic: 'http://i0.hdslb.com/bfs/archive/synthetic-cover.jpg', owner: { mid: 42, name: '测试 UP' }, duration: 7500,
  pages: [{ cid: 123, page: 1, part: '第一 P 原题', duration: 3700 }, { cid: 124, page: 2, part: '第二 P 原题', duration: 3800 }] };
export const nav = { isLogin: true, mid: 42, uname: '合成账号', wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } };
export const folder = { id: 7, mid: 42, title: '合成私有收藏夹', intro: '', media_count: 3, attr: 1 };
export function response(data, { code = 0, status = 200, cookies = [] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify({ code, data }), { status, headers });
}
export function fixture({ now = () => Date.now(), hook } = {}) {
  const calls = [], states = [86101, 86090, 0];
  let invalid = false;
  const fetcher = async (value, options) => {
    const u = new URL(value); calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: options.headers });
    const overridden = await hook?.(u, options); if (overridden) return overridden;
    switch (u.pathname) {
      case '/x/passport-login/web/qrcode/generate': return response({ url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=SYNTHETIC_TEST_ONLY', qrcode_key: 'SYNTHETIC_TEST_ONLY' });
      case '/x/passport-login/web/qrcode/poll': return response({ code: states.shift() ?? 0 }, { cookies: ['SESSDATA=SYNTHETIC_TEST_ONLY; Domain=.bilibili.com; Path=/; Secure; HttpOnly', 'DedeUserID=42; Domain=.bilibili.com; Path=/; Secure'] });
      case '/x/web-interface/nav': return invalid ? response(null, { code: -101 }) : response(nav);
      case '/x/web-interface/view': return response(view);
      case '/x/player/pagelist': return response(view.pages);
      case '/x/player/wbi/playurl': return response({ dash: { audio: [
        { codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 64000, baseUrl: 'https://upos.bilivideo.com/synthetic-64' },
        { codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 192000, baseUrl: 'https://upos.bilivideo.com/synthetic-192', backupUrl: ['https://upos-backup.bilivideo.cn/synthetic-192'], SegmentBase: { Initialization: '0-907', indexRange: '908-1047' } },
      ] } });
      case '/x/web-interface/wbi/search/type':
        if (u.searchParams.get('keyword') === 'invalidate-check') invalid = true;
        if (u.searchParams.get('keyword') === 'verify-risk') return response(null, { code: -352 });
        if (u.searchParams.get('keyword') === 'rate-limit') return response(null, { status: 429 });
        return response({ numResults: 2, numPages: 1, result: [
          { ...view, type: 'video', title: '<em class="keyword">原题</em> &amp; 文本', author: '测试 UP', duration: '125:00' },
          { type: 'ketang', bvid: '', title: '不收录课堂' },
        ] });
      case '/x/v3/fav/folder/created/list-all': return response({ list: [folder] });
      case '/x/v3/fav/folder/collected/list': return response({ list: [{ ...folder, id: 8, mid: undefined, upper: { mid: 99 }, attr: 22 }], count: 1, has_more: false });
      case '/x/v3/fav/resource/list': return response({ info: { ...folder, upper: { mid: 42 } }, medias: [
        { ...view, type: 2, attr: 0 }, { ...view, aid: 170002, type: 2, attr: 9, title: '已失效视频' }, { ...view, type: 12 },
      ], has_more: false });
      default: throw new Error('unexpected_fixture_path');
    }
  };
  const transport = new Transport(fetcher, now);
  transport.jar.setCookieSync('SESSDATA=SYNTHETIC_TEST_ONLY; Domain=.bilibili.com; Path=/; Secure; HttpOnly', 'https://passport.bilibili.com/');
  const credential = transport.credential(); transport.reset();
  const provider = new BilibiliProvider(transport, { now });
  return { provider, transport, fetcher, calls, credential };
}
