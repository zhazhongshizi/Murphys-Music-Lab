import { beforeEach, expect, it, vi } from "vitest";
import { playHistoryEntry } from "./historyPlayback";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), play: vi.fn(), hydrate: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueueEnqueue: mocks.enqueue, nativeQueuePlay: mocks.play }));
vi.mock("./playerStore", () => ({ playerActions: { hydrateNative: mocks.hydrate } }));
const entry = { id: "history-song", title: "History", artist: "Artist", playedAtUnixMs: 1000 };
beforeEach(() => { mocks.enqueue.mockReset(); mocks.play.mockReset(); mocks.hydrate.mockReset().mockResolvedValue(undefined); });

it("plays the ID's actual queue position and hydrates the resulting native state", async () => {
  const queue = { generation: 1, selectedIndex: 1, items: [{ id: "other-song" }, { id: entry.id, album: "existing album" }] };
  mocks.enqueue.mockResolvedValue(queue);
  const result = { queue, playback: { player: { generation: 2 }, quality: "320k" } };
  mocks.play.mockResolvedValue(result);
  await playHistoryEntry(entry);
  expect(mocks.play).toHaveBeenCalledWith(1);
  expect(mocks.hydrate).toHaveBeenLastCalledWith(queue, result.playback.player, "320k");
});

it("replays Bilibili history with source, durable part metadata and actual AAC bitrate", async () => {
  const video = { title: "视频原题", partTitle: "第二 P", partNumber: 2 };
  const track = { providerId: "bilibili" as const, id: "bilibili:video:BV17x411w7KC:124", title: "第二 P", artist: "UP", album: "视频原题", durationMs: 3800000, video };
  const queue = { generation: 3, selectedIndex: 0, items: [track] };
  const playback = { quality: "aac", bitrate: 73451, player: { generation: 4 } };
  mocks.enqueue.mockResolvedValue(queue); mocks.play.mockResolvedValue({ queue, playback });
  await playHistoryEntry({ ...track, playedAtUnixMs: 1000 });
  expect(mocks.enqueue).toHaveBeenCalledWith(track);
  expect(mocks.hydrate).toHaveBeenLastCalledWith(queue, playback.player, "aac", 73451);
});

it("does not play another song when the requested history ID was not enqueued", async () => {
  mocks.enqueue.mockResolvedValue({ items: [{ id: "other-song" }] });
  await expect(playHistoryEntry(entry)).rejects.toThrow();
  expect(mocks.play).not.toHaveBeenCalled();
});

it("keeps the history cover, album and media identifier when restoring a song", async () => {
  mocks.enqueue.mockResolvedValue({ items: [{ id: entry.id }] });
  mocks.play.mockResolvedValue(undefined);
  const metadata = { album: "Saved album", durationMs: 90000, coverCacheKey: "cover_1", mediaMid: "media_1" };
  await playHistoryEntry({ ...entry, ...metadata });
  expect(mocks.enqueue).toHaveBeenCalledWith({ id: entry.id, title: entry.title, artist: entry.artist, ...metadata });
});

it("propagates native source failures for the history page to explain", async () => {
  mocks.enqueue.mockResolvedValue({ items: [{ id: entry.id }] });
  mocks.play.mockRejectedValue(new Error("unavailable"));
  await expect(playHistoryEntry(entry)).rejects.toThrow("unavailable");
});
