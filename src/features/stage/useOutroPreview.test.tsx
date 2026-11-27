import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseLyricTimeline } from "../../backend/lyricsAdapter";
import { FIXTURE_TRACKS } from "../player/fixtures";
import type { PlayerSnapshot } from "../player/playerStore";
import { isOutroPosition, useOutroPreview } from "./useOutroPreview";

const mock = vi.hoisted(() => ({ snapshot: {} as PlayerSnapshot, preview: vi.fn() }));
vi.mock("../player/playerStore", () => ({
  getCurrentTrack: (s: PlayerSnapshot) => s.queue[s.currentIndex] ?? null,
  usePlayerSelector: (selector: (s: PlayerSnapshot) => unknown) => selector(mock.snapshot),
}));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueuePreviewNext: mock.preview }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const baseSnapshot: PlayerSnapshot = {
  nativeMode: true, nativeLoaded: true, lyricsReady: true, generation: 1,
  queue: FIXTURE_TRACKS, currentIndex: 0, isPlaying: true, positionMs: 0,
  volume: .5, muted: false, mode: "sequence", defaultQuality: "320k",
  requestedQuality: "320k", likedIds: [], playbackError: null,
};

it.each([
  { positionMs: 244999, durationMs: 248000, expected: false },
  { positionMs: 245000, durationMs: 248000, expected: true },
  { positionMs: 247999, durationMs: 248000, expected: true },
  { positionMs: 248000, durationMs: 248000, expected: false },
  { positionMs: 0, durationMs: 0, expected: false },
  { positionMs: 0, durationMs: 2000, expected: true },
])("无歌词使用实际时长的最后三秒窗口 %#", ({ positionMs, durationMs, expected }) => {
  const snapshot = { ...baseSnapshot, queue: [{ ...FIXTURE_TRACKS[0]!, lyrics: [], durationMs }], positionMs };
  expect(isOutroPosition(snapshot)).toBe(expected);
});

it("空白歌词视为无歌词，加载中与播放失败不提前触发", () => {
  const snapshot = { ...baseSnapshot, queue: [{ ...FIXTURE_TRACKS[0]!, lyrics: [{ atMs: 0, original: "  " }] }],
    positionMs: 245000, lyricsReady: false };
  expect(isOutroPosition(snapshot)).toBe(false);
  expect(isOutroPosition({ ...snapshot, lyricsReady: true })).toBe(true);
  expect(isOutroPosition({ ...snapshot, lyricsReady: true, playbackError: { reason: "network", message: "播放失败" } })).toBe(false);
});

it("keeps an open preview stable across native metadata refreshes but invalidates reordered queues", async () => {
  mock.snapshot = {
    nativeMode: true, generation: 8, queue: FIXTURE_TRACKS,
    currentIndex: 0, isPlaying: true, positionMs: 220_000, mode: "sequence", playbackError: null,
  } as PlayerSnapshot;
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[1]!.id);
  const { result, rerender } = renderHook(() => useOutroPreview());
  await act(async () => {});
  expect(result.current.active).toBe(true);
  for (let i = 0; i < 4; i += 1) {
    mock.snapshot = { ...mock.snapshot, queue: mock.snapshot.queue.map(t => ({ ...t, durationMs: t.durationMs + 1 })) };
    rerender();
    expect(result.current.active).toBe(true);
    expect(result.current.nextId).toBe(FIXTURE_TRACKS[1]!.id);
  }
  expect(mock.preview).toHaveBeenCalledTimes(1);
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[2]!.id);
  mock.snapshot = { ...mock.snapshot, queue: [FIXTURE_TRACKS[0]!, FIXTURE_TRACKS[2]!, FIXTURE_TRACKS[1]!] };
  rerender();
  await act(async () => {});
  expect(result.current.nextId).toBe(FIXTURE_TRACKS[2]!.id);
  expect(mock.preview).toHaveBeenCalledTimes(2);
});

