import { parsePlaybackSessionSnapshot, parseQueueSnapshot } from "../backend/nativeQueueAdapter";
import { beginPlaybackSession, installPlaybackTransport, notifyPlaybackReconnected } from "../backend/playbackTransport";
import { mergePlaybackSession, newestQueue } from "../backend/sessionSnapshots";
import { trackProvider } from "../contracts/providerIdentity";
import type { NewProviderId, ProviderId } from "../contracts/providers";
import type { PlaybackSessionSnapshot } from "../contracts/queue";

type Connection = "disconnected" | "connecting" | "online" | "offline";
let connection: Connection = "disconnected";
let secret = "";
let epoch = 0;
let latest: PlaybackSessionSnapshot | undefined;
const covers = new Map<string, Promise<unknown>>();
let coverReaders = 0;
const waitingCovers: Array<() => void> = [];
const listeners = new Set<() => void>();
export const subscribeRemote = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const remoteStatus = () => connection;

const FORBIDDEN_REMOTE_PROVIDER_COMMANDS = new Set<string>([
  "provider_login",
  "provider_poll",
  "provider_cancel",
  "provider_restore",
  "provider_check",
  "provider_logout",
  "provider_write",
  "provider_verify_write",
  "provider_likes",
]);

const REMOTE_PROVIDER_READ_METHODS: Record<NewProviderId, ReadonlySet<string>> = {
  netease: new Set([
    "search.songs",
    "search.playlists",
    "song.detail",
    "library.containers",
    "library.container",
    "library.tracks",
    "library.likes",
  ]),
  bilibili: new Set([
    "search.videos",
    "video.resolve",
    "video.parts",
    "library.containers",
    "library.container",
    "library.videos",
  ]),
};

function remoteError(code: string, userMessage: string, retryable = false) {
  return { code, retryable, operation: "remote", userMessage };
}

function isNewProviderId(value: unknown): value is NewProviderId {
  return value === "netease" || value === "bilibili";
}

function buildQueueItemRef(item: unknown): { id: string; providerId?: ProviderId } {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw remoteError("invalid_params", "入队曲目格式无效");
  }
  const record = item as { id?: unknown; providerId?: unknown };
  if (typeof record.id !== "string") {
    throw remoteError("invalid_params", "仅可入队规范可播放曲目或分 P");
  }
  const inferred = trackProvider(record.id);
  if (!inferred) {
    throw remoteError("invalid_params", "仅可入队规范可播放曲目或分 P");
  }
  if (inferred === "netease" || inferred === "bilibili") {
    if (record.providerId !== inferred) {
      throw remoteError("invalid_params", "新来源入队请求必须显式携带匹配的 providerId");
    }
    return { providerId: inferred, id: record.id };
  }
  if (record.providerId !== undefined && record.providerId !== inferred) {
    throw remoteError("invalid_params", "曲目 ID 与来源标识不匹配");
  }
  return { id: record.id };
}

function buildQueueBatchArgs(items: unknown): { ids: string[]; providerId?: ProviderId } {
  if (!Array.isArray(items) || items.length === 0) {
    throw remoteError("invalid_params", "入队曲目列表不能为空");
  }
  const refs = items.map(buildQueueItemRef);
  const firstProvider = refs[0]?.providerId;
  if (refs.some((ref) => ref.providerId !== firstProvider)) {
    throw remoteError("invalid_params", "单次批量入队或替换队列必须属于同一来源");
  }
  return firstProvider ? { providerId: firstProvider, ids: refs.map((ref) => ref.id) } : { ids: refs.map((ref) => ref.id) };
}

function assertLegacyCatalogPayload(command: string, payload: Record<string, unknown>) {
  if (command === "library_set_liked") {
    if (
      !Array.isArray(payload.songIds) ||
      payload.songIds.some((id) => {
        if (typeof id !== "string" || id.includes(":")) return true;
        try {
          return trackProvider(id) !== "qqmusic";
        } catch {
          return true;
        }
      })
    ) {
      throw remoteError("unsupported_capability", "新来源写操作请在桌面端完成");
    }
    return;
  }
  for (const key of ["songId", "playlistId", "editableId", "albumId", "artistId"] as const) {
    const val = payload[key];
    if (typeof val === "string" && val.includes(":")) {
      throw remoteError("invalid_params", "旧曲库接口不接受新来源标识");
    }
  }
}

