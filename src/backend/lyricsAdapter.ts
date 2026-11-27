import { createSchemaGuards } from "./schemaGuards";
import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type { LyricSource, LyricTimeline, TimedLyricLine } from "../contracts/lyrics";

export const LYRICS_COMMAND = "lyrics_get" as const;

export class LyricsAdapterError extends Error {
  readonly code: "QMG-LYRICS-001" | "QMG-LYRICS-002";

  constructor(code: LyricsAdapterError["code"]) {
    super(code);
    this.name = "LyricsAdapterError";
    this.code = code;
  }
}

const TIMELINE_REQUIRED_KEYS = ["generation", "trackId", "lines"] as const;
const TIMELINE_OPTIONAL_KEYS = ["source", "timelineEndMs"] as const;
const LINE_REQUIRED_KEYS = ["atMs", "original"] as const;
const LINE_OPTIONAL_KEYS = ["endMs", "translation", "romanization"] as const;
const VALID_SOURCES: ReadonlySet<LyricSource> = new Set(["bilibiliSubtitle", "bilibiliAiSubtitle"]);
// Provider-scoped IDs such as `netease:track:123` contain colons.
const TRACK_ID = /^[A-Za-z0-9_:-]+$/;
const MAX_LINES = 5_000;
const MAX_END_MS = 86_400_000;
const encoder = new TextEncoder();

const { record: recordGuard, unsigned } = createSchemaGuards(invalid);

function invalid(): never {
  throw new LyricsAdapterError("QMG-LYRICS-002");
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximumBytes ||
    /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function parseSource(value: unknown): LyricSource {
  if (typeof value !== "string" || !VALID_SOURCES.has(value as LyricSource)) return invalid();
  return value as LyricSource;
}

function parseLine(value: unknown): TimedLyricLine {
  const record = recordGuard(value, LINE_REQUIRED_KEYS, LINE_OPTIONAL_KEYS);
  const atMs = unsigned(record.atMs);
  let endMs: number | undefined;
  if ("endMs" in record) {
    endMs = unsigned(record.endMs);
    if (endMs <= atMs || endMs > MAX_END_MS) return invalid();
  }
  const hasTranslation = "translation" in record;
  const hasRomanization = "romanization" in record;
  return {
    atMs,
    ...(endMs !== undefined ? { endMs } : {}),
    original: boundedText(record.original, 512),
    ...(hasTranslation ? { translation: boundedText(record.translation, 512) } : {}),
    ...(hasRomanization ? { romanization: boundedText(record.romanization, 512) } : {}),
  };
}

export function parseLyricTimeline(value: unknown): LyricTimeline {
  const record = recordGuard(value, TIMELINE_REQUIRED_KEYS, TIMELINE_OPTIONAL_KEYS);
  const trackId = boundedText(record.trackId, 128);
  if (!TRACK_ID.test(trackId)) return invalid();
  const hasSource = "source" in record;
  const source = hasSource ? parseSource(record.source) : undefined;
  const hasTimelineEndMs = "timelineEndMs" in record;
  if (!Array.isArray(record.lines) || record.lines.length > MAX_LINES) {
    return invalid();
  }
  if (record.lines.length === 0) {
    if (hasSource || hasTimelineEndMs) return invalid();
    return { generation: unsigned(record.generation), trackId, lines: [] };
  }
  const lines = record.lines.map(parseLine);
  for (let index = 1; index < lines.length; index += 1) {
    const prev = lines[index - 1]!;
    const curr = lines[index]!;
    if (curr.atMs <= prev.atMs) return invalid();
    if (prev.endMs !== undefined && prev.endMs > curr.atMs) return invalid();
  }
  let timelineEndMs: number | undefined;
  if (hasTimelineEndMs) {
    timelineEndMs = unsigned(record.timelineEndMs);
    const lastLine = lines[lines.length - 1]!;
    const lastLineEndMs = lastLine.endMs ?? lastLine.atMs;
    if (timelineEndMs > MAX_END_MS || timelineEndMs < lastLineEndMs) return invalid();
  }
  return {
    generation: unsigned(record.generation),
    trackId,
    ...(source !== undefined ? { source } : {}),
    ...(timelineEndMs !== undefined ? { timelineEndMs } : {}),
    lines,
  };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

export async function getTimedLyrics(trackId: string, generation: number): Promise<LyricTimeline> {
  const normalizedId = boundedText(trackId, 128);
  if (!TRACK_ID.test(normalizedId)) return invalid();
  const normalizedGeneration = unsigned(generation);
  if (!isTauriRuntime()) throw new LyricsAdapterError("QMG-LYRICS-001");
  try {
    return parseLyricTimeline(await invokePlayback(LYRICS_COMMAND, {
      trackId: normalizedId,
      generation: normalizedGeneration,
    }));
  } catch (error) {
    if (error instanceof LyricsAdapterError) throw error;
    throw new LyricsAdapterError("QMG-LYRICS-001");
  }
}
