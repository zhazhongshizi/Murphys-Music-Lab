import type { ResultMap, PrivateAccount } from '../../../contracts/provider-v2.ts';

const fault = () => new Error('upstream_schema_changed');
function body(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== 'object' || !('body' in response) || !response.body || typeof response.body !== 'object') throw fault();
  return response.body as Record<string, unknown>;
}
export function qrKey(response: unknown): string {
  const data = body(response).data as Record<string, unknown> | undefined;
  if (!data || data.code !== 200 || typeof data.unikey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.unikey)) throw fault();
  return data.unikey;
}
export function qrImage(response: unknown, sessionId: string, expiresAtMs: number): ResultMap['auth.qr.start'] {
  const value = body(response);
  const data = value.data as Record<string, unknown> | undefined;
  if (value.code !== 200 || typeof data?.qrimg !== 'string' || !data.qrimg.startsWith('data:image/png;base64,')) throw fault();
  const imageBase64 = data.qrimg.slice('data:image/png;base64,'.length);
  const image = Buffer.from(imageBase64, 'base64');
  if (image.length > 256 * 1024 || image.toString('base64') !== imageBase64 || !image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fault();
  return {sessionId,mimeType:'image/png',imageBase64,expiresAtMs,pollAfterMs:2000};
}
export async function qrState(response: unknown, sessionId: string, checkAccount: (cookie: string) => Promise<PrivateAccount>): Promise<ResultMap['auth.qr.poll']> {
  const value = body(response);
  switch (value.code) {
    case 800: return {sessionId,state:'expired'};
    case 801: return {sessionId,state:'waitingScan'};
    case 802: return {sessionId,state:'waitingConfirmation'};
    case 803: {
      if (typeof value.cookie !== 'string' || !value.cookie.trim()) throw fault();
      const credential = {version:1 as const,providerId:'netease' as const,payload:JSON.stringify({cookie:value.cookie})};
      if (Buffer.byteLength(JSON.stringify(credential)) > 65536) throw fault();
      const account = await checkAccount(value.cookie);
      if (!account || typeof account.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(account.id) || typeof account.displayName !== 'string' || account.displayName.length > 512) throw fault();
      return {sessionId,state:'authenticated',account:{id:account.id,displayName:account.displayName},credential};
    }
    default: throw fault();
  }
}
