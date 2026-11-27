import type { LyricSource, TimedLyricLine } from "../../contracts/lyrics";

export function activeLyricIndexAt(
  positionMs: number,
  lines: readonly Pick<TimedLyricLine, "atMs" | "endMs">[],
): number {
  if (!Number.isFinite(positionMs) || lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lines[mid]!.atMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return -1;
  const endMs = lines[candidate]!.endMs;
  if (endMs !== undefined && positionMs >= endMs) return -1;
  return candidate;
}

export function nextLyricIndexAt(
  positionMs: number,
  lines: readonly Pick<TimedLyricLine, "atMs">[],
): number {
  if (!Number.isFinite(positionMs) || lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lines[mid]!.atMs > positionMs) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

export function pastLyricCountAt(
  positionMs: number,
  lines: readonly Pick<TimedLyricLine, "atMs">[],
): number {
  if (!Number.isFinite(positionMs) || lines.length === 0) return 0;
  const next = nextLyricIndexAt(positionMs, lines);
  return next >= 0 ? next : lines.length;
}

export function formatLyricSourceLabel(source?: LyricSource): string | undefined {
  if (source === "bilibiliAiSubtitle") return "B站 AI 字幕";
  if (source === "bilibiliSubtitle") return "B站字幕";
  return undefined;
}
