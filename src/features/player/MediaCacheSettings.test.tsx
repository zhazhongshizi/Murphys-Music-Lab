import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invokePlayback } from "../../backend/playbackTransport";
import MediaCacheSettings from "./MediaCacheSettings";

vi.mock("../../backend/playbackTransport", () => ({
  hasPlaybackTransport: () => true,
  isRemotePlayback: () => false,
  invokePlayback: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(invokePlayback).mockReset();
});

const current = {
  enabled: true,
  preloadEnabled: true,
  available: true,
  usedBytes: 0,
  limitMib: 128,
  gameModeEnabled: false,
  gameModeLimitKbPerSec: 64,
};

it("turns off next-track preloading while retaining smoothing and the cache limit", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  vi.mocked(invokePlayback).mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, preloadEnabled: false });
  render(<MediaCacheSettings />);
  fireEvent.click(screen.getByRole("menuitem", { name: "平滑播放与缓存" }));
  const preload = await screen.findByRole("checkbox", { name: "预加载下一首歌曲和封面" });
  fireEvent.click(preload);
  expect(invokePlayback).toHaveBeenLastCalledWith("media_cache_control", {
    request: { action: "configure", enabled: true, limitMib: 128, preloadEnabled: false },
  });
  await waitFor(() => expect((preload as HTMLInputElement).checked).toBe(false));
  expect((screen.getByRole("checkbox", { name: "启用平滑播放与在线歌曲缓存" }) as HTMLInputElement).checked).toBe(true);
});

it("configures game mode through the Rhine entry even with song caching disabled", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const uncached = { ...current, enabled: false };
  const gameMode = { ...uncached, gameModeEnabled: true };
  const custom = { ...gameMode, gameModeLimitKbPerSec: 96 };
  vi.mocked(invokePlayback).mockResolvedValueOnce(uncached)
    .mockResolvedValueOnce(gameMode).mockResolvedValueOnce(custom)
    .mockResolvedValueOnce({ ...custom, gameModeEnabled: false });
  render(<MediaCacheSettings presentation="rhine" />);
  fireEvent.click(screen.getByRole("button", { name: "平滑播放与缓存" }));
  const enabled = await screen.findByRole<HTMLInputElement>("checkbox", { name: "启用游戏模式" });
  const rate = screen.getByRole<HTMLInputElement>("spinbutton", { name: "总限速（KB/s）" });
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "保存限速" });
  expect(enabled.checked).toBe(false);
  expect(rate.value).toBe("64");
  fireEvent.click(enabled);
  expect(invokePlayback).toHaveBeenLastCalledWith("media_cache_control", {
    request: { action: "configureGameMode", enabled: true, limitKbPerSec: 64 },
  });
  await waitFor(() => expect(enabled.checked).toBe(true));

  fireEvent.change(rate, { target: { value: "15" } });
  expect(save.disabled).toBe(true);
  fireEvent.change(rate, { target: { value: "96" } });
  fireEvent.click(save);
  expect(invokePlayback).toHaveBeenLastCalledWith("media_cache_control", {
    request: { action: "configureGameMode", enabled: true, limitKbPerSec: 96 },
  });
  await waitFor(() => expect(save.disabled).toBe(true));
  await waitFor(() => expect(enabled.closest("fieldset")?.disabled).toBe(false));

  fireEvent.click(enabled);
  expect(invokePlayback).toHaveBeenLastCalledWith("media_cache_control", {
    request: { action: "configureGameMode", enabled: false, limitKbPerSec: 96 },
  });
  await waitFor(() => expect(enabled.checked).toBe(false));
  expect(rate.value).toBe("96");
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "启用平滑播放与在线歌曲缓存" }).checked).toBe(false);
});
