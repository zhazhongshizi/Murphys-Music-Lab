import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invokePlayback } from "../../backend/playbackTransport";
import MediaCacheSettings from "./MediaCacheSettings";

vi.mock("../../backend/playbackTransport", () => ({
  hasPlaybackTransport: () => true,
  isRemotePlayback: () => false,
  invokePlayback: vi.fn(),
}));

it("turns off next-track preloading while retaining smoothing and the cache limit", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const current = { enabled: true, preloadEnabled: true, available: true, usedBytes: 0, limitMib: 128 };
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
