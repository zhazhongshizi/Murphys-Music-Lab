import { fail } from './fault.mjs';

export const MAX_TIMED_LINES = 5000;
export const MAX_TEXT_BYTES = 512;
export const MAX_SUBTITLE_MS = 86_400_000;
export const MAX_SERIALIZED_LINES_BYTES = 950_000;
export const MAX_SUBTITLE_RESULT_BYTES = 980_000;

const CHINESE_LAN_PATTERN = /^(?:ai[-_])?zh(?:[-_]|$)/i;
const SOURCE_TIER = { manual: 0, unknown: 1, ai: 2 };

/**
 * Classifies a Bilibili subtitle track without mislabeling missing metadata as AI.
 * @param {Record<string, unknown>} track
 * @returns {'manual' | 'ai' | 'unknown'}
 */
export function classifySubtitleTrack(track) {
  if (!track || typeof track !== 'object') return 'unknown';
  const lan = typeof track.lan === 'string' ? track.lan.trim() : '';
  const isAi = track.type === 1
    || track.ai_type === 1
    || (typeof track.ai_status === 'number' && track.ai_status !== 0)
    || /^ai[-_]/i.test(lan);
  if (isAi) return 'ai';
  if (track.type === 0) return 'manual';
  return 'unknown';
}

/**
 * Checks whether a subtitle track language tag represents Chinese.
 * @param {unknown} lan
 * @returns {boolean}
 */
export function isChineseSubtitleLan(lan) {
  return typeof lan === 'string' && CHINESE_LAN_PATTERN.test(lan.trim());
}

/**
 * Orders candidate subtitle tracks by source tier (manual < unknown < ai),
 * Chinese language preference, and original upstream array order.
 * Skips tracks missing a non-empty subtitle_url.
 * @param {unknown[]} tracks
 * @returns {Array<{ rawUrl: string; source: 'manual' | 'ai' | 'unknown'; lan: string; originalIndex: number }>}
 */
export function selectSubtitleTracks(tracks) {
  if (!Array.isArray(tracks)) fail('upstream_schema_changed');
  const candidates = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track || typeof track !== 'object') continue;
    const rawUrl = typeof track.subtitle_url === 'string' ? track.subtitle_url.trim() : '';
    if (!rawUrl) continue;
    const lan = typeof track.lan === 'string' ? track.lan.trim() : '';
    const source = classifySubtitleTrack(track);
    candidates.push({ rawUrl, source, lan, originalIndex: i });
  }
  candidates.sort((a, b) => {
    const tierDiff = SOURCE_TIER[a.source] - SOURCE_TIER[b.source];
    if (tierDiff !== 0) return tierDiff;
    const zhDiff = (isChineseSubtitleLan(a.lan) ? 0 : 1) - (isChineseSubtitleLan(b.lan) ? 0 : 1);
    if (zhDiff !== 0) return zhDiff;
    return a.originalIndex - b.originalIndex;
  });
  return candidates;
}

/**
 * Truncates text cleanly on Unicode codepoint boundaries within maxBytes UTF-8 bytes.
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes = MAX_TEXT_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (used + bytes > maxBytes) break;
    out += ch;
    used += bytes;
  }
  return out.trim();
}

/**
 * Normalizes raw Bilibili subtitle JSON into bounded, strictly increasing lines
 * capped by both line count and serialized UTF-8 byte budget, preserving the
 * untruncated timeline end timestamp when lines are truncated.
 * @param {unknown} payload
 * @param {number} [maxSerializedBytes]
 * @returns {{ lines: Array<{ atMs: number; endMs: number; text: string }>; timelineEndMs?: number }}
 */
