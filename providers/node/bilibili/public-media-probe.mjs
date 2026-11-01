// Parent pipes this private descriptor directly to the Rust probe's stdin.
// Never redirect stdout into a log, fixture or persisted queue.
import { resolvePublicProbe } from './audio.mjs';
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--public-probe') throw new Error('explicit_probe_required');
  const media = await resolvePublicProbe(process.argv[3]);
  process.stdout.write(JSON.stringify(media)+'\n');
} catch (error) {
  const known = /^(bilibili_http_[0-9]{3}|video_unavailable|wbi_unavailable|playurl_unavailable|unsupported_media|invalid_bvid|explicit_probe_required)$/;
  process.stderr.write(known.test(error.message) ? error.message+'\n' : 'public_media_probe_failed\n');
  process.exitCode=2;
}