function status(value: Connection) {
  if (connection === value) return;
  const recovered = connection === "offline" && value === "online";
  connection = value;
  listeners.forEach((listener) => listener());
  if (recovered) notifyPlaybackReconnected();
}
export function disconnectRemote() {
  epoch++;
  beginPlaybackSession();
  secret = "";
  latest = undefined;
  covers.clear();
  sessionStorage.removeItem("qmg-remote-code");
  status("disconnected");
}
async function request(path: string, body?: unknown): Promise<Response> {
  const requestEpoch = epoch;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (requestEpoch !== epoch) throw new Error("连接已变化");
    if (response.status === 401) disconnectRemote();
    if (!response.ok) {
      if (response.status >= 500) status("offline");
      throw await response.json().catch(() => new Error("请求未完成"));
    }
    return response;
  } catch (error) {
    if (requestEpoch === epoch && error instanceof Error) status("offline");
    throw error;
  } finally { window.clearTimeout(timeout); }
}
async function readJson(path: string, body?: unknown): Promise<unknown> {
  const requestEpoch = epoch;
  const value: unknown = await (await request(path, body)).json();
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  return value;
}
async function readState(known?: unknown) {
  const requestEpoch = epoch;
  const value: unknown = await (await request(`/api/state${typeof known === "number" ? `?known=${known}` : ""}`)).json();
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  latest = mergePlaybackSession(latest, parsePlaybackSessionSnapshot(value, latest?.queue));
  status("online");
  return latest;
}
export async function invokeRemote(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const requestEpoch = epoch;
  const value = await dispatchRemote(command, payload);
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  return value;
}
async function dispatchRemote(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!secret) throw new Error("尚未连接电脑");
  if (FORBIDDEN_REMOTE_PROVIDER_COMMANDS.has(command)) {
    throw remoteError("unsupported_capability", "此操作请在电脑端完成");
  }
  if (command === "provider_status") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    if (!isNewProviderId(payload.providerId)) {
      throw remoteError("invalid_params", "新来源状态查询必须显式携带 netease 或 bilibili");
    }
    return readJson("/api/library", { command, providerId: payload.providerId });
  }
  if (command === "provider_read") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    if (!isNewProviderId(payload.providerId)) {
      throw remoteError("invalid_params", "新来源读取必须显式携带 netease 或 bilibili");
    }
    const method = typeof payload.method === "string" ? payload.method : "";
    if (!REMOTE_PROVIDER_READ_METHODS[payload.providerId].has(method)) {
      throw remoteError("unsupported_capability", "远端仅开放新来源只读浏览与搜索");
    }
    return readJson("/api/library", {
      command,
      providerId: payload.providerId,
      method,
      params: payload.params ?? {},
    });
  }
  if (command === "radar_start") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    const value = await readJson("/api/library", { command });
    latest = mergePlaybackSession(latest, parsePlaybackSessionSnapshot(value));
    return latest;
  }
  if (command === "personal_library") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    const req = payload.request as { action?: string; id?: unknown } | undefined;
    if ((req?.action === "bookmark" || req?.action === "pinBookmark") && typeof req.id === "string" && req.id.includes(":")) {
      throw remoteError("invalid_params", "旧收藏接口不接受新来源标识");
    }
    const value = await readJson("/api/library", { command, ...payload });
    const action = req?.action;
    if (action === "loadQueue" || action === "restoreQueue") latest = mergePlaybackSession(latest, parsePlaybackSessionSnapshot(value));
    if (action === "memoryTapeEnqueue" && latest) {
      const result=value as {queue:unknown};
      latest={...latest,queue:newestQueue(latest.queue,parseQueueSnapshot(result.queue))};
      return {...result,queue:latest.queue};
    }
    return value;
  }
  if (command === "catalog_song_artists") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    assertLegacyCatalogPayload(command, payload);
    return readJson("/api/library", { command, ...payload });
  }
  if (["catalog_search_suggestions", "catalog_recommend_songs", "catalog_recommend_playlists"].includes(command)) {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    return readJson("/api/library", { command, ...payload });
  }
  if (["auth_status", "catalog_discover_new_songs", "catalog_search_songs", "catalog_search_entities", "catalog_album_detail", "catalog_album_songs", "catalog_artist_detail", "catalog_artist_songs", "catalog_artist_albums", "library_liked_songs", "library_set_liked", "library_playlists", "catalog_playlist_songs", "local_music_list", "queue_replace", "queue_enqueue_many", "queue_enqueue", "queue_enqueue_next"].includes(command)) {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    assertLegacyCatalogPayload(command, payload);
    const args =
      command === "queue_enqueue" || command === "queue_enqueue_next"
        ? buildQueueItemRef(payload.item)
        : command === "queue_replace" || command === "queue_enqueue_many"
          ? buildQueueBatchArgs(payload.items)
          : payload;
    const value = await readJson("/api/library", { command, ...args });
    // Queue adapters immediately use the new index to play an enqueued song.
    if ((command === "queue_enqueue" || command === "queue_enqueue_next" || command === "queue_replace" || command === "queue_enqueue_many") && latest) {
      latest = { ...latest, queue: newestQueue(latest.queue, parseQueueSnapshot(value)) };
      return latest.queue;
    }
    return value;
  }
  if (command === "playback_session_snapshot") return readState(payload.knownQueueGeneration);
  if (command === "queue_snapshot" || command === "player_snapshot") {
    await readState();
    return command === "queue_snapshot" ? latest!.queue : latest!.player;
  }
  if (!latest) throw new Error("等待播放状态");
  if (command === "queue_preview_next") return readJson("/api/preview");
  if (command === "lyrics_get") return readJson(`/api/lyrics?track=${encodeURIComponent(String(payload.trackId))}&generation=${payload.generation}`);
  if (command === "cover_get") {
    const kind = payload.kind === "artist" ? "artist" : payload.kind === "playlist" ? "playlist" : "album";
    const track = kind === "album" ? latest.queue.items.find((item) => item.coverCacheKey === payload.cacheKey) : undefined;
    const cacheKey = String(payload.cacheKey);
    const key = `${kind}:${cacheKey}`;
    const existing = covers.get(key);
    if (existing) return existing;
    const coverEpoch = epoch;
    const pending = (async () => {
      if (coverReaders >= 2) await new Promise<void>(resolve => waitingCovers.push(resolve));
      else coverReaders++;
      try {
        if (coverEpoch !== epoch || !latest) throw new Error("连接已变化");
        const response = await request(track
          ? `/api/cover?track=${encodeURIComponent(track.id)}&generation=${latest.player.generation}`
          : `/api/library-cover?key=${encodeURIComponent(cacheKey)}&kind=${kind}`);
        return { mimeType: response.headers.get("content-type"), bytes: new Uint8Array(await response.arrayBuffer()) };
      } finally {
        const next = waitingCovers.shift();
        if (next) next(); else coverReaders--;
      }
    })();
    if (covers.size >= 64) covers.delete(covers.keys().next().value!);
    covers.set(key, pending);
    void pending.catch(() => { if (covers.get(key) === pending) covers.delete(key); });
    return pending;
  }
  if (connection !== "online") throw new Error("连接已断开，请等待恢复");
  let body: Record<string, unknown>;
  switch (command) {
    case "player_play": body = { action: "play" }; break;
    case "player_pause": body = { action: "pause" }; break;
    case "queue_next": body = { action: "next" }; break;
    case "queue_previous": body = { action: "previous" }; break;
    case "player_seek": body = { action: "seek", position_ms: payload.positionMs, generation: latest.player.generation }; break;
    case "player_set_volume": body = { action: "volume", value: payload.volume }; break;
    case "player_set_muted": body = { action: "muted", value: payload.muted }; break;
    case "playback_set_mode": body = { action: "mode", value: payload.mode }; break;
    case "playback_change_quality": body = { action: "quality", value: payload.preferredQuality }; break;
    case "playback_set_mv_lyric_offset": {
      const trackId = String(payload.trackId ?? "");
      if (!trackId || trackId.includes(":")) {
        throw remoteError("unsupported_capability", "歌词偏移仅支持 QQ 音乐曲目");
      }
      body = { action: "mvLyricOffset", id: trackId, generation: payload.generation, offset_ms: payload.offsetMs };
      break;
    }
    case "queue_play": {
      const track = latest.queue.items.find(item => item.id === payload.trackId);
      if (!track || payload.queueGeneration !== latest.queue.generation) throw new Error("队列已变化");
      const inferred = trackProvider(track.id);
      body =
        inferred === "netease" || inferred === "bilibili"
          ? { action: "playTrack", providerId: track.providerId ?? inferred, id: track.id, queue_generation: payload.queueGeneration }
          : { action: "playTrack", id: track.id, queue_generation: payload.queueGeneration };
      break;
    }
    default: throw new Error("此操作请在电脑端完成");
  }
  return readJson("/api/command", body);
}
export async function connectRemote(code: string): Promise<PlaybackSessionSnapshot> {
  epoch++;
  const connectionEpoch = epoch;
  beginPlaybackSession();
  secret = code.trim();
  latest = undefined;
  covers.clear();
  status("connecting");
  installPlaybackTransport(invokeRemote);
  try {
    await readState();
    sessionStorage.setItem("qmg-remote-code", secret);
    return latest!;
  } catch (error) {
    if (connectionEpoch === epoch && connection !== "disconnected") status("disconnected");
    throw error;
  }
}
