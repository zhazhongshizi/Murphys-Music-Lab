import { afterEach, expect, it, vi } from "vitest";
import { connectRemote, disconnectRemote, invokeRemote, remoteStatus } from "./remoteTransport";
import { installPlaybackTransport } from "../backend/playbackTransport";
import {
  nativeProviderLikes,
  nativeProviderLogin,
  nativeProviderSearchSongs,
  nativeProviderStatus,
  nativeProviderVideoParts,
  nativeProviderWrite,
} from "../backend/providersAdapter";
import constants from "../../contracts/protocol-v2.constants.json";

const state = {
  requestedQuality: "320k", mode: "sequence",
  queue: { generation: 7, selectedIndex: 0, items: [{ id: "songA", title: "A", artist: "Artist", album: "", durationMs: 10000 }] },
  player: { state: "paused", generation: 4, currentTrack: { id: "songA", title: "A", artist: "Artist" }, positionMs: 10, durationMs: 10000, volume: .5, muted: false, failure: null },
};
afterEach(() => { disconnectRemote(); installPlaybackTransport(null); vi.unstubAllGlobals(); });

it("routes entity browsing and separates artist and album cover caches", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  for (const [command, payload] of [
    ["catalog_search_suggestions", { keyword: "test", generation: 1 }],
    ["catalog_recommend_songs", { kind: "radar", page: 2, generation: 1 }],
    ["catalog_recommend_playlists", { page: 2, pageSize: 20, generation: 1 }],
    ["catalog_search_entities", { kind: "albums", keyword: "test", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_album_detail", { albumId: "same-mid" }],
    ["catalog_album_songs", { albumId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_artist_detail", { artistId: "same-mid" }],
    ["catalog_song_artists", { songId: "song-mid-1" }],
    ["catalog_artist_songs", { artistId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_artist_albums", { artistId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
  ] as const) {
    fetcher.mockResolvedValueOnce(new Response("{}"));
    await invokeRemote(command, payload);
    expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library");
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command, ...payload });
  }
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  await invokeRemote("cover_get", { cacheKey: "same-mid", kind: "artist" });
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library-cover?key=same-mid&kind=artist");
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { "content-type": "image/png" } }));
  await invokeRemote("cover_get", { cacheKey: "same-mid" });
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library-cover?key=same-mid&kind=album");
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([3]), { headers: { "content-type": "image/png" } }));
  await invokeRemote("cover_get", {cacheKey:"pl_digest",kind:"playlist"});
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library-cover?key=pl_digest&kind=playlist");
});

it("next insertion sends only a catalog ID and preserves authoritative MV quality and offset", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...state, actualQuality: "qq-mv", lyricOffsetMs: -1500 })));
  vi.stubGlobal("fetch", fetcher);
  const session = await connectRemote("test-code");
  expect(session.actualQuality).toBe("qq-mv");
  expect(session.lyricOffsetMs).toBe(-1500);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state.queue)));
  await invokeRemote("queue_enqueue_next", { item: state.queue.items[0] });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command: "queue_enqueue_next", id: "songA" });
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await invokeRemote("playback_set_mv_lyric_offset", { trackId: "songA", generation: 4, offsetMs: 500 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "mvLyricOffset", id: "songA", generation: 4, offset_ms: 500 });
});

it("enqueues by catalog ID and uses the returned queue generation for immediate play", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  const item = { id: "songB", title: "B", artist: "Artist", album: "", durationMs: 20000 };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...state.queue, generation: 8, items: [...state.queue.items, item] })));
  await invokeRemote("queue_enqueue", { item });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command: "queue_enqueue", id: "songB" });
  fetcher.mockResolvedValueOnce(new Response("null"));
  await invokeRemote("queue_play", { trackId: "songB", queueGeneration: 8 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "songB", queue_generation: 8 });
});

it("saved queue switching updates remote state before the next track command", async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const switched={...state,queue:{generation:12,selectedIndex:0,items:[{id:"savedSong",title:"Saved",artist:"Artist",album:"",durationMs:20_000}]},player:{...state.player,generation:5,state:"idle",currentTrack:null}};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(switched)));
  await invokeRemote("personal_library",{request:{action:"loadQueue",name:"work"}});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({command:"personal_library",request:{action:"loadQueue",name:"work"}});
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{trackId:"savedSong",queueGeneration:12});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"savedSong",queue_generation:12});
});
it("radar start uses the native session once and updates stable IDs for following controls",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const items=Array.from({length:10},(_,index)=>({id:`radar-${index+1}`,title:"Radar",artist:"Artist",album:"",durationMs:180000}));
  const started={...state,queue:{generation:15,selectedIndex:0,items},player:{...state.player,generation:8,state:"playing",currentTrack:{id:items[0]!.id,title:"Radar",artist:"Artist"}}};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(started)));
  expect(await invokeRemote("radar_start")).toEqual(started);
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library");
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({command:"radar_start"});
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{trackId:"radar-10",queueGeneration:15});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"radar-10",queue_generation:15});
});

