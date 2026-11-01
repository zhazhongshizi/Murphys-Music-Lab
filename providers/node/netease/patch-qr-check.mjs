// Fixed baseline patch, deliberately fails closed if upstream changes.
import { createHash } from 'node:crypto';
export function patchQrCheck(source) {
  source = source.replace(/\r\n/g, '\n');
  const blob = Buffer.from(source);
  const hash = createHash('sha1').update(`blob ${blob.length}\0`).update(blob).digest('hex');
  if (hash !== '1f34cb09d0a81d3f1c9ca048fec4f4ac2b850411') throw new Error('upstream_patch_baseline_mismatch');
  const old = `  } catch (error) {
    return {
      status: 200,
      body: {},
      cookie: result.cookie,
    }
  }`;
  if (source.split(old).length !== 2) throw new Error('upstream_patch_baseline_mismatch');
  return source.replace(old, `  } catch {
    throw new Error('netease_qr_request_failed')
  }`);
}
