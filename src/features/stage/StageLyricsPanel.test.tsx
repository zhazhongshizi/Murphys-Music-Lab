import { act, fireEvent, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseLyricTimeline } from "../../backend/lyricsAdapter";
import { getCurrentTrack, playerActions, resetPlayerFixture } from "../player/playerStore";
import { StageLyricsPanel } from "./StageLyricsPanel";

const { previewNext } = vi.hoisted(() => ({ previewNext: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../backend/nativeQueueAdapter")>(),
  nativeQueuePreviewNext: previewNext,
}));

beforeEach(() => resetPlayerFixture());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("opens the current queue, plays a selection, and restores lyrics with Escape", async () => {
  const user = userEvent.setup();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  const trigger = screen.getByRole("button", { name: "展开歌曲列表" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByText("歌词内容")).not.toBeVisible();
  const songs = within(screen.getByRole("list")).getAllByRole("button");
  expect(songs.length).toBeGreaterThan(1);
  await user.click(songs[1]!);
  expect(songs[1]).toHaveAttribute("aria-current", "true");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByText("歌词内容")).toBeVisible();
  expect(trigger).toHaveFocus();
});
it("supports keyboard opening and closing from the edge toggle", async () => {
  const user = userEvent.setup();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "返回歌词" })).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "展开歌曲列表" })).toHaveAttribute("aria-expanded", "false");
});