it("batch enqueue sends stable IDs once and updates the queue used for playback",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const queue={generation:13,selectedIndex:0,items:[...state.queue.items,{id:"batchSong",title:"Batch",artist:"Artist",album:"",durationMs:1000}]};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(queue)));
  await invokeRemote("queue_enqueue_many",{items:[queue.items.at(-1)!]});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({command:"queue_enqueue_many",ids:["batchSong"]});
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{trackId:queue.items.at(-1)!.id,queueGeneration:queue.generation});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"batchSong",queue_generation:13});
});

it("memory tape enqueue updates the stable queue used by immediate playback",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const queue={generation:14,selectedIndex:0,items:[...state.queue.items,{id:"tapeSong",title:"Tape song",artist:"Artist",album:"",durationMs:0}]};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({queue,acceptedIds:["tapeSong"],skippedIds:[]})));
  await invokeRemote("personal_library",{request:{action:"memoryTapeEnqueue",month:"2026-10",ids:["tapeSong"]}});
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{trackId:queue.items.at(-1)!.id,queueGeneration:queue.generation});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"tapeSong",queue_generation:14});
});

it("uses stable queue IDs and player generations for writes", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  fetcher.mockResolvedValue(new Response(JSON.stringify(state.player)));
  await invokeRemote("player_seek", { positionMs: 99 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "seek", position_ms: 99, generation: 4 });
  fetcher.mockResolvedValue(new Response("null"));
  await invokeRemote("queue_play", { trackId: "songA", queueGeneration: 7 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "songA", queue_generation: 7 });
  await expect(invokeRemote("auth_logout")).rejects.toThrow("此操作请在电脑端完成");
});

it("rejects a stale queue target without replacing its identity with the current index", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  const before = fetcher.mock.calls.length;
  await expect(invokeRemote("queue_play", { trackId: "songA", queueGeneration: 6 })).rejects.toThrow("队列已变化");
  await expect(invokeRemote("queue_play", { trackId: "removed", queueGeneration: 7 })).rejects.toThrow("队列已变化");
  expect(fetcher).toHaveBeenCalledTimes(before);
});

it("never replays a failed write, and rejects controls until state recovers", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  fetcher.mockRejectedValue(new TypeError("offline"));
  await expect(invokeRemote("player_play")).rejects.toThrow();
  expect(remoteStatus()).toBe("offline");
  await expect(invokeRemote("player_play")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue(new Response(JSON.stringify(state)));
  await invokeRemote("playback_session_snapshot");
  expect(remoteStatus()).toBe("online");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not hydrate a response whose connection was closed while its body was pending", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) }));
  const connecting = connectRemote("test-code");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  disconnectRemote();
  resolve(state);
  await expect(connecting).rejects.toThrow("连接已变化");
  expect(remoteStatus()).toBe("disconnected");
});

