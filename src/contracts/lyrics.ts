export type LyricSource = "bilibiliSubtitle" | "bilibiliAiSubtitle";

export interface TimedLyricLine {
  readonly atMs: number;
  readonly endMs?: number;
  readonly original: string;
  readonly translation?: string;
  readonly romanization?: string;
}

export interface LyricTimeline {
  readonly generation: number;
  readonly trackId: string;
  readonly source?: LyricSource;
  readonly timelineEndMs?: number;
  readonly lines: readonly TimedLyricLine[];
}
