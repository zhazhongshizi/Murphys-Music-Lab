import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { TerminalMiniMode } from "../features/terminal/TerminalMiniMode";
import { StrictMode } from "react";
import { App, UI_MODE_STORAGE_KEY } from "./App";

const { bridgeMount, enterMiniMode, restoreNormal } = vi.hoisted(() => ({
  bridgeMount: vi.fn(),
  enterMiniMode: vi.fn(),
  restoreNormal: vi.fn(),
}));

const normalWindowSnapshot = {
  size: { width: 1280, height: 800 },
  position: { x: 120, y: 80 },
  maximized: false,
};

const scrollIntoView = vi.fn();

vi.mock("../backend/windowAdapter", async () => {
  const actual = await vi.importActual<typeof import("../backend/windowAdapter")>("../backend/windowAdapter");
  return {
    ...actual,
    windowEnterMiniMode: enterMiniMode,
    windowRestoreNormal: restoreNormal,
  };
});

vi.mock("../features/player/NativePlayerBridge", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    NativePlayerBridge: () => {
      useEffect(() => {
        bridgeMount();
      }, []);
      return <span data-testid="native-player-bridge" />;
    },
  };
});

describe("React Terminal Mini Mode", () => {
  beforeEach(() => {
    localStorage.removeItem(UI_MODE_STORAGE_KEY);
    resetPlayerFixture();
    bridgeMount.mockReset();
    enterMiniMode.mockReset();
    enterMiniMode.mockResolvedValue({ snapshot: normalWindowSnapshot, applied: true });
    restoreNormal.mockReset();
    restoreNormal.mockResolvedValue(true);
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(UI_MODE_STORAGE_KEY);
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("重启恢复 Mini，返回主模式后下次恢复主模式", async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("terminal");
    first.unmount();

    const second = render(<App />);
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入终端模式" })).not.toBeInTheDocument();
    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "G GUI" }));
    await screen.findByRole("button", { name: "进入终端模式" });
    expect(restoreNormal).toHaveBeenCalledWith(normalWindowSnapshot);
    expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("normal");
    second.unmount();

    render(<App />);
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    expect(enterMiniMode).toHaveBeenCalledTimes(2);
  });

  it("StrictMode 启动恢复只调整一次 Mini 窗口", async () => {
    localStorage.setItem(UI_MODE_STORAGE_KEY, "terminal");
    render(<StrictMode><App /></StrictMode>);
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(1));
  });

  it("未知模式回到主模式", () => {
    localStorage.setItem(UI_MODE_STORAGE_KEY, "unknown-mode");
    render(<App />);
    expect(screen.getByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(enterMiniMode).not.toHaveBeenCalled();
  });

  it("切换 Normal/Terminal 视图且只挂载一次 NativePlayerBridge", async () => {
    let finishRestore: ((restored: boolean) => void) | undefined;
    restoreNormal.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishRestore = resolve;
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    expect(await screen.findByTestId("terminal-mini")).toBeInTheDocument();
    expect(enterMiniMode).toHaveBeenCalledTimes(1);
    expect(bridgeMount).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "G GUI" }));
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入终端模式" })).not.toBeInTheDocument();
    expect(restoreNormal).toHaveBeenCalledWith(normalWindowSnapshot);

    finishRestore?.(true);
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(bridgeMount).toHaveBeenCalledTimes(1);
  });

  it("窗口恢复失败时仍返回 Normal GUI", async () => {
    restoreNormal.mockRejectedValueOnce(new Error("restore failed"));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    await user.click(screen.getByRole("button", { name: "G GUI" }));

    expect(await screen.findByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    expect(bridgeMount).toHaveBeenCalledTimes(1);
  });

  it("把 Terminal 快捷键交给现有 playerActions", async () => {
    const toggle = vi.spyOn(playerActions, "toggle");
    const previous = vi.spyOn(playerActions, "previous");
    const next = vi.spyOn(playerActions, "next");
    const seekBy = vi.spyOn(playerActions, "seekBy");
    const setVolume = vi.spyOn(playerActions, "setVolume");
    const toggleMute = vi.spyOn(playerActions, "toggleMute");
    const cycleMode = vi.spyOn(playerActions, "cycleMode");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "m" });
    fireEvent.keyDown(window, { key: "o" });

    expect(toggle).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(seekBy).toHaveBeenCalledWith(-5_000);
    expect(setVolume).toHaveBeenCalledWith(0.77);
    expect(toggleMute).toHaveBeenCalledOnce();
    expect(cycleMode).toHaveBeenCalledOnce();
  });

  it("保持同一播放快照并支持歌词面板与 G 返回", async () => {
    playerActions.seek(45_000);
    playerActions.toggle();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    expect(screen.getByText("暮色温室")).toBeInTheDocument();
    expect(screen.getByText("00:45")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-vinyl")).toHaveClass("terminal-vinyl--playing");

    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByRole("region", { name: "歌词" })).toBeInTheDocument();
    expect(screen.getByText("唱针落下，森林从纹路里生长")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "g" });
    expect(await screen.findByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
  });

  it("全屏歌词进入与换行时自动把当前歌词平滑居中", async () => {
    playerActions.seek(47_000);
    render(<TerminalMiniMode onExit={() => undefined} />);

    fireEvent.keyDown(window, { key: "l" });
    const current = screen.getByText("唱针落下，森林从纹路里生长").closest("p");
    expect(current).toHaveAttribute("aria-current", "true");
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });

    scrollIntoView.mockClear();
    act(() => playerActions.seek(103_000));
    const next = screen.getByText("把没有寄出的晚风，留在这一面窗").closest("p");
    await waitFor(() => {
      expect(next).toHaveAttribute("aria-current", "true");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });

  it("手动浏览歌词时暂停跟随并在四秒后回到最新歌词", () => {
    vi.useFakeTimers();
    playerActions.seek(47_000);
    render(<TerminalMiniMode onExit={() => undefined} />);

    fireEvent.keyDown(window, { key: "l" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(600));

    fireEvent.scroll(screen.getByRole("region", { name: "歌词" }));
    act(() => playerActions.seek(103_000));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(4_000));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(screen.getByText("把没有寄出的晚风，留在这一面窗").closest("p")).toHaveAttribute("aria-current", "true");
  });

  it("反映暂停状态和队列自然切换后的当前歌曲与进度", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    expect(screen.getByTestId("terminal-vinyl")).not.toHaveClass("terminal-vinyl--playing");
    playerActions.toggle();
    await waitFor(() => {
      expect(screen.getByTestId("terminal-vinyl")).toHaveClass("terminal-vinyl--playing");
    });

    playerActions.next();
    await waitFor(() => {
      expect(screen.getByText("纸月光")).toBeInTheDocument();
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });
  });

  it("使用竖向主控制与次控制分组", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    expect(screen.getByRole("navigation", { name: "主要播放控制" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "次要播放控制" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SPACE PLAY" })).toHaveClass("terminal-key--emphasis");
    expect(screen.getByRole("button", { name: /M MUTE/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /O MODE/ })).toBeInTheDocument();
    const runway = screen.getByTestId("terminal-up-next");
    expect(runway).toHaveTextContent("UP NEXT //");
    expect(runway).toHaveTextContent("02");
    expect(runway).toHaveTextContent("纸月光");
    expect(runway).toHaveTextContent("方格岛");
    expect(runway.querySelector("button")).toBeNull();
    expect(screen.queryByText("SPACE PLAY/PAUSE")).not.toBeInTheDocument();
  });

  it("快速重复点击 MINI 时只保存一次原窗口快照", async () => {
    let finishEnter: ((value: { snapshot: typeof normalWindowSnapshot; applied: boolean }) => void) | undefined;
    enterMiniMode.mockImplementationOnce(() => new Promise((resolve) => {
      finishEnter = resolve;
    }));
    render(<App />);

    const miniButton = screen.getByRole("button", { name: "进入终端模式" });
    fireEvent.click(miniButton);
    fireEvent.click(miniButton);

    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(1));
    finishEnter?.({ snapshot: normalWindowSnapshot, applied: true });
    expect(await screen.findByTestId("terminal-mini")).toBeInTheDocument();
  });

  it("仅保留顶栏唯一的 G GUI 返回按钮并在面板间一致退出", async () => {
    const onExit = vi.fn();
    render(<TerminalMiniMode onExit={onExit} />);

    const assertSingleExitButton = () => {
      const exitButtons = screen.getAllByRole("button", { name: "G GUI" });
      expect(exitButtons).toHaveLength(1);
      expect(exitButtons[0]).toHaveClass("terminal-mini__exit");
      expect(exitButtons[0]).not.toHaveAttribute("title");
    };

    assertSingleExitButton();

    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByRole("region", { name: "歌词" })).toBeInTheDocument();
    assertSingleExitButton();

    fireEvent.keyDown(window, { key: "q" });
    expect(screen.getByRole("region", { name: "播放队列" })).toBeInTheDocument();
    assertSingleExitButton();

    fireEvent.click(screen.getByRole("button", { name: "G GUI" }));
    expect(onExit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "g" });
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("支持进度条指针拖拽实时预览、点击跳转与键盘步进（不触发全局双倍步进）", () => {
    const seek = vi.spyOn(playerActions, "seek");
    const seekBy = vi.spyOn(playerActions, "seekBy");
    render(<TerminalMiniMode onExit={() => undefined} />);

    const slider = screen.getByRole("slider", { name: "播放进度" });
    const duration = Number(slider.getAttribute("aria-valuemax"));
    expect(duration).toBeGreaterThan(30_000);
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 300,
      top: 0,
      bottom: 22,
      width: 200,
      height: 22,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(slider, { button: 0, clientX: 150, pointerId: 1 });
    expect(slider).toHaveClass("is-dragging");
    expect(slider).toHaveAttribute("aria-valuenow", String(Math.round(duration * 0.25)));
    expect(seek).not.toHaveBeenCalled();

    fireEvent.pointerMove(slider, { clientX: 200, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", String(Math.round(duration * 0.5)));
    expect(seek).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider, { clientX: 200, pointerId: 1 });
    expect(slider).not.toHaveClass("is-dragging");
    expect(seek).toHaveBeenCalledWith(Math.round(duration * 0.5));

    seek.mockClear();
    fireEvent.click(slider, { clientX: 250 });
    expect(seek).toHaveBeenCalledWith(Math.round(duration * 0.75));

    seek.mockClear();
    seekBy.mockClear();
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(seek).toHaveBeenLastCalledWith(Math.round(duration * 0.75) + 5_000);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(seek).toHaveBeenLastCalledWith(Math.round(duration * 0.75));
    fireEvent.keyDown(slider, { key: "PageUp" });
    expect(seek).toHaveBeenLastCalledWith(Math.min(duration, Math.round(duration * 0.75) + 15_000));
    fireEvent.keyDown(slider, { key: "PageDown" });
    fireEvent.keyDown(slider, { key: "Home" });
    expect(seek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(seek).toHaveBeenLastCalledWith(duration);
    expect(seekBy).not.toHaveBeenCalled();
  });

  it("支持 12 段音量条拖拽、静音解除与键盘调节（不触发全局快捷键）", () => {
    playerActions.toggleMute();
    const setVolume = vi.spyOn(playerActions, "setVolume");
    const seekBy = vi.spyOn(playerActions, "seekBy");
    render(<TerminalMiniMode onExit={() => undefined} />);

    const slider = screen.getByRole("slider", { name: "音量" });
    expect(slider).toHaveAttribute("aria-valuetext", "已静音");
    expect(screen.getByText("MUTED")).toBeInTheDocument();
    expect(slider.querySelectorAll("i.is-on")).toHaveLength(0);

    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 120,
      top: 0,
      bottom: 20,
      width: 120,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(slider, { button: 0, clientX: 30, pointerId: 2 });
    expect(slider).toHaveAttribute("aria-valuenow", "25");
    expect(slider).toHaveAttribute("aria-valuetext", "25%");
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(slider.querySelectorAll("i.is-on")).toHaveLength(3);
    expect(setVolume).not.toHaveBeenCalled();

    fireEvent.pointerMove(slider, { clientX: 60, pointerId: 2 });
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    expect(slider.querySelectorAll("i.is-on")).toHaveLength(6);

    fireEvent.pointerUp(slider, { clientX: 60, pointerId: 2 });
    expect(setVolume).toHaveBeenCalledWith(0.5);
    expect(screen.queryByText("MUTED")).not.toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();

    setVolume.mockClear();
    seekBy.mockClear();
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenLastCalledWith(0.55);

    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(setVolume).toHaveBeenCalledTimes(2);
    expect(setVolume).toHaveBeenLastCalledWith(0.6);

    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(setVolume).toHaveBeenCalledTimes(3);
    expect(setVolume).toHaveBeenLastCalledWith(0.55);

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(setVolume).toHaveBeenCalledTimes(4);
    expect(setVolume).toHaveBeenLastCalledWith(0.5);

    fireEvent.keyDown(slider, { key: "Home" });
    expect(setVolume).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(slider, { key: "End" });
    expect(setVolume).toHaveBeenLastCalledWith(1);
    expect(seekBy).not.toHaveBeenCalled();
  });

  it("Terminal Mini 在间奏空档显示等待歌词与真正下一句，并在歌词面板保留 is-past 与来源标签", () => {
    const biliTrack = { id: "bilibili:video:BV1zQ4y127rF:389067834", title: "Mini 字幕曲", artist: "UP", album: "", durationMs: 30_000 };
    const sessionAt = (positionMs: number) => ({
      requestedQuality: "320k" as const,
      mode: "sequence" as const,
      queue: { generation: 1, selectedIndex: 0, items: [biliTrack] },
      player: {
        state: "playing" as const,
        generation: 1,
        currentTrack: biliTrack,
        positionMs,
        durationMs: 30_000,
        volume: 0.7,
        muted: false,
        failure: null,
      },
    });
    act(() => {
      playerActions.applyAuthoritativeSession(sessionAt(5_000));
      playerActions.applyTimedLyrics(
        biliTrack.id,
        1,
        [
          { atMs: 1_000, endMs: 2_000, original: "第一句已过" },
          { atMs: 8_000, endMs: 10_000, original: "第二句待播" },
        ],
        "bilibiliSubtitle",
      );
    });
    render(<TerminalMiniMode onExit={() => undefined} />);
    const preview = document.querySelector(".terminal-lyric-preview")!;
    expect(preview.querySelector("p")).toHaveTextContent("等待歌词");
    expect(preview.querySelector("span")).toHaveTextContent("第二句待播");

    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByText("Mini 字幕曲 · B站字幕")).toBeInTheDocument();
    expect(screen.getByText("第一句已过").closest("p")).toHaveClass("is-past");
    expect(screen.getByText("第二句待播").closest("p")).not.toHaveClass("is-past");
  });

  it("Terminal Mini 区分 B站字幕加载失败与确认无字幕，非B站保持 NO LYRICS AVAILABLE", () => {
    const biliTrack = { id: "bilibili:video:BV17x411w7KC:125", title: "Mini 异常字幕", artist: "UP", album: "", durationMs: 30_000 };
    const qqTrack = { id: "0039MnYb0qxYhV", title: "QQ 无歌词", artist: "歌手", album: "", durationMs: 30_000 };
    const setTrack = (track: typeof biliTrack, generation: number) => {
      playerActions.applyAuthoritativeSession({
        requestedQuality: "320k",
        mode: "sequence",
        queue: { generation, selectedIndex: 0, items: [track] },
        player: {
          state: "playing",
          generation,
          currentTrack: track,
          positionMs: 1_000,
          durationMs: 30_000,
          volume: 0.7,
          muted: false,
          failure: null,
        },
      });
    };

    act(() => {
      setTrack(biliTrack, 1);
      playerActions.failTimedLyrics(biliTrack.id, 1);
    });
    render(<TerminalMiniMode onExit={() => undefined} />);

    expect(screen.getByText("字幕加载失败")).toHaveAttribute("data-lyrics-status", "error");
    fireEvent.keyDown(window, { key: "l" });
    const lyricsRegion = screen.getByRole("region", { name: "歌词" });
    expect(lyricsRegion).toHaveAttribute("data-lyrics-status", "error");
    expect(screen.getByText("字幕加载失败")).toHaveAttribute("data-lyrics-status", "error");

    act(() => playerActions.applyTimedLyrics(biliTrack.id, 1, []));
    expect(screen.getByRole("region", { name: "歌词" })).toHaveAttribute("data-lyrics-status", "empty");
    expect(screen.getByText("暂无歌词")).toHaveAttribute("data-lyrics-status", "empty");

    act(() => {
      setTrack(qqTrack, 2);
      playerActions.failTimedLyrics(qqTrack.id, 2);
    });
    expect(screen.getByRole("region", { name: "歌词" })).toHaveAttribute("data-lyrics-status", "error");
    expect(screen.getByText("NO LYRICS AVAILABLE")).toHaveAttribute("data-lyrics-status", "error");
  });
});