it("routes multi-provider read-only commands with explicit providerId and rejects writes, auth, and legacy cross-source IDs", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");

  const neteaseReady = {
    providerId: "netease",
    capabilities: constants.capabilities.netease,
    state: "ready",
    account: { providerId: "netease", id: "123", displayName: "测试用户" },
    persistence: "saved",
  };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(neteaseReady)));
  expect(await nativeProviderStatus("netease")).toEqual(neteaseReady);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
    command: "provider_status",
    providerId: "netease",
  });

  const songsPage = {
    page: 1,
    hasMore: false,
    total: 1,
    items: [
      {
        providerId: "netease",
        id: "netease:track:1901371647",
        title: "孤勇者",
        artist: "陈奕迅",
        creatorKind: "artist",
        album: "孤勇者",
        durationMs: 256_000,
        availability: "unknown",
      },
    ],
  };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(songsPage)));
  expect(await nativeProviderSearchSongs("netease", "孤勇者", 1, 20)).toEqual(songsPage);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
    command: "provider_read",
    providerId: "netease",
    method: "search.songs",
    params: { keyword: "孤勇者", page: 1, pageSize: 20 },
  });

  const partsPage = {
    page: 1,
    hasMore: false,
    total: 1,
    items: [
      {
        providerId: "bilibili",
        id: "bilibili:video:BV17x411w7KC:124",
        title: "视频原题 / 第二 P 原题",
        artist: "UP 主",
        creatorKind: "uploader",
        album: "",
        durationMs: 95_000,
        availability: "unknown",
        video: { title: "视频原题", partTitle: "第二 P 原题", partNumber: 2 },
      },
    ],
  };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(partsPage)));
  expect(await nativeProviderVideoParts("BV17x411w7KC", 1, 50)).toEqual(partsPage);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
    command: "provider_read",
    providerId: "bilibili",
    method: "video.parts",
    params: { bvid: "BV17x411w7KC", page: 1, pageSize: 50 },
  });

  const callsBeforeRejections = fetcher.mock.calls.length;

  // Reject provider login/auth/write commands on Remote without network calls.
  await expect(nativeProviderLogin("netease")).rejects.toMatchObject({
    upstreamCode: "unsupported_capability",
  });
  await expect(
    nativeProviderWrite({
      providerId: "netease",
      accountId: "123",
      operation: { kind: "setLiked", trackId: "netease:track:1901371647", liked: true },
    }),
  ).rejects.toMatchObject({ upstreamCode: "unsupported_capability" });
  await expect(nativeProviderLikes()).rejects.toMatchObject({
    upstreamCode: "unsupported_capability",
  });
  await expect(
    invokeRemote("provider_read", {
      providerId: "netease",
      method: "library.setLiked",
      params: {},
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });

  // Reject missing or non-new providerId on provider_status / provider_read.
  await expect(invokeRemote("provider_status", {})).rejects.toMatchObject({
    code: "invalid_params",
  });
  await expect(invokeRemote("provider_status", { providerId: "qqmusic" })).rejects.toMatchObject({
    code: "invalid_params",
  });

  // Reject legacy endpoints when passed new-platform canonical IDs (containing ':') or missing providerId.
  await expect(
    invokeRemote("library_set_liked", { songIds: ["netease:track:1901371647"], liked: true }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });
  await expect(
    invokeRemote("catalog_song_artists", { songId: "netease:track:1901371647" }),
  ).rejects.toMatchObject({ code: "invalid_params" });
  await expect(
    invokeRemote("catalog_playlist_songs", {
      playlistId: "netease:playlist:1",
      editableId: null,
      page: 1,
      pageSize: 20,
      generation: 1,
    }),
  ).rejects.toMatchObject({ code: "invalid_params" });
  await expect(
    invokeRemote("personal_library", {
      request: { action: "bookmark", kind: "album", id: "netease:playlist:1", title: "T", saved: true },
    }),
  ).rejects.toMatchObject({ code: "invalid_params" });
  await expect(
    invokeRemote("playback_set_mv_lyric_offset", {
      trackId: "netease:track:1901371647",
      generation: 4,
      offsetMs: 100,
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });

  // Reject enqueueing new-source tracks without explicit providerId, or Bilibili video summaries.
  await expect(
    invokeRemote("queue_enqueue", { item: { id: "netease:track:1901371647" } }),
  ).rejects.toMatchObject({ code: "invalid_params" });
  await expect(
    invokeRemote("queue_enqueue", { item: { providerId: "bilibili", id: "BV17x411w7KC" } }),
  ).rejects.toMatchObject({ code: "invalid_params" });
  await expect(
    invokeRemote("queue_enqueue", { item: { providerId: "bilibili", id: "bilibili:video:BV17x411w7KC" } }),
  ).rejects.toMatchObject({ code: "invalid_params" });

  expect(fetcher.mock.calls.length).toBe(callsBeforeRejections);

  // Enqueueing playable NetEase track and Bilibili video part carries explicit providerId and updates mixed queue.
  const mixedQueue = {
    generation: 9,
    selectedIndex: 0,
    items: [
      ...state.queue.items,
      {
        providerId: "netease",
        id: "netease:track:1901371647",
        title: "孤勇者",
        artist: "陈奕迅",
        album: "孤勇者",
        durationMs: 256_000,
      },
      {
        providerId: "bilibili",
        id: "bilibili:video:BV17x411w7KC:124",
        title: "视频原题 / 第二 P 原题",
        artist: "UP 主",
        album: "",
        durationMs: 95_000,
        video: { title: "视频原题", partTitle: "第二 P 原题", partNumber: 2 },
      },
    ],
  };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(mixedQueue)));
  await invokeRemote("queue_enqueue_next", {
    item: mixedQueue.items[2],
  });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
    command: "queue_enqueue_next",
    providerId: "bilibili",
    id: "bilibili:video:BV17x411w7KC:124",
  });

  fetcher.mockResolvedValueOnce(new Response("null"));
  await invokeRemote("queue_play", { trackId: "bilibili:video:BV17x411w7KC:124", queueGeneration: 9 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
    action: "playTrack",
    providerId: "bilibili",
    id: "bilibili:video:BV17x411w7KC:124",
    queue_generation: 9,
  });
});
