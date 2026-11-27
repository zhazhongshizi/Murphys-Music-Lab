import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LYRICS_COMMAND,
  LyricsAdapterError,
  getTimedLyrics,
  parseLyricTimeline,
} from "./lyricsAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const TIMELINE = {
  generation: 8,
  trackId: "0039MnYb0qxYhV",
  lines: [
    { atMs: 1_000, original: "第一句", translation: "First line" },
    { atMs: 2_500, original: "第二句", romanization: "di er ju" },
  ],
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("timed lyrics adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });
  afterEach(() => setTauriRuntime(false));

  it("只接收严格递增的有界时间轴且不接受原始 LRC/URL", () => {
    expect(parseLyricTimeline(TIMELINE)).toEqual(TIMELINE);
    expect(() => parseLyricTimeline({ ...TIMELINE, lyric: "[00:01]SENTINEL" })).toThrow();
    expect(() => parseLyricTimeline({ ...TIMELINE, lines: [{ ...TIMELINE.lines[0], url: "x" }] }))
      .toThrow();
    expect(() => parseLyricTimeline({
      ...TIMELINE,
      lines: [TIMELINE.lines[1], TIMELINE.lines[0]],
    })).toThrow(LyricsAdapterError);
  });

  it("使用固定命令并回传 generation 防止旧歌词写回", async () => {
    invokeMock.mockResolvedValue(TIMELINE);
    await expect(getTimedLyrics(TIMELINE.trackId, 8)).resolves.toEqual(TIMELINE);
    expect(invokeMock).toHaveBeenCalledWith(LYRICS_COMMAND, {
      trackId: TIMELINE.trackId,
      generation: 8,
    });
  });

  it("发送前拒绝非法 ID，原始 IPC 错误只映射稳定编号", async () => {
    await expect(getTimedLyrics("bad/id", 1)).rejects.toEqual(
      new LyricsAdapterError("QMG-LYRICS-002"),
    );
    invokeMock.mockRejectedValue(new Error("lyric=[00:01]SENTINEL; path"));
    await expect(getTimedLyrics(TIMELINE.trackId, 8)).rejects.toEqual(
      new LyricsAdapterError("QMG-LYRICS-001"),
    );
  });

  it("accepts provider-scoped NetEase track IDs", async () => {
    const netease = { ...TIMELINE, trackId: "netease:track:186016" };
    invokeMock.mockResolvedValue(netease);
    await expect(getTimedLyrics(netease.trackId, 8)).resolves.toEqual(netease);
  });

  it("accepts Bilibili subtitle endMs, source, optional timelineEndMs, and confirmed empty timelines without source", () => {
    const bilibiliManual = {
      generation: 3,
      trackId: "bilibili:video:BV1zQ4y127rF:389067834",
      source: "bilibiliSubtitle" as const,
      lines: [
        { atMs: 0, endMs: 10_020, original: "第一句" },
        { atMs: 10_020, endMs: 12_170, original: "第二句" },
        { atMs: 86_399_000, endMs: 86_400_000, original: "边界句" },
      ],
    };
    const bilibiliAi = {
      ...bilibiliManual,
      source: "bilibiliAiSubtitle" as const,
    };
    const truncated = {
      generation: 5,
      trackId: "bilibili:video:BV17x411w7KC:127",
      source: "bilibiliSubtitle" as const,
      timelineEndMs: 3_000_000,
      lines: [
        { atMs: 0, endMs: 1_000, original: "第一句" },
        { atMs: 2_361_000, endMs: 2_362_000, original: "截断末句" },
      ],
    };
    const exactLastEnd = {
      generation: 6,
      trackId: "bilibili:video:BV17x411w7KC:127",
      source: "bilibiliSubtitle" as const,
      timelineEndMs: 2_362_000,
      lines: [{ atMs: 2_361_000, endMs: 2_362_000, original: "同值边界" }],
    };
    const atMsBoundary = {
      generation: 7,
      trackId: "bilibili:video:BV17x411w7KC:127",
      timelineEndMs: 86_400_000,
      lines: [{ atMs: 86_399_000, original: "无 endMs 最大边界" }],
    };
    const emptyNoSubtitle = {
      generation: 4,
      trackId: "bilibili:video:BV1fK4y1t7hj:196018899",
      lines: [],
    };
    const parsedManual = parseLyricTimeline(bilibiliManual);
    expect(parsedManual).toEqual(bilibiliManual);
    expect("timelineEndMs" in parsedManual).toBe(false);
    expect(parseLyricTimeline(bilibiliAi)).toEqual(bilibiliAi);
    expect(parseLyricTimeline(truncated)).toEqual(truncated);
    expect(parseLyricTimeline(exactLastEnd)).toEqual(exactLastEnd);
    expect(parseLyricTimeline(atMsBoundary)).toEqual(atMsBoundary);
    expect(parseLyricTimeline(emptyNoSubtitle)).toEqual(emptyNoSubtitle);
  });

  it("rejects malformed empty-with-source, bad endMs, bad timelineEndMs, overlapping cues, and invalid source as QMG-LYRICS-002", () => {
    const invalidPayloads: unknown[] = [
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", source: "bilibiliSubtitle", lines: [] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: 1000, lines: [] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: 2_361_999, lines: [{ atMs: 2_361_000, endMs: 2_362_000, original: "truncated" }] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: 999, lines: [{ atMs: 1000, original: "no-end" }] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: 86_400_001, lines: [{ atMs: 1000, endMs: 2000, original: "over-max" }] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: 3000.5, lines: [{ atMs: 1000, endMs: 2000, original: "float" }] },
      { generation: 1, trackId: "bilibili:video:BV17x411w7KC:127", timelineEndMs: undefined, lines: [{ atMs: 1000, endMs: 2000, original: "undef" }] },
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", source: "qqmusic", lines: [{ atMs: 0, endMs: 1000, original: "a" }] },
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", lines: [{ atMs: 1000, endMs: 1000, original: "equal" }] },
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", lines: [{ atMs: 1000, endMs: 900, original: "backwards" }] },
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", lines: [{ atMs: 1000, endMs: 1000.5, original: "float" }] },
      { generation: 1, trackId: "bilibili:video:BV1zQ4y127rF:1", lines: [{ atMs: 1000, endMs: 86_400_001, original: "over-max" }] },
      {
        generation: 1,
        trackId: "bilibili:video:BV1zQ4y127rF:1",
        lines: [
          { atMs: 1000, endMs: 2500, original: "first" },
          { atMs: 2499, endMs: 3000, original: "overlap" },
        ],
      },
      { ...TIMELINE, source: undefined },
    ];
    for (const payload of invalidPayloads) {
      expect(() => parseLyricTimeline(payload)).toThrow(new LyricsAdapterError("QMG-LYRICS-002"));
    }
  });
});
