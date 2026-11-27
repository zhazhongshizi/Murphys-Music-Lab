import { describe, expect, it } from "vitest";
import {
  activeLyricIndexAt,
  formatLyricSourceLabel,
  nextLyricIndexAt,
  pastLyricCountAt,
} from "./lyricSelection";

const SUBTITLE_CUES = [
  { atMs: 10_030, endMs: 12_025 },
  { atMs: 25_000, endMs: 28_500 },
  { atMs: 40_000, endMs: 45_000 },
] as const;

const LEGACY_LYRICS = [
  { atMs: 0 },
  { atMs: 46_000 },
  { atMs: 102_000 },
] as const;

describe("lyricSelection", () => {
  it("enforces half-open [atMs, endMs) intervals, interlude gaps, and reverse seeks", () => {
    expect(activeLyricIndexAt(0, [])).toBe(-1);
    expect(activeLyricIndexAt(10_029, SUBTITLE_CUES)).toBe(-1);
    expect(activeLyricIndexAt(10_030, SUBTITLE_CUES)).toBe(0);
    expect(activeLyricIndexAt(11_000, SUBTITLE_CUES)).toBe(0);
    expect(activeLyricIndexAt(12_024, SUBTITLE_CUES)).toBe(0);
    expect(activeLyricIndexAt(12_025, SUBTITLE_CUES)).toBe(-1);
    expect(activeLyricIndexAt(20_000, SUBTITLE_CUES)).toBe(-1);
    expect(activeLyricIndexAt(25_000, SUBTITLE_CUES)).toBe(1);
    expect(activeLyricIndexAt(28_500, SUBTITLE_CUES)).toBe(-1);
    expect(activeLyricIndexAt(42_000, SUBTITLE_CUES)).toBe(2);
    expect(activeLyricIndexAt(45_000, SUBTITLE_CUES)).toBe(-1);
    // Reverse seek back into middle of an earlier cue
    expect(activeLyricIndexAt(26_500, SUBTITLE_CUES)).toBe(1);
    expect(activeLyricIndexAt(10_500, SUBTITLE_CUES)).toBe(0);
  });

  it("preserves legacy QQ/NetEase behavior when endMs is undefined", () => {
    expect(activeLyricIndexAt(0, LEGACY_LYRICS)).toBe(0);
    expect(activeLyricIndexAt(45_999, LEGACY_LYRICS)).toBe(0);
    expect(activeLyricIndexAt(46_000, LEGACY_LYRICS)).toBe(1);
    expect(activeLyricIndexAt(250_000, LEGACY_LYRICS)).toBe(2);
  });

  it("finds next upcoming line and past count across interlude gaps", () => {
    expect(nextLyricIndexAt(5_000, SUBTITLE_CUES)).toBe(0);
    expect(nextLyricIndexAt(10_030, SUBTITLE_CUES)).toBe(1);
    expect(nextLyricIndexAt(18_000, SUBTITLE_CUES)).toBe(1);
    expect(nextLyricIndexAt(45_000, SUBTITLE_CUES)).toBe(-1);

    expect(pastLyricCountAt(5_000, SUBTITLE_CUES)).toBe(0);
    expect(pastLyricCountAt(10_030, SUBTITLE_CUES)).toBe(1);
    expect(pastLyricCountAt(18_000, SUBTITLE_CUES)).toBe(1);
    expect(pastLyricCountAt(28_500, SUBTITLE_CUES)).toBe(2);
    expect(pastLyricCountAt(45_000, SUBTITLE_CUES)).toBe(3);
  });

  it("formats Bilibili lyric source labels without mislabeling missing sources", () => {
    expect(formatLyricSourceLabel("bilibiliSubtitle")).toBe("B站字幕");
    expect(formatLyricSourceLabel("bilibiliAiSubtitle")).toBe("B站 AI 字幕");
    expect(formatLyricSourceLabel(undefined)).toBeUndefined();
  });
});
