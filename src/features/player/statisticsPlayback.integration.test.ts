import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { actOnStatisticsTrack } from "./statisticsPlayback";
import { resetPlayerFixture } from "./playerStore";
import { beginPlaybackSession, installPlaybackTransport } from "../../backend/playbackTransport";
import { invalidateProviderSession } from "../../backend/providerSessions";
import type { ProviderTrack } from "../../contracts/providers";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const song: ProviderTrack = { providerId: "netease", id: "netease:track:1", title: "Fresh song", artist: "Artist", creatorKind: "artist", album: "Album", durationMs: 90000, availability: "unknown" };
const part: ProviderTrack = { ...song, providerId: "bilibili", id: "bilibili:video:BV17x411w7KC:124", creatorKind: "uploader", coverCacheKey: "bili_BV17x411w7KC", video: { title: "Video", partTitle: "Part 2", partNumber: 2 } };
const player = { state: "idle", generation: 1, positionMs: 0, durationMs: null, volume: 1, muted: false, currentTrack: null, failure: null };
beforeEach(() => {
  invoke.mockReset(); resetPlayerFixture(); installPlaybackTransport(null); beginPlaybackSession();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); resetPlayerFixture(); });

it.each(["play", "next", "enqueue"] as const)("restores missing NetEase metadata through real adapters for %s", async action => {
  const queued = { providerId: song.providerId, id: song.id, title: song.title, artist: song.artist, album: song.album, durationMs: song.durationMs };
  const queue = { generation: 2, selectedIndex: 0, items: [queued] };
  invoke.mockImplementation(async (command: string) => {
    if (command === "queue_snapshot") return { generation: 1, selectedIndex: null, items: [] };
    if (command === "provider_read") return song;
    if (command === "queue_enqueue_many" || command === "queue_enqueue_next") return queue;
    if (command === "player_snapshot") return player;
    if (command === "queue_play") return { requestedQuality: "128k", queue, playback: { quality: "128k", expiresInSeconds: 0, player: { ...player, state: "playing", generation: 2, currentTrack: { providerId: song.providerId, id: song.id, title: song.title, artist: song.artist } } } };
    throw new Error(command);
  });
  await actOnStatisticsTrack({ ...song, title: "Old title" }, action);
  expect(invoke).toHaveBeenCalledWith("provider_read", { providerId: "netease", method: "song.detail", params: { songId: song.id } });
  expect(invoke).toHaveBeenCalledWith(action === "next" ? "queue_enqueue_next" : "queue_enqueue_many", action === "next" ? { item: queued } : { items: [queued] });
  if (action === "play") expect(invoke).toHaveBeenCalledWith("queue_play", { trackId: song.id, queueGeneration: 2, preferredQuality: "auto" });
  else expect(invoke.mock.calls.some(([command]) => command === "queue_play")).toBe(false);
});

it("finds the exact Bilibili CID on a later page and retains video and cover metadata", async () => {
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "queue_snapshot") return { generation: 1, selectedIndex: null, items: [] };
    if (command === "provider_read") return { page: args.params.page, hasMore: args.params.page === 1, total: 101, items: [args.params.page === 1 ? { ...part, id: "bilibili:video:BV17x411w7KC:123" } : part] };
    if (command === "queue_enqueue_many") return { generation: 2, selectedIndex: 0, items: args.items };
    if (command === "player_snapshot") return player;
    throw new Error(command);
  });
  await actOnStatisticsTrack(part, "enqueue");
  expect(invoke).toHaveBeenCalledWith("provider_read", { providerId: "bilibili", method: "video.parts", params: { bvid: "BV17x411w7KC", page: 2, pageSize: 100 } });
  expect(invoke).toHaveBeenCalledWith("queue_enqueue_many", { items: [{ providerId: "bilibili", id: part.id, title: part.title, artist: part.artist, album: part.album, durationMs: part.durationMs, video: part.video, coverCacheKey: part.coverCacheKey }] });
});

it.each(["missing", "unavailable", "account", "connection"] as const)("does not enqueue stale or unavailable metadata (%s)", async scenario => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "queue_snapshot") return { generation: 1, selectedIndex: null, items: [] };
    if (command === "provider_read") {
      if (scenario === "account") invalidateProviderSession("bilibili");
      if (scenario === "connection") beginPlaybackSession();
      return { page: 1, hasMore: false, total: scenario === "missing" ? 0 : 1, items: scenario === "missing" ? [] : [{ ...part, availability: scenario === "unavailable" ? "deleted" : "unknown" }] };
    }
    throw new Error(command);
  });
  await expect(actOnStatisticsTrack(part, "play")).rejects.toThrow();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["queue_snapshot", "provider_read"]);
});