it("uses last.endMs + 3000 for long final subtitle cues and hides on reverse seek", async () => {
  const subtitleTrack = {
    ...FIXTURE_TRACKS[0]!,
    durationMs: 160_000,
    lyrics: [{ atMs: 140_000, endMs: 150_000, original: "长末句字幕" }],
  };
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[1]!.id);

  // atMs + 3000 (143_000) and endMs + 2999 (152_999) must NOT trigger outro
  mock.snapshot = { ...baseSnapshot, queue: [subtitleTrack, FIXTURE_TRACKS[1]!], positionMs: 143_000 };
  const { result, rerender } = renderHook(() => useOutroPreview());
  expect(result.current.active).toBe(false);

  mock.snapshot = { ...mock.snapshot, positionMs: 152_999 };
  rerender();
  expect(result.current.active).toBe(false);

  // endMs + 3000 (153_000) triggers outro
  mock.snapshot = { ...mock.snapshot, positionMs: 153_000 };
  rerender();
  await act(async () => {});
  expect(result.current.active).toBe(true);

  // reverse seek back before endMs + 3000 hides outro cleanly
  mock.snapshot = { ...mock.snapshot, positionMs: 151_000 };
  rerender();
  expect(result.current.active).toBe(false);
});

it("suppresses premature outro on truncated timelines via parseLyricTimeline, triggers at timelineEndMs + 3000, and exits on reverse seek", async () => {
  const parsed = parseLyricTimeline({
    generation: 1,
    trackId: "bilibili:video:BV17x411w7KC:127",
    source: "bilibiliSubtitle",
    timelineEndMs: 3_000_000,
    lines: [
      { atMs: 0, endMs: 1_000, original: "第一句" },
      { atMs: 2_361_000, endMs: 2_362_000, original: "截断末句" },
    ],
  });
  const baseTruncatedTrack = {
    ...FIXTURE_TRACKS[0]!,
    id: parsed.trackId,
    lyricSource: parsed.source,
    lyricTimelineEndMs: parsed.timelineEndMs,
    lyrics: parsed.lines.map((line) => ({
      atMs: line.atMs,
      ...(line.endMs !== undefined ? { endMs: line.endMs } : {}),
      original: line.original,
    })),
  };

  // 1. 50-minute sample (durationMs = 3_000_000) at 39m 25s (2_365_000 ms) MUST NOT trigger
  const exactEndSnapshot: PlayerSnapshot = {
    ...baseSnapshot,
    queue: [{ ...baseTruncatedTrack, durationMs: 3_000_000 }, FIXTURE_TRACKS[1]!],
    positionMs: 2_365_000,
  };
  expect(isOutroPosition(exactEndSnapshot)).toBe(false);

  // 2. Sample with sufficient outro tail (durationMs = 3_030_000)
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[1]!.id);
  const tailTrack = { ...baseTruncatedTrack, durationMs: 3_030_000 };
  mock.snapshot = { ...baseSnapshot, queue: [tailTrack, FIXTURE_TRACKS[1]!], positionMs: 2_365_000 };
  const { result, rerender } = renderHook(() => useOutroPreview());
  expect(result.current.active).toBe(false);

  mock.snapshot = { ...mock.snapshot, positionMs: 3_002_999 };
  rerender();
  expect(result.current.active).toBe(false);

  mock.snapshot = { ...mock.snapshot, positionMs: 3_003_000 };
  rerender();
  await act(async () => {});
  expect(result.current.active).toBe(true);

  mock.snapshot = { ...mock.snapshot, positionMs: 3_002_000 };
  rerender();
  expect(result.current.active).toBe(false);
});

it.each([
  { label: "untruncated Bilibili", trackId: "bilibili:video:BV1he4y1K7nu:929778564", source: "bilibiliSubtitle" as const, line: { atMs: 140_000, endMs: 150_000, original: "B站末句" }, triggerMs: 153_000 },
  { label: "QQ", trackId: "0039MnYb0qxYhV", source: undefined, line: { atMs: 216_000, original: "QQ末句" }, triggerMs: 219_000 },
  { label: "NetEase", trackId: "netease:track:186016", source: undefined, line: { atMs: 180_000, original: "网易末句" }, triggerMs: 183_000 },
])("keeps legacy (last.endMs ?? last.atMs) + 3000 outro trigger for $label", ({ trackId, source, line, triggerMs }) => {
  const parsed = parseLyricTimeline({
    generation: 1,
    trackId,
    ...(source ? { source } : {}),
    lines: [line],
  });
  const track = {
    ...FIXTURE_TRACKS[0]!,
    id: parsed.trackId,
    durationMs: triggerMs + 10_000,
    ...(parsed.source ? { lyricSource: parsed.source } : {}),
    ...(parsed.timelineEndMs !== undefined ? { lyricTimelineEndMs: parsed.timelineEndMs } : {}),
    lyrics: parsed.lines,
  };
  expect(isOutroPosition({ ...baseSnapshot, queue: [track], positionMs: triggerMs - 1 })).toBe(false);
  expect(isOutroPosition({ ...baseSnapshot, queue: [track], positionMs: triggerMs })).toBe(true);
});
