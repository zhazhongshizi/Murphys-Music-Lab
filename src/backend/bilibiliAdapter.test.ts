import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeProviderCheck, nativeProviderEnqueueVideo, nativeProviderLogin, parseProviderContainer, parseProviderVideo, providerTrackToQueueTrack } from "./providersAdapter";
import { parsePlaybackSessionSnapshot, parseQueueTrack } from "./nativeQueueAdapter";
import { parsePlaybackLoadResult } from "./nativePlayerAdapter";
import { actualQuality } from "../features/player/nativeTrack";
import { connectRemote, disconnectRemote } from "../remote/remoteTransport";
import { playerActions } from "../features/player/playerStore";
import { invalidateProviderSession } from "./providerSessions";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const video = { providerId: "bilibili", bvid: "BV17x411w7KC", aid: "170001", title: "视频原题", uploader: "UP", durationMs: 7500000, availability: "unknown" } as const;
const parts = [1, 2].map(partNumber => ({ providerId: "bilibili" as const, id: `bilibili:video:${video.bvid}:${122 + partNumber}`, title: `P${partNumber}原题`, artist: "UP", creatorKind: "uploader" as const, album: video.title, durationMs: 3700000, availability: "unknown" as const, video: { title: video.title, partTitle: `P${partNumber}原题`, partNumber } }));
const account = { providerId: "bilibili", id: "42", displayName: "合成账号" };
const status = { providerId: "bilibili", state: "ready", persistence: "saved", account, capabilities: { loginMethods: ["qr"], searchKinds: ["videos"], libraryKinds: ["created", "favorite"], writeActions: [], lyrics: false, qualities: ["auto", "aac"] } };
const player = { state: "playing", generation: 1, positionMs: 12, durationMs: 3700000, volume: .5, muted: false, currentTrack: { providerId: "bilibili", id: parts[0]!.id, title: parts[0]!.title, artist: "UP" }, failure: null };
beforeEach(() => { invoke.mockReset(); Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }); });
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); disconnectRemote(); vi.unstubAllGlobals(); });
it("preserves part metadata and source, rejects browse summaries, missing metadata and mismatches", () => {
  const tracks = parts.map(providerTrackToQueueTrack);
  expect(tracks[1]!.video?.partNumber).toBe(2); expect(tracks[0]!.id).not.toBe(tracks[1]!.id);
  expect(parseQueueTrack(tracks[0])).toEqual(tracks[0]);
  expect(() => parseQueueTrack({ ...tracks[0], video: undefined })).toThrow();
  expect(() => parseQueueTrack({ ...tracks[0], providerId: "netease" })).toThrow();
  expect(() => parseQueueTrack({ ...tracks[0], video: { ...tracks[0]!.video, partNumber: 0 } })).toThrow();
  expect(() => providerTrackToQueueTrack(video as never)).toThrow();
  expect(() => parseProviderVideo({ ...video, url: "https://secret.invalid" })).toThrow();
  expect(parseProviderVideo(video)).toEqual(video);
});
it.each(["created", "collected"] as const)("parses multiline %s descriptions without relaxing single-line titles", ownership => {
  const base = { providerId: "bilibili", id: "bilibili:favorite:7", kind: "favoriteFolder", ownership, owner: { providerId: "bilibili", id: "42" }, title: "收藏夹", description: "", itemCount: 2, allowedActions: [] };
  for (const description of ["first\nsecond", "first\r\nsecond"]) expect(parseProviderContainer({ ...base, description }).description).toBe(description);
  expect(() => parseProviderContainer({ ...base, title: "first\nsecond" })).toThrow();
  expect(() => parseProviderContainer({ ...base, description: "bad\0text" })).toThrow();
  expect(() => parseProviderContainer({ ...base, description: "x".repeat(4097) })).toThrow();
});
it("Bilibili never reaches the legacy QQ like write route", async () => {
  await expect(playerActions.setSongLiked(parts[0]!.id, true)).rejects.toThrow("unsupported_capability");
  expect(invoke).not.toHaveBeenCalled();
});
it("same-account re-login during part reads cannot commit a stale group to the queue", async () => {
  invoke.mockImplementation(async (command, payload) => {
    if (command === "provider_status") return status;
    if (command === "provider_read" && payload.method === "video.resolve") return video;
    if (command === "provider_read" && payload.method === "video.parts") {
      invalidateProviderSession("bilibili"); return { page: 1, total: 2, hasMore: false, items: parts };
    }
    throw new Error("queue mutation must not occur");
  });
  await expect(nativeProviderEnqueueVideo(video.bvid, "all")).rejects.toThrow();
  expect(invoke.mock.calls.some(([command]) => command === "queue_enqueue_many")).toBe(false);
});
it("manual credential checks use a separate controlled command and accept only booleans", async () => {
  invoke.mockResolvedValueOnce(false);
  await expect(nativeProviderCheck("bilibili")).resolves.toBe(false);
  expect(invoke).toHaveBeenLastCalledWith("provider_check", { providerId: "bilibili" });
  invoke.mockResolvedValueOnce({ valid: false, credential: "forbidden" });
  await expect(nativeProviderCheck("bilibili")).rejects.toThrow();
});
it("AAC requires actual bounded bitrate in load/session DTO and displays codec and bitrate", () => {
  const load = { quality: "aac", bitrate: 192000, expiresInSeconds: 0, player };
  expect(parsePlaybackLoadResult(load).bitrate).toBe(192000);
  expect(actualQuality("aac", parts[0]!.id, 192000)).toBe("AAC 192 kbps");
  const snapshot = { actualQuality: "aac", actualBitrate: 64000, requestedQuality: "320k", mode: "sequence", queue: { generation: 1, selectedIndex: 0, items: parts.map(providerTrackToQueueTrack) }, player };
  expect(parsePlaybackSessionSnapshot(snapshot).actualBitrate).toBe(64000);
  for (const bitrate of [0, -1, 100000001, .5, "192000", undefined]) expect(() => parsePlaybackLoadResult({ ...load, bitrate })).toThrow();
  expect(() => parsePlaybackLoadResult({ ...load, headers: {} })).toThrow();
  expect(() => parsePlaybackSessionSnapshot({ ...snapshot, actualBitrate: undefined })).toThrow();
  expect(() => parsePlaybackSessionSnapshot({ ...snapshot, actualQuality: "320k" })).toThrow();
});
it.each(["first", "all", 2] as const)("controlled %s entry resolves parts then atomically enqueues with metadata", async selection => {
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === "provider_status") return status;
    if (command === "provider_read") return payload.method === "video.resolve" ? video : { page: 1, total: 2, hasMore: false, items: parts };
    if (command === "queue_enqueue_many") return { generation: 1, selectedIndex: 0, items: payload.items };
    throw new Error("unexpected command");
  });
  const queue = await nativeProviderEnqueueVideo(video.bvid, selection);
  expect(queue.items.map(x => x.video?.partNumber)).toEqual(selection === "all" ? [1, 2] : selection === "first" ? [1] : [2]);
  const calls = invoke.mock.calls.filter(([command]) => command === "queue_enqueue_many");
  expect(calls).toHaveLength(1); expect(JSON.stringify(calls)).not.toContain("creatorKind");
});
function installLargeVideo(total: number) {
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === "provider_status") return status;
    if (command === "provider_read" && payload.method === "video.resolve") return video;
    if (command === "provider_read" && payload.method === "video.parts") {
      const { page, pageSize } = payload.params as { page: number; pageSize: number };
      const start = (page - 1) * pageSize;
      const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => {
        const partNumber = start + i + 1;
        return { ...parts[0]!, id: `bilibili:video:${video.bvid}:${122 + partNumber}`, video: { title: video.title, partTitle: `P${partNumber}`, partNumber } };
      });
      return { page, total, hasMore: start + items.length < total, items };
    }
    if (command === "queue_enqueue_many") return { generation: 1, selectedIndex: 0, items: payload.items };
    throw new Error("unexpected command");
  });
}
it.each([[1001, 2, 1], [1001, 1001, 11], [10000, 10000, 100]])("video with %i parts enqueues only P%i from page %i", async (total, selection, page) => {
  installLargeVideo(total);
  const queue = await nativeProviderEnqueueVideo(video.bvid, selection);
  expect(queue.items).toHaveLength(1); expect(queue.items[0]!.video?.partNumber).toBe(selection);
  const reads = invoke.mock.calls.filter(([c, p]) => c === "provider_read" && p.method === "video.parts");
  expect(reads).toHaveLength(1); expect(reads[0]![1].params).toEqual({ bvid: video.bvid, page, pageSize: 100 });
});
it("over-capacity group and nonexistent part never mutate the queue", async () => {
  installLargeVideo(1001);
  await expect(nativeProviderEnqueueVideo(video.bvid, "all")).rejects.toThrow();
  await expect(nativeProviderEnqueueVideo(video.bvid, 1002)).rejects.toThrow();
  expect(invoke.mock.calls.some(([c]) => c === "queue_enqueue_many")).toBe(false);
});
it("a full 1000-part group commits once after collecting all pages", async () => {
  installLargeVideo(1000);
  const queue = await nativeProviderEnqueueVideo(video.bvid, "all");
  expect(queue.items).toHaveLength(1000);
  expect(invoke.mock.calls.filter(([c, p]) => c === "provider_read" && p.method === "video.parts")).toHaveLength(10);
  expect(invoke.mock.calls.filter(([c]) => c === "queue_enqueue_many")).toHaveLength(1);
});
it.each([0, -1, 1.5, NaN, Infinity, 10001, "invalid", null])("invalid part selection %s is rejected before requests", async selection => {
  await expect(nativeProviderEnqueueVideo(video.bvid, selection as never)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
it("changed auth and malformed part order cannot enqueue; Bilibili login reaches production command", async () => {
  let checks = 0;
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === "provider_status") return ++checks === 1 ? status : { ...status, account: { ...account, id: "99" } };
    if (command === "provider_read") return payload.method === "video.resolve" ? video : { page: 1, total: 2, hasMore: false, items: parts };
    if (command === "provider_login") return { sessionId: "qr", mimeType: "image/png", imageBase64: "iVBORw0KGgo=", expiresAtMs: 1000, pollAfterMs: 2000 };
    throw new Error("unexpected command");
  });
  await expect(nativeProviderEnqueueVideo(video.bvid, "all")).rejects.toThrow();
  expect(invoke.mock.calls.some(([command]) => command === "queue_enqueue_many")).toBe(false);
  await nativeProviderLogin("bilibili"); expect(invoke).toHaveBeenLastCalledWith("provider_login", { providerId: "bilibili" });
});
it("shared Remote snapshot parses mixed sources, AAC and part metadata", async () => {
  const queue = { generation: 1, selectedIndex: 0, items: [providerTrackToQueueTrack(parts[0]!), { id: "qqmid", title: "QQ", artist: "艺人", album: "", durationMs: 1000 }, { providerId: "netease", id: "netease:track:1", title: "网易", artist: "艺人", album: "", durationMs: 1000 }] };
  const shared = { requestedQuality: "320k", actualQuality: "aac", actualBitrate: 192000, mode: "sequence", queue, player };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(shared))));
  const parsed = await connectRemote("synthetic-code");
  expect(parsed.queue.items[0]!.video?.partTitle).toBe("P1原题"); expect(parsed.actualBitrate).toBe(192000);
});
