import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { playerActions, getCurrentTrack, resetPlayerFixture } from "./playerStore";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  invoke.mockReset(); resetPlayerFixture(); beginPlaybackSession();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); resetPlayerFixture(); });

it("does not reinterpret a stale desktop selection after a core queue reorder", async () => {
  const a = { id: "a", title: "A", artist: "artist", album: "album", durationMs: 10000 };
  const b = { ...a, id: "b", title: "B" };
  const player = { state: "playing" as const, generation: 1, positionMs: 0, durationMs: 10000, volume: 1, muted: false, currentTrack: { id: "a", title: "A", artist: "artist" }, failure: null };
  await playerActions.hydrateNative({ generation: 1, selectedIndex: 0, items: [a, b] }, player);
  const coreQueue = { generation: 2, selectedIndex: 1, items: [b, a] };
  const loaded: string[] = [];
  invoke.mockImplementation(async (command: string, args) => {
    if (command !== "queue_play") throw new Error(command);
    if (args.queueGeneration !== coreQueue.generation) return null;
    const selected = coreQueue.items.find(item => item.id === args.trackId)!;
    loaded.push(selected.id);
    return { requestedQuality: "128k", queue: coreQueue, playback: { quality: "128k", expiresInSeconds: 0, player: { ...player, generation: 2, currentTrack: { id: selected.id, title: selected.title, artist: selected.artist } } } };
  });
  expect(await playerActions.playTrack("b")).toBe(false);
  expect(invoke).toHaveBeenCalledWith("queue_play", { trackId: "b", queueGeneration: 1, preferredQuality: "auto" });
  expect(loaded).toEqual([]);
  await playerActions.hydrateNative(coreQueue, player);
  expect(await playerActions.playTrack("b")).toBe(true);
  expect(loaded).toEqual(["b"]);
  expect(getCurrentTrack()?.id).toBe("b");
});