export function normalizeSubtitleTimeline(payload, maxSerializedBytes = MAX_SERIALIZED_LINES_BYTES) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.body)) {
    fail('upstream_schema_changed');
  }
  const cues = [];
  for (let i = 0; i < payload.body.length; i++) {
    const item = payload.body[i];
    if (!item || typeof item !== 'object') fail('upstream_schema_changed');
    if (typeof item.content !== 'string' || item.content.includes('\0')) {
      fail('upstream_schema_changed');
    }
    if (!Number.isFinite(item.from) || !Number.isFinite(item.to)) continue;
    if (item.from < 0) continue;
    const atMs = Math.round(item.from * 1000);
    if (atMs < 0 || atMs >= MAX_SUBTITLE_MS) continue;
    const endMs = Math.min(Math.round(item.to * 1000), MAX_SUBTITLE_MS);
    if (endMs <= atMs) continue;
    const collapsed = item.content.replace(/[\r\n]+/g, ' ').trim();
    if (!collapsed) continue;
    const text = truncateUtf8(collapsed, MAX_TEXT_BYTES);
    if (!text) continue;
    cues.push({ atMs, endMs, text, originalIndex: i });
  }
  cues.sort((a, b) => (a.atMs - b.atMs) || (a.endMs - b.endMs) || (a.originalIndex - b.originalIndex));
  const lines = [];
  for (const cue of cues) {
    const prev = lines[lines.length - 1];
    if (prev && cue.atMs === prev.atMs) {
      lines[lines.length - 1] = { atMs: cue.atMs, endMs: cue.endMs, text: cue.text };
      continue;
    }
    if (prev && prev.endMs > cue.atMs) {
      prev.endMs = cue.atMs;
    }
    lines.push({ atMs: cue.atMs, endMs: cue.endMs, text: cue.text });
  }
  const fullEndMs = lines.length > 0 ? lines[lines.length - 1].endMs : undefined;
  const bounded = [];
  let usedBytes = 2; // '[]'
  for (const line of lines) {
    if (bounded.length >= MAX_TIMED_LINES) break;
    const itemBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') + (bounded.length > 0 ? 1 : 0);
    if (usedBytes + itemBytes > maxSerializedBytes) break;
    bounded.push(line);
    usedBytes += itemBytes;
  }
  return {
    lines: bounded,
    timelineEndMs: bounded.length < lines.length ? fullEndMs : undefined,
  };
}

/**
 * Normalizes raw Bilibili subtitle JSON into bounded, strictly increasing lines
 * capped by both line count and serialized UTF-8 byte budget.
 * @param {unknown} payload
 * @param {number} [maxSerializedBytes]
 * @returns {Array<{ atMs: number; endMs: number; text: string }>}
 */
export function normalizeSubtitleCues(payload, maxSerializedBytes = MAX_SERIALIZED_LINES_BYTES) {
  return normalizeSubtitleTimeline(payload, maxSerializedBytes).lines;
}

/**
 * Trims tail lines if needed so the serialized subtitles.get result stays
 * strictly under the 1 MiB NDJSON IPC frame limit, preserving timelineEndMs
 * only when the returned lines were truncated.
 * @param {Record<string, unknown>} track
 * @param {'manual' | 'ai' | 'unknown' | 'none'} source
 * @param {Array<{ atMs: number; endMs: number; text: string }>} lines
 * @param {number} [timelineEndMs]
 * @param {number} [maxResultBytes]
 * @returns {{ track: Record<string, unknown>; source: string; lines: Array<{ atMs: number; endMs: number; text: string }>; timelineEndMs?: number }}
 */
export function boundSubtitleResult(
  track,
  source,
  lines,
  timelineEndMs,
  maxResultBytes = MAX_SUBTITLE_RESULT_BYTES,
) {
  const trimmed = lines.slice();
  const originalLastEndMs = timelineEndMs ?? (lines.length > 0 ? lines[lines.length - 1].endMs : undefined);
  const buildResult = () => {
    const truncated = timelineEndMs !== undefined || trimmed.length < lines.length;
    return truncated && originalLastEndMs !== undefined
      ? { track, source, lines: trimmed, timelineEndMs: originalLastEndMs }
      : { track, source, lines: trimmed };
  };
  while (trimmed.length > 0 && Buffer.byteLength(JSON.stringify(buildResult()), 'utf8') > maxResultBytes) {
    trimmed.pop();
  }
  return buildResult();
}