it("restarts the 20 second idle timeout after interaction", () => {
  vi.useFakeTimers();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  fireEvent.click(screen.getByRole("button", { name: "展开歌曲列表" }));
  act(() => vi.advanceTimersByTime(19_000));
  fireEvent.pointerMove(screen.getByRole("list"));
  act(() => vi.advanceTimersByTime(19_000));
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("pins the queue without lyrics and restores lyrics when available", () => {
  vi.useFakeTimers();
  const view = render(<StageLyricsPanel hasLyrics={false}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(60_000));
  fireEvent.keyDown(screen.getByRole("list"), { key: "Escape" });
  expect(screen.getByRole("list")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "返回歌词" })).not.toBeInTheDocument();
  view.rerender(<StageLyricsPanel hasLyrics><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("immediately follows the active song after next is triggered elsewhere without scrolling outer shell", () => {
  let shellEl: HTMLDivElement | null = null;
  const scroll = vi.fn(() => {
    if (shellEl) shellEl.scrollTop = 140;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const view = render(<div className="app-shell"><StageLyricsPanel><p>歌词内容</p></StageLyricsPanel></div>);
  shellEl = view.container.querySelector(".app-shell");
  fireEvent.click(screen.getByRole("button", { name: "展开歌曲列表" }));
  scroll.mockClear();
  act(() => playerActions.next());
  const songs = within(screen.getByRole("list")).getAllByRole("button");
  expect(songs[1]).toHaveAttribute("aria-current", "true");
  expect(songs[0]).not.toHaveAttribute("aria-current");
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(shellEl?.scrollTop).toBe(0);
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("opens after the last lyric plus 3 seconds, ignores idle timeout, and closes on next", () => {
  vi.useFakeTimers();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(218_999); });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.seek(219_000));
  expect(screen.getByRole("heading", { name: "即将播放" })).toBeInTheDocument();
  expect(within(screen.getByRole("list")).getAllByRole("button")[1]).toHaveAttribute("data-up-next", "true");
  act(() => vi.advanceTimersByTime(25_000));
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => playerActions.next());
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("does not open while paused and cancels on backward seek", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => playerActions.seek(219_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.toggle());
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => playerActions.seek(100_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("keeps an explicitly dismissed outro closed for the current playback", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(219_000); });
  fireEvent.click(screen.getByRole("button", { name: "返回歌词" }));
  act(() => playerActions.seek(225_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("labels repeat-one and suppresses a nonexistent next song at queue end", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.cycleMode(); playerActions.cycleMode(); playerActions.toggle(); playerActions.seek(219_000); });
  expect(screen.getByRole("heading", { name: "即将重播" })).toBeInTheDocument();
  cleanup();
  resetPlayerFixture();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => {
    playerActions.next(); playerActions.next(); playerActions.next(); playerActions.next();
    playerActions.toggle(); playerActions.seek(getCurrentTrack()!.lyrics.at(-1)!.atMs + 3000);
  });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("keeps settings above the outro and pinned queue until explicitly closed", () => {
  vi.useFakeTimers();
  const settings = <section aria-label="设置">设置内容</section>;
  const view = render(<StageLyricsPanel settings={settings}><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(219_000); });
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.next());
  view.rerender(<StageLyricsPanel hasLyrics={false} settings={settings}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  view.rerender(<StageLyricsPanel hasLyrics={false}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("list")).toBeInTheDocument();
});

it("keeps lyrics panel visible on Bilibili subtitle error and allows closing a manually opened queue with Escape", async () => {
  const user = userEvent.setup();
  const biliTrack = { id: "bilibili:video:BV17x411w7KC:125", title: "B站测试", artist: "UP", album: "", durationMs: 60_000 };
  playerActions.applyAuthoritativeSession({
    requestedQuality: "320k",
    mode: "sequence",
    queue: { generation: 1, selectedIndex: 0, items: [biliTrack] },
    player: {
      state: "playing",
      generation: 1,
      currentTrack: biliTrack,
      positionMs: 1_000,
      durationMs: 60_000,
      volume: 0.7,
      muted: false,
      failure: null,
    },
  });
  playerActions.failTimedLyrics(biliTrack.id, 1);

  render(<StageLyricsPanel hasLyrics={false}><p>字幕加载失败</p></StageLyricsPanel>);
  expect(screen.getByText("字幕加载失败")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "展开歌曲列表" }));
  expect(screen.getByRole("list")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByText("字幕加载失败")).toBeVisible();
});

it("suppresses premature outro on truncated Bilibili timelines, triggers at timelineEndMs + 3000, and exits on reverse seek", async () => {
  const biliTrack = { id: "bilibili:video:BV17x411w7KC:127", title: "50分钟字幕视频", artist: "UP", album: "", durationMs: 3_000_000 };
  const nextTrack = { id: "bilibili:video:BV17x411w7KC:128", title: "下一P", artist: "UP", album: "", durationMs: 60_000 };
  previewNext.mockResolvedValue(nextTrack.id);
  const parsed = parseLyricTimeline({
    generation: 1,
    trackId: biliTrack.id,
    source: "bilibiliSubtitle",
    timelineEndMs: 3_000_000,
    lines: [
      { atMs: 0, endMs: 1_000, original: "第一句" },
      { atMs: 2_361_000, endMs: 2_362_000, original: "截断末句" },
    ],
  });

  // 1. 50-minute sample (durationMs = 3_000_000) at 2_365_000 ms MUST NOT trigger outro
  playerActions.applyAuthoritativeSession({
    requestedQuality: "320k",
    mode: "sequence",
    queue: { generation: 1, selectedIndex: 0, items: [biliTrack, nextTrack] },
    player: {
      state: "playing",
      generation: 1,
      currentTrack: biliTrack,
      positionMs: 2_365_000,
      durationMs: 3_000_000,
      volume: 0.7,
      muted: false,
      failure: null,
    },
  });
  act(() => {
    playerActions.applyTimedLyrics(parsed.trackId, parsed.generation, parsed.lines, parsed.source, parsed.timelineEndMs);
  });

  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();

  // 2. Sample with outro tail (durationMs = 3_030_000)
  const tailTrack = { ...biliTrack, durationMs: 3_030_000 };
  act(() => {
    playerActions.applyAuthoritativeSession({
      requestedQuality: "320k",
      mode: "sequence",
      queue: { generation: 2, selectedIndex: 0, items: [tailTrack, nextTrack] },
      player: {
        state: "playing",
        generation: 2,
        currentTrack: tailTrack,
        positionMs: 2_365_000,
        durationMs: 3_030_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    });
    playerActions.applyTimedLyrics(parsed.trackId, 2, parsed.lines, parsed.source, parsed.timelineEndMs);
  });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();

  act(() => {
    playerActions.applyAuthoritativeSession({
      requestedQuality: "320k",
      mode: "sequence",
      queue: { generation: 2, selectedIndex: 0, items: [tailTrack, nextTrack] },
      player: {
        state: "playing",
        generation: 2,
        currentTrack: tailTrack,
        positionMs: 3_002_999,
        durationMs: 3_030_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    });
  });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();

  act(() => {
    playerActions.applyAuthoritativeSession({
      requestedQuality: "320k",
      mode: "sequence",
      queue: { generation: 2, selectedIndex: 0, items: [tailTrack, nextTrack] },
      player: {
        state: "playing",
        generation: 2,
        currentTrack: tailTrack,
        positionMs: 3_003_000,
        durationMs: 3_030_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    });
  });
  expect(await screen.findByRole("heading", { name: "即将播放" })).toBeInTheDocument();
  expect(within(screen.getByRole("list")).getAllByRole("button")[1]).toHaveAttribute("data-up-next", "true");

  // Reverse seek exits outro cleanly
  act(() => {
    playerActions.applyAuthoritativeSession({
      requestedQuality: "320k",
      mode: "sequence",
      queue: { generation: 2, selectedIndex: 0, items: [tailTrack, nextTrack] },
      player: {
        state: "playing",
        generation: 2,
        currentTrack: tailTrack,
        positionMs: 3_002_000,
        durationMs: 3_030_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    });
  });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
