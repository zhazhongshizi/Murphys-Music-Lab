import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPlaybackTransport } from "../backend/playbackTransport";
import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { RemoteApp } from "./RemoteApp";
import { disconnectRemote } from "./remoteTransport";

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("Remote Bilibili subtitle lyrics parity", () => {
  afterEach(() => {
    cleanup();
    disconnectRemote();
    installPlaybackTransport(null);
    resetPlayerFixture();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flows /api/lyrics endMs, source label, gap handling, empty state, and endMs outro through RemoteApp", async () => {
    const biliTrack = {
      providerId: "bilibili",
      id: "bilibili:video:BV1BbKw6XEWq:40065631429",
      title: "AI 字幕测试视频",
      artist: "UP 主",
      album: "",
      durationMs: 40_000,
      video: { title: "AI 字幕测试视频", partTitle: "P1", partNumber: 1 },
    };
    const nextTrack = {
      providerId: "bilibili",
      id: "bilibili:video:BV1fK4y1t7hj:196018899",
      title: "无字幕视频",
      artist: "UP 主",
      album: "",
      durationMs: 20_000,
      video: { title: "无字幕视频", partTitle: "P1", partNumber: 1 },
    };
    const currentSummary = (track: typeof biliTrack) => ({
      providerId: track.providerId,
      id: track.id,
      title: track.title,
      artist: track.artist,
    });
    let currentSession = {
      requestedQuality: "320k" as const,
      mode: "sequence" as const,
      queue: { generation: 1, selectedIndex: 0, items: [biliTrack, nextTrack] },
      player: {
        state: "playing" as const,
        generation: 1,
        currentTrack: currentSummary(biliTrack),
        positionMs: 1_500,
        durationMs: 40_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    };
    let currentLyrics: unknown = {
      generation: 1,
      trackId: biliTrack.id,
      source: "bilibiliAiSubtitle",
      lines: [
        { atMs: 1_000, endMs: 2_000, original: "远端第一句" },
        { atMs: 10_000, endMs: 20_000, original: "远端长末句" },
      ],
    };

    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/state")) {
        return Promise.resolve(new Response(JSON.stringify(currentSession)));
      }
      if (url.startsWith("/api/lyrics")) {
        return Promise.resolve(new Response(JSON.stringify(currentLyrics)));
      }
      if (url.startsWith("/api/preview")) {
        return Promise.resolve(new Response(JSON.stringify(nextTrack.id)));
      }
      if (url.startsWith("/api/library")) {
        return Promise.resolve(new Response(JSON.stringify({ state: "unavailable" })));
      }
      return Promise.resolve(new Response("null"));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<RemoteApp />);
    fireEvent.change(screen.getByLabelText("连接码"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "连接电脑" }));

    expect(await screen.findByRole("heading", { name: "AI 字幕测试视频" })).toBeInTheDocument();
    expect(await screen.findByText("正在播放 · 歌词 · B站 AI 字幕")).toBeInTheDocument();
    const firstLine = screen.getByRole("option", { name: /远端第一句/ });
    expect(firstLine).toHaveClass("lyrics-scroll__line--active");

    // Enter interlude gap [2_000, 10_000) -> past line stays dimmed, no active highlight
    await act(async () => {
      currentSession = {
        ...currentSession,
        player: { ...currentSession.player, positionMs: 5_000 },
      };
      await playerActions.hydrateNativeSession();
    });
    expect(firstLine).toHaveClass("lyrics-scroll__line--past");
    expect(firstLine).not.toHaveClass("lyrics-scroll__line--active");

    // Inside long final cue at 15_000 (past atMs + 3000 = 13_000, before endMs + 3000 = 23_000): outro NOT active
    await act(async () => {
      currentSession = {
        ...currentSession,
        player: { ...currentSession.player, positionMs: 15_000 },
      };
      await playerActions.hydrateNativeSession();
    });
    expect(screen.queryByRole("heading", { name: "即将播放" })).not.toBeInTheDocument();

    // After last.endMs + 3000 = 23_000 -> outro activates on Remote
    await act(async () => {
      currentSession = {
        ...currentSession,
        player: { ...currentSession.player, positionMs: 23_000 },
      };
      await playerActions.hydrateNativeSession();
    });
    expect(await screen.findByRole("heading", { name: "即将播放" })).toBeInTheDocument();

    // Switch to confirmed no-subtitle track -> empty state without throwing
    currentLyrics = { generation: 2, trackId: nextTrack.id, lines: [] };
    await act(async () => {
      currentSession = {
        ...currentSession,
        queue: { generation: 1, selectedIndex: 1, items: [biliTrack, nextTrack] },
        player: {
          ...currentSession.player,
          generation: 2,
          currentTrack: currentSummary(nextTrack),
          positionMs: 1_000,
          durationMs: 20_000,
        },
      };
      await playerActions.hydrateNativeSession();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "无字幕视频" })).toBeInTheDocument());
    expect(screen.getByText("暂无歌词")).toBeInTheDocument();
  });

  it("flows truncated /api/lyrics timelineEndMs through RemoteApp and delays outro until timelineEndMs + 3000 with reverse-seek exit", async () => {
    const truncatedTrack = {
      providerId: "bilibili",
      id: "bilibili:video:BV17x411w7KC:127",
      title: "50分钟截断字幕",
      artist: "UP 主",
      album: "",
      durationMs: 3_000_000,
      video: { title: "50分钟截断字幕", partTitle: "P1", partNumber: 1 },
    };
    const nextTrack = {
      providerId: "bilibili",
      id: "bilibili:video:BV17x411w7KC:128",
      title: "下一P视频",
      artist: "UP 主",
      album: "",
      durationMs: 60_000,
      video: { title: "下一P视频", partTitle: "P2", partNumber: 2 },
    };
    const currentSummary = (track: typeof truncatedTrack) => ({
      providerId: track.providerId,
      id: track.id,
      title: track.title,
      artist: track.artist,
    });
    let currentSession = {
      requestedQuality: "320k" as const,
      mode: "sequence" as const,
      queue: { generation: 1, selectedIndex: 0, items: [truncatedTrack, nextTrack] },
      player: {
        state: "playing" as const,
        generation: 1,
        currentTrack: currentSummary(truncatedTrack),
        positionMs: 2_365_000,
        durationMs: 3_000_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    };
    let currentLyrics = {
      generation: 1,
      trackId: truncatedTrack.id,
      source: "bilibiliSubtitle",
      timelineEndMs: 3_000_000,
      lines: [
        { atMs: 0, endMs: 1_000, original: "远端截断第一句" },
        { atMs: 2_361_000, endMs: 2_362_000, original: "远端截断末句" },
      ],
    };

    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/state")) return Promise.resolve(new Response(JSON.stringify(currentSession)));
      if (url.startsWith("/api/lyrics")) return Promise.resolve(new Response(JSON.stringify(currentLyrics)));
      if (url.startsWith("/api/preview")) return Promise.resolve(new Response(JSON.stringify(nextTrack.id)));
      if (url.startsWith("/api/library")) return Promise.resolve(new Response(JSON.stringify({ state: "unavailable" })));
      return Promise.resolve(new Response("null"));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<RemoteApp />);
    fireEvent.change(screen.getByLabelText("连接码"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "连接电脑" }));

    expect(await screen.findByText("远端截断末句")).toBeInTheDocument();
    // 1. 50-minute sample at 2_365_000 ms MUST NOT trigger outro
    expect(screen.queryByRole("heading", { name: "即将播放" })).not.toBeInTheDocument();

    // 2. Sample with outro tail (durationMs = 3_030_000)
    const tailTrack = { ...truncatedTrack, durationMs: 3_030_000 };
    currentLyrics = { ...currentLyrics, generation: 2 };
    await act(async () => {
      currentSession = {
        ...currentSession,
        queue: { generation: 2, selectedIndex: 0, items: [tailTrack, nextTrack] },
        player: { ...currentSession.player, generation: 2, currentTrack: currentSummary(tailTrack), positionMs: 2_365_000, durationMs: 3_030_000 },
      };
      await playerActions.hydrateNativeSession();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("generation=2"), expect.anything()));
    expect(screen.queryByRole("heading", { name: "即将播放" })).not.toBeInTheDocument();

    await act(async () => {
      currentSession = { ...currentSession, player: { ...currentSession.player, positionMs: 3_002_999 } };
      await playerActions.hydrateNativeSession();
    });
    expect(screen.queryByRole("heading", { name: "即将播放" })).not.toBeInTheDocument();

    await act(async () => {
      currentSession = { ...currentSession, player: { ...currentSession.player, positionMs: 3_003_000 } };
      await playerActions.hydrateNativeSession();
    });
    expect(await screen.findByRole("heading", { name: "即将播放" })).toBeInTheDocument();

    // Reverse seek exits outro cleanly
    await act(async () => {
      currentSession = { ...currentSession, player: { ...currentSession.player, positionMs: 3_002_000 } };
      await playerActions.hydrateNativeSession();
    });
    expect(screen.queryByRole("heading", { name: "即将播放" })).not.toBeInTheDocument();
  });
});
