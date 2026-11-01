import { createSchemaGuards } from "./schemaGuards";
import { invokePlayback, isRemotePlayback } from "./playbackTransport";
import { invalidateProviderSession, observeProviderSession, providerSessionRevision, subscribeProviderSessions } from "./providerSessions";
import type { NewProviderId, ProviderWriteRequest, ProviderWriteReceipt } from "../contracts/providers";
import { containerProvider, decodeTrackRef } from "../contracts/providerIdentity";
import type {
  AccountRef,
  OnlineProviderId,
  ProviderAccount,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderContainer,
  ProviderErrorCode,
  ProviderPage,
  ProviderPhase,
  ProviderQuality,
  ProviderQrImage,
  ProviderQrState,
  ProviderSnapshot,
  ProviderTrack,
  ProviderVideo,
  ProviderWriteAction,
  VideoPartMetadata,
} from "../contracts/providers";
import type { QueueSnapshot, QueueTrack } from "../contracts/queue";
import {
  nativeQueueEnqueue,
  nativeQueueEnqueueMany,
  parseQueueTrack,
} from "./nativeQueueAdapter";

export const PROVIDER_COMMANDS = {
  status: "provider_status",
  login: "provider_login",
  poll: "provider_poll",
  cancel: "provider_cancel",
  restore: "provider_restore",
  check: "provider_check",
  logout: "provider_logout",
  read: "provider_read",
  write: "provider_write",
  verifyWrite: "provider_verify_write",
  likes: "provider_likes",
} as const;

export type NeteaseReadMethod =
  | "search.songs"
  | "search.playlists"
  | "song.detail"
  | "library.containers"
  | "library.tracks"
  | "library.likes";

const ONLINE_PROVIDER_IDS: readonly OnlineProviderId[] = ["qqmusic", "netease", "bilibili"];
const NON_READY_PHASES: readonly Exclude<ProviderPhase, "ready">[] = [
  "disabled",
  "starting",
  "authenticating",
  "restoring",
  "stopping",
];
const ERROR_CODES: readonly ProviderErrorCode[] = [
  "invalid_params",
  "unsupported_capability",
  "authentication_required",
  "credential_invalid",
  "network_unavailable",
  "rate_limited",
  "entitlement_denied",
  "preview_only",
  "media_unavailable",
  "unsupported_media",
  "upstream_schema_changed",
  "provider_unavailable",
  "outcome_unknown",
  "verification_failed",
  "verification_required",
  "cancelled",
  "internal_error",
];
const LOGIN_METHODS = ["qr", "qq", "wx"] as const;
const SEARCH_KINDS = ["songs", "artists", "albums", "playlists", "videos"] as const;
const LIBRARY_KINDS = ["created", "favorite", "likes"] as const;
const WRITE_ACTIONS: readonly ProviderWriteAction[] = [
  "playlist.create",
  "playlist.delete",
  "song.like",
  "song.unlike",
  "playlist.subscribe",
  "playlist.unsubscribe",
  "playlist.addTracks",
  "playlist.removeTracks",
  "favorite.addVideos",
  "favorite.removeVideos",
];
const QUALITIES: readonly ProviderQuality[] = ["auto", "flac", "320k", "128k", "aac"];
const AVAILABILITIES: readonly ProviderAvailability[] = [
  "unknown",
  "unavailable",
  "authenticationRequired",
  "deleted",
  "permissionDenied",
  "processing",
  "noAudio",
];

export class ProviderAdapterError extends Error {
  readonly code: "QMG-PROVIDER-001" | "QMG-PROVIDER-002";
  readonly upstreamCode: ProviderErrorCode | null;

  constructor(
    code: ProviderAdapterError["code"],
    upstreamCode: ProviderErrorCode | null = null,
  ) {
    super(code);
    this.name = "ProviderAdapterError";
    this.code = code;
    this.upstreamCode = upstreamCode;
  }
}

function invalid(): never {
  throw new ProviderAdapterError("QMG-PROVIDER-002");
}

const { exactRecord, unsigned } = createSchemaGuards(invalid);

function charBoundedString(value: unknown, minChars: number, maxChars: number, multiline = false): string {
  if (typeof value !== "string" || (multiline ? /\0/ : /[\r\n\0]/).test(value)) return invalid();
  const len = [...value].length;
  if (len < minChars || len > maxChars) return invalid();
  return value;
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  maxItems: number,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maxItems) return invalid();
  const seen = new Set<T>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T) || seen.has(item as T)) {
      return invalid();
    }
    seen.add(item as T);
  }
  return value as readonly T[];
}

function parseOnlineProviderId(value: unknown): OnlineProviderId {
  if (typeof value !== "string" || !ONLINE_PROVIDER_IDS.includes(value as OnlineProviderId)) {
    return invalid();
  }
  return value as OnlineProviderId;
}

function parseAccountRef(value: unknown, expectedProviderId?: OnlineProviderId): AccountRef {
  const record = exactRecord(value, ["providerId", "id"]);
  const providerId = parseOnlineProviderId(record.providerId);
  if (expectedProviderId && providerId !== expectedProviderId) return invalid();
  return {
    providerId,
    id: charBoundedString(record.id, 1, 128),
  };
}

function parseAccount(value: unknown, expectedProviderId?: OnlineProviderId): ProviderAccount {
  const record = exactRecord(value, ["providerId", "id", "displayName"]);
  const providerId = parseOnlineProviderId(record.providerId);
  if (expectedProviderId && providerId !== expectedProviderId) return invalid();
  return {
    providerId,
    id: charBoundedString(record.id, 1, 128),
    displayName: charBoundedString(record.displayName, 0, 512),
  };
}

function parseCapabilities(value: unknown): ProviderCapabilities {
  const record = exactRecord(value, [
    "loginMethods",
    "searchKinds",
    "libraryKinds",
    "writeActions",
    "lyrics",
    "qualities",
  ]);
  if (typeof record.lyrics !== "boolean") return invalid();
  return {
    loginMethods: uniqueEnumArray(record.loginMethods, LOGIN_METHODS, 3),
    searchKinds: uniqueEnumArray(record.searchKinds, SEARCH_KINDS, 5),
    libraryKinds: uniqueEnumArray(record.libraryKinds, LIBRARY_KINDS, 3),
    writeActions: uniqueEnumArray(record.writeActions, WRITE_ACTIONS, 10),
    lyrics: record.lyrics,
    qualities: uniqueEnumArray(record.qualities, QUALITIES, 5),
  };
}

export function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const providerId = parseOnlineProviderId(raw.providerId);
  if (raw.state === "ready") {
    const record = exactRecord(value, [
      "providerId",
      "capabilities",
      "state",
      "account",
      "persistence",
    ]);
    if (record.persistence !== "saved" && record.persistence !== "sessionOnly") return invalid();
    return {
      providerId,
      capabilities: parseCapabilities(record.capabilities),
      state: "ready",
      account: parseAccount(record.account, providerId),
      persistence: record.persistence,
    };
  }
  const hasError = "error" in raw;
  const hasRetry = "retryAfterMs" in raw;
  const record = exactRecord(value, [
    "providerId",
    "capabilities",
    "state",
    ...(hasError ? ["error"] : []),
    ...(hasRetry ? ["retryAfterMs"] : []),
  ]);
  if (
    typeof record.state !== "string" ||
    !NON_READY_PHASES.includes(record.state as Exclude<ProviderPhase, "ready">)
  ) {
    return invalid();
  }
  const error = hasError
    ? (() => {
        if (typeof record.error !== "string" || !ERROR_CODES.includes(record.error as ProviderErrorCode)) {
          return invalid();
        }
        return record.error as ProviderErrorCode;
      })()
    : undefined;
  const retryAfterMs = hasRetry
    ? (() => {
        const ms = unsigned(record.retryAfterMs);
        if (ms > 86_400_000) return invalid();
        return ms;
      })()
    : undefined;
  return {
    providerId,
    capabilities: parseCapabilities(record.capabilities),
    state: record.state as Exclude<ProviderPhase, "ready">,
    ...(error !== undefined ? { error } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function parseProviderQrImage(value: unknown): ProviderQrImage {
  const record = exactRecord(value, [
    "sessionId",
    "mimeType",
    "imageBase64",
    "expiresAtMs",
    "pollAfterMs",
  ]);
  if (record.mimeType !== "image/png") return invalid();
  const imageBase64 = charBoundedString(record.imageBase64, 4, 524_288);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return invalid();
  const expiresAtMs = unsigned(record.expiresAtMs);
  const pollAfterMs = unsigned(record.pollAfterMs);
  if (expiresAtMs < 1 || pollAfterMs < 1_000 || pollAfterMs > 30_000) return invalid();
  return {
    sessionId: charBoundedString(record.sessionId, 1, 128),
    mimeType: "image/png",
    imageBase64,
    expiresAtMs,
    pollAfterMs,
  };
}

export function parseProviderQrState(value: unknown): ProviderQrState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (raw.state === "authenticated") {
    const record = exactRecord(value, ["sessionId", "state", "account", "persistence"]);
    if (record.persistence !== "saved" && record.persistence !== "sessionOnly") return invalid();
    return {
      sessionId: charBoundedString(record.sessionId, 1, 128),
      state: "authenticated",
      account: parseAccount(record.account),
      persistence: record.persistence,
    };
  }
  const record = exactRecord(value, ["sessionId", "state"]);
  if (
    record.state !== "waitingScan" &&
    record.state !== "waitingConfirmation" &&
    record.state !== "expired" &&
    record.state !== "rejected" &&
    record.state !== "cancelled"
  ) {
    return invalid();
  }
  return {
    sessionId: charBoundedString(record.sessionId, 1, 128),
    state: record.state,
  };
}

function parseVideoPartMetadata(value: unknown): VideoPartMetadata {
  const record = exactRecord(value, ["title", "partTitle", "partNumber"]);
  const partNumber = unsigned(record.partNumber);
  if (partNumber < 1 || partNumber > 10_000) return invalid();
  return {
    title: charBoundedString(record.title, 1, 512),
    partTitle: charBoundedString(record.partTitle, 1, 512),
    partNumber,
  };
}

export function parseProviderTrack(value: unknown): ProviderTrack {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const hasCover = "coverCacheKey" in raw;
  const hasVideo = "video" in raw;
  const record = exactRecord(value, [
    "providerId",
    "id",
    "title",
    "artist",
    "creatorKind",
    "album",
    "durationMs",
    "availability",
    ...(hasCover ? ["coverCacheKey"] : []),
    ...(hasVideo ? ["video"] : []),
  ]);
  if (typeof record.id !== "string" || typeof record.providerId !== "string") return invalid();
  const ref = decodeTrackRef(
    record.id,
    record.providerId as ProviderTrack["providerId"],
  );
  if (!ref) return invalid();
  if (record.creatorKind !== "artist" && record.creatorKind !== "uploader") return invalid();
  if (ref.providerId === "bilibili") {
    if (record.creatorKind !== "uploader" || !hasVideo) return invalid();
  } else if (hasVideo) {
    return invalid();
  }
  const durationMs = unsigned(record.durationMs);
  if (durationMs > 86_400_000) return invalid();
  if (
    typeof record.availability !== "string" ||
    !AVAILABILITIES.includes(record.availability as ProviderAvailability)
  ) {
    return invalid();
  }
  const coverCacheKey = hasCover ? charBoundedString(record.coverCacheKey, 1, 128) : undefined;
  const video = hasVideo ? parseVideoPartMetadata(record.video) : undefined;
  return {
    providerId: ref.providerId,
    id: ref.id,
    title: charBoundedString(record.title, 1, 512),
    artist: charBoundedString(record.artist, 1, 512),
    creatorKind: record.creatorKind,
    album: charBoundedString(record.album, 0, 512),
    durationMs,
    availability: record.availability as ProviderAvailability,
    ...(coverCacheKey !== undefined ? { coverCacheKey } : {}),
    ...(video !== undefined ? { video } : {}),
  };
}

export function parseProviderContainer(value: unknown): ProviderContainer {
  const record = exactRecord(value, [
    "providerId",
    "id",
    "kind",
    "ownership",
    "owner",
    "title",
    "description",
    "itemCount",
    "allowedActions",
  ]);
  const providerId = parseOnlineProviderId(record.providerId);
  if (typeof record.id !== "string" || containerProvider(record.id) !== providerId) {
    return invalid();
  }
  if (record.kind !== "playlist" && record.kind !== "favoriteFolder") return invalid();
  if (providerId === "bilibili" ? record.kind !== "favoriteFolder" : record.kind !== "playlist") {
    return invalid();
  }
  if (record.ownership !== "created" && record.ownership !== "collected") return invalid();
  const itemCount = unsigned(record.itemCount);
  if (itemCount > 10_000_000) return invalid();
  return {
    providerId,
    id: record.id,
    kind: record.kind,
    ownership: record.ownership,
    owner: parseAccountRef(record.owner, providerId),
    title: charBoundedString(record.title, 1, 512),
    description: charBoundedString(record.description, 0, 4096, true),
    itemCount,
    allowedActions: uniqueEnumArray(record.allowedActions, WRITE_ACTIONS, 10),
  };
}

function parseProviderPage<T>(
  value: unknown,
  itemParser: (item: unknown) => T,
): ProviderPage<T> {
  const record = exactRecord(value, ["page", "hasMore", "total", "items"]);
  const page = unsigned(record.page);
  if (page < 1 || typeof record.hasMore !== "boolean" || !Array.isArray(record.items)) {
    return invalid();
  }
  const total = record.total === null ? null : unsigned(record.total);
  return {
    page,
    hasMore: record.hasMore,
    total,
    items: record.items.map(itemParser),
  };
}

export function parseProviderTrackPage(value: unknown): ProviderPage<ProviderTrack> {
  return parseProviderPage(value, parseProviderTrack);
}

export function parseProviderContainerPage(value: unknown): ProviderPage<ProviderContainer> {
  return parseProviderPage(value, parseProviderContainer);
}

/**
 * Explicitly projects a validated `ProviderTrack` into a `QueueTrack` without leaking
 * `creatorKind` and `availability`; preserves durable video part metadata.
 */
export function providerTrackToQueueTrack(track: ProviderTrack): QueueTrack {
  const validated = parseProviderTrack(track);
  try {
    return parseQueueTrack({
      providerId: validated.providerId,
      id: validated.id,
      title: validated.title,
      artist: validated.artist,
      album: validated.album,
      durationMs: validated.durationMs,
      ...(validated.video ? { video: validated.video } : {}),
      ...(validated.coverCacheKey !== undefined
        ? { coverCacheKey: validated.coverCacheKey }
        : {}),
    });
  } catch {
    return invalid();
  }
}

export function providerErrorFromInvoke(error: unknown): ProviderAdapterError {
  if (error instanceof ProviderAdapterError) return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (ERROR_CODES.includes(code as ProviderErrorCode)) {
        return new ProviderAdapterError("QMG-PROVIDER-001", code as ProviderErrorCode);
      }
      if (code === "invalid_request") {
        return new ProviderAdapterError("QMG-PROVIDER-001", "invalid_params");
      }
      if (code === "QMG-RUNTIME-002") {
        return new ProviderAdapterError("QMG-PROVIDER-001", "provider_unavailable");
      }
    }
  }
  if (typeof error === "string") {
    if (ERROR_CODES.includes(error as ProviderErrorCode)) {
      return new ProviderAdapterError("QMG-PROVIDER-001", error as ProviderErrorCode);
    }
    if (error === "provider_v2_Cooldown") {
      return new ProviderAdapterError("QMG-PROVIDER-001", "rate_limited");
    }
    if (error === "provider_v2_Unavailable") {
      return new ProviderAdapterError("QMG-PROVIDER-001", "provider_unavailable");
    }
  }
  return new ProviderAdapterError("QMG-PROVIDER-001", null);
}

function isTauriDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeProvider(
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (isRemotePlayback()) {
    if (command !== PROVIDER_COMMANDS.status && command !== PROVIDER_COMMANDS.read) {
      throw new ProviderAdapterError("QMG-PROVIDER-001", "unsupported_capability");
    }
    try {
      return await invokePlayback(command, payload);
    } catch (error) {
      throw providerErrorFromInvoke(error);
    }
  }
  if (!isTauriDesktopRuntime()) {
    throw new ProviderAdapterError("QMG-PROVIDER-001", "provider_unavailable");
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke(command, payload);
  } catch (error) {
    throw providerErrorFromInvoke(error);
  }
}

export async function nativeProviderStatus(
  providerId: OnlineProviderId,
): Promise<ProviderSnapshot> {
  const revision = providerId === "qqmusic" ? null : providerSessionRevision(providerId);
  const status = parseProviderSnapshot(
    await invokeProvider(PROVIDER_COMMANDS.status, {
      providerId: parseOnlineProviderId(providerId),
    }),
  );
  if (status.providerId !== providerId) return invalid();
  if (providerId !== "qqmusic" && revision !== providerSessionRevision(providerId)) throw new ProviderAdapterError("QMG-PROVIDER-001", "cancelled");
  if (providerId === "netease" || providerId === "bilibili") observeProviderSession(providerId, status.state === "ready" ? status.account.id : status.state);
  return status;
}

export async function nativeProviderLogin(
  providerId: "netease" | "bilibili" = "netease",
): Promise<ProviderQrImage> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  invalidateProviderSession(providerId);
  return parseProviderQrImage(
    await invokeProvider(PROVIDER_COMMANDS.login, { providerId }),
  );
}

export async function nativeProviderPoll(
  providerId: "netease" | "bilibili",
  sessionId: string,
): Promise<ProviderQrState> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  return parseProviderQrState(
    await invokeProvider(PROVIDER_COMMANDS.poll, {
      providerId,
      sessionId: charBoundedString(sessionId, 1, 128),
    }),
  );
}

export async function nativeProviderCancel(
  providerId: "netease" | "bilibili",
  sessionId: string,
): Promise<void> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  const res = await invokeProvider(PROVIDER_COMMANDS.cancel, {
    providerId,
    sessionId: charBoundedString(sessionId, 1, 128),
  });
  if (res !== null && res !== undefined) return invalid();
}

export async function nativeProviderRestore(
  providerId: "netease" | "bilibili" = "netease",
): Promise<boolean> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  invalidateProviderSession(providerId);
  const res = await invokeProvider(PROVIDER_COMMANDS.restore, { providerId });
  if (typeof res !== "boolean") return invalid();
  return res;
}

export async function nativeProviderLogout(
  providerId: "netease" | "bilibili" = "netease",
): Promise<void> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  invalidateProviderSession(providerId);
  const res = await invokeProvider(PROVIDER_COMMANDS.logout, { providerId });
  if (res !== null && res !== undefined) return invalid();
}

export async function nativeProviderCheck(providerId: "netease" | "bilibili"): Promise<boolean> {
  if (providerId !== "netease" && providerId !== "bilibili") return invalid();
  const valid = await invokeProvider(PROVIDER_COMMANDS.check, { providerId });
  if (typeof valid !== "boolean") return invalid();
  if (!valid) invalidateProviderSession(providerId);
  return valid;
}

export async function nativeProviderSearchSongs(
  providerId: "netease",
  keyword: string,
  page = 1,
  pageSize = 20,
): Promise<ProviderPage<ProviderTrack>> {
  if (providerId !== "netease") return invalid();
  const p = unsigned(page);
  const ps = unsigned(pageSize);
  if (p < 1 || p > 1_000 || ps < 1 || ps > 100) return invalid();
  return parseProviderTrackPage(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "search.songs" satisfies NeteaseReadMethod,
      params: {
        keyword: charBoundedString(keyword, 1, 200),
        page: p,
        pageSize: ps,
      },
    }),
  );
}

export async function nativeProviderSearchPlaylists(
  providerId: "netease",
  keyword: string,
  page = 1,
  pageSize = 20,
): Promise<ProviderPage<ProviderContainer>> {
  if (providerId !== "netease") return invalid();
  const p = unsigned(page);
  const ps = unsigned(pageSize);
  if (p < 1 || p > 1_000 || ps < 1 || ps > 100) return invalid();
  return parseProviderContainerPage(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "search.playlists" satisfies NeteaseReadMethod,
      params: {
        keyword: charBoundedString(keyword, 1, 200),
        page: p,
        pageSize: ps,
      },
    }),
  );
}

export async function nativeProviderSongDetail(
  providerId: "netease",
  songId: string,
): Promise<ProviderTrack> {
  if (providerId !== "netease" || !decodeTrackRef(songId, "netease")) return invalid();
  return parseProviderTrack(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "song.detail" satisfies NeteaseReadMethod,
      params: { songId },
    }),
  );
}

export async function nativeProviderLibraryContainers(
  providerId: "netease" | "bilibili",
  kind: "created" | "favorite",
  page = 1,
  pageSize = 20,
): Promise<ProviderPage<ProviderContainer>> {
  if ((providerId !== "netease" && providerId !== "bilibili") || (kind !== "created" && kind !== "favorite")) return invalid();
  const p = unsigned(page);
  const ps = unsigned(pageSize);
  if (p < 1 || p > 1_000 || ps < 1 || ps > 100) return invalid();
  return parseProviderContainerPage(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "library.containers" satisfies NeteaseReadMethod,
      params: { kind, page: p, pageSize: ps },
    }),
  );
}

export async function nativeProviderLibraryTracks(
  providerId: "netease",
  containerId: string,
  page = 1,
  pageSize = 20,
): Promise<ProviderPage<ProviderTrack>> {
  if (providerId !== "netease" || containerProvider(containerId) !== "netease") return invalid();
  const p = unsigned(page);
  const ps = unsigned(pageSize);
  if (p < 1 || p > 1_000 || ps < 1 || ps > 100) return invalid();
  return parseProviderTrackPage(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "library.tracks" satisfies NeteaseReadMethod,
      params: { containerId, page: p, pageSize: ps },
    }),
  );
}

export async function nativeProviderLibraryLikes(
  providerId: "netease",
  page = 1,
  pageSize = 20,
): Promise<ProviderPage<ProviderTrack>> {
  if (providerId !== "netease") return invalid();
  const p = unsigned(page);
  const ps = unsigned(pageSize);
  if (p < 1 || p > 1_000 || ps < 1 || ps > 100) return invalid();
  return parseProviderTrackPage(
    await invokeProvider(PROVIDER_COMMANDS.read, {
      providerId,
      method: "library.likes" satisfies NeteaseReadMethod,
      params: { page: p, pageSize: ps },
    }),
  );
}

export async function nativeProviderEnqueueTrack(
  track: ProviderTrack,
): Promise<QueueSnapshot> {
  return nativeQueueEnqueue(providerTrackToQueueTrack(track));
}

export async function nativeProviderEnqueueTracks(
  tracks: readonly ProviderTrack[],
): Promise<QueueSnapshot> {
  return nativeQueueEnqueueMany(tracks.map(providerTrackToQueueTrack));
}

export function parseProviderVideo(value: unknown): ProviderVideo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const hasCover = "coverCacheKey" in value;
  const r = exactRecord(value, ["providerId", "bvid", "aid", "title", "uploader", "durationMs", "availability", ...(hasCover ? ["coverCacheKey"] : [])]);
  if (r.providerId !== "bilibili" || typeof r.bvid !== "string" || !decodeTrackRef(`bilibili:video:${r.bvid}:1`, "bilibili")
    || typeof r.aid !== "string" || !/^[1-9][0-9]{0,19}$/.test(r.aid)
    || typeof r.availability !== "string" || !AVAILABILITIES.includes(r.availability as ProviderAvailability)) return invalid();
  const durationMs = unsigned(r.durationMs); if (durationMs > 864000000000) return invalid();
  return { providerId: "bilibili", bvid: r.bvid, aid: r.aid, title: charBoundedString(r.title, 1, 512),
    uploader: charBoundedString(r.uploader, 1, 512), durationMs, availability: r.availability as ProviderAvailability,
    ...(hasCover ? { coverCacheKey: charBoundedString(r.coverCacheKey, 1, 128) } : {}) };
}
export function parseProviderVideoPage(value: unknown): ProviderPage<ProviderVideo> {
  return parseProviderPage(value, parseProviderVideo);
}
function videoPaging(page: number, pageSize: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return invalid();
  return { page, pageSize };
}
export async function nativeProviderSearchVideos(keyword: string, page = 1, pageSize = 20): Promise<ProviderPage<ProviderVideo>> {
  return parseProviderVideoPage(await invokeProvider(PROVIDER_COMMANDS.read, { providerId: "bilibili", method: "search.videos", params: { keyword: charBoundedString(keyword, 1, 200), ...videoPaging(page, pageSize) } }));
}
export async function nativeProviderResolveVideo(input: string): Promise<ProviderVideo> {
  return parseProviderVideo(await invokeProvider(PROVIDER_COMMANDS.read, { providerId: "bilibili", method: "video.resolve", params: { input: charBoundedString(input, 1, 4096) } }));
}
export async function nativeProviderVideoParts(bvid: string, page = 1, pageSize = 100): Promise<ProviderPage<ProviderTrack>> {
  if (!decodeTrackRef(`bilibili:video:${bvid}:1`, "bilibili")) return invalid();
  const result = parseProviderTrackPage(await invokeProvider(PROVIDER_COMMANDS.read, { providerId: "bilibili", method: "video.parts", params: { bvid, ...videoPaging(page, pageSize) } }));
  if (result.items.some(t => !t.id.startsWith(`bilibili:video:${bvid}:`))) return invalid();
  return result;
}
export async function nativeProviderLibraryVideos(containerId: string, page = 1, pageSize = 20): Promise<ProviderPage<ProviderVideo>> {
  if (containerProvider(containerId) !== "bilibili") return invalid();
  return parseProviderVideoPage(await invokeProvider(PROVIDER_COMMANDS.read, { providerId: "bilibili", method: "library.videos", params: { containerId, ...videoPaging(page, pageSize) } }));
}
/** Minimal controlled group entry: obtain every part before a single queue mutation. */
export async function nativeProviderEnqueueVideo(input: string, selection: "first" | "all" | number = "first"): Promise<QueueSnapshot> {
  if (selection !== "first" && selection !== "all" && (typeof selection !== "number" || !Number.isSafeInteger(selection) || selection < 1 || selection > 10000)) return invalid();
  const status = await nativeProviderStatus("bilibili");
  if (status.state !== "ready") throw new ProviderAdapterError("QMG-PROVIDER-001", "authentication_required");
  const revision = providerSessionRevision("bilibili");
  const video = await nativeProviderResolveVideo(input);
  const tracks: ProviderTrack[] = [];
  const firstPage = typeof selection === "number" ? Math.floor((selection - 1) / 100) + 1 : 1;
  for (let page = firstPage; page <= 100; page++) {
    const parts = await nativeProviderVideoParts(video.bvid, page, 100);
    if (parts.page !== page || parts.items.some((t, i) => t.video?.partNumber !== (page - 1) * 100 + i + 1)) return invalid();
    if (selection === "all" && parts.total !== null && parts.total > 1000) return invalid();
    tracks.push(...parts.items);
    if (selection === "all" && tracks.length > 1000) return invalid();
    if (!parts.hasMore || selection !== "all") break;
    if (page === 100) return invalid();
  }
  const current = await nativeProviderStatus("bilibili");
  if (current.state !== "ready" || current.account.id !== status.account.id || revision !== providerSessionRevision("bilibili")) throw new ProviderAdapterError("QMG-PROVIDER-001", "authentication_required");
  if (!tracks.length) return invalid();
  const chosen = selection === "all" ? tracks : selection === "first" ? tracks.slice(0, 1) : tracks.filter(t => t.video?.partNumber === selection);
  if (!chosen.length || chosen.length > 1000) return invalid();
  return nativeProviderEnqueueTracks(chosen);
}

export function parseProviderWriteRequest(value: unknown): ProviderWriteRequest {
  const r = exactRecord(value, ["providerId", "accountId", "operation"]);
  if (r.providerId !== "netease" && r.providerId !== "bilibili") return invalid();
  const providerId: NewProviderId = r.providerId;
  const accountId = charBoundedString(r.accountId, 1, 128);
  if (!r.operation || typeof r.operation !== "object") return invalid();
  const kind = (r.operation as Record<string, unknown>).kind;
  if (kind === "setLiked") {
    const o = exactRecord(r.operation, ["kind", "trackId", "liked"]);
    if (providerId !== "netease" || typeof o.trackId !== "string" || decodeTrackRef(o.trackId)?.providerId !== providerId || typeof o.liked !== "boolean") return invalid();
    return { providerId, accountId, operation: { kind, trackId: o.trackId, liked: o.liked } };
  }
  if (kind === "setSubscribed") {
    const o = exactRecord(r.operation, ["kind", "containerId", "subscribed"]);
    if (providerId !== "netease" || typeof o.containerId !== "string" || containerProvider(o.containerId) !== providerId || typeof o.subscribed !== "boolean") return invalid();
    return { providerId, accountId, operation: { kind, containerId: o.containerId, subscribed: o.subscribed } };
  }
  if (kind !== "addItems" && kind !== "removeItems") return invalid();
  const o = exactRecord(r.operation, ["kind", "containerId", "trackIds"]);
  if (typeof o.containerId !== "string" || containerProvider(o.containerId) !== providerId || !Array.isArray(o.trackIds) || !o.trackIds.length || o.trackIds.length > 100 || o.trackIds.some(t => typeof t !== "string" || decodeTrackRef(t)?.providerId !== providerId)) return invalid();
  return { providerId, accountId, operation: { kind, containerId: o.containerId, trackIds: [...new Set(o.trackIds as string[])] } };
}
export function parseProviderWriteReceipt(value: unknown): ProviderWriteReceipt {
  const r = exactRecord(value, ["status", "affectedCount"]);
  if (r.status !== "applied" && r.status !== "verificationPending") return invalid();
  if (r.affectedCount !== null && (unsigned(r.affectedCount) > 100 || r.status === "verificationPending")) return invalid();
  return { status: r.status, affectedCount: r.affectedCount as number | null };
}
const writesInFlight = new Set<string>();
const unresolvedWrites = new Map<string, { revision: number; request: ProviderWriteRequest }>();
subscribeProviderSessions(id => { for (const [key, entry] of unresolvedWrites) if (entry.request.providerId === id) unresolvedWrites.delete(key); });
export async function nativeProviderWrite(request: ProviderWriteRequest, verifyOnly = false): Promise<ProviderWriteReceipt> {
  const input = parseProviderWriteRequest(request);
  const o = input.operation;
  const revision = providerSessionRevision(input.providerId);
  const key = `${input.providerId}:${revision}:${input.accountId}:${o.kind === "setLiked" ? o.trackId : o.containerId}`;
  const unresolved = unresolvedWrites.get(key);
  if (unresolved && (!verifyOnly || JSON.stringify(unresolved.request) !== JSON.stringify(input))) throw new ProviderAdapterError("QMG-PROVIDER-001", "outcome_unknown");
  if (writesInFlight.has(key)) throw new ProviderAdapterError("QMG-PROVIDER-001", "cancelled");
  writesInFlight.add(key);
  try {
    const result = parseProviderWriteReceipt(await invokeProvider(verifyOnly ? PROVIDER_COMMANDS.verifyWrite : PROVIDER_COMMANDS.write, { request: input }));
    if (revision === providerSessionRevision(input.providerId)) {
      if (result.status === "applied") unresolvedWrites.delete(key);
      else unresolvedWrites.set(key, { revision, request: input });
    }
    return result;
  } catch (error) {
    if (!verifyOnly && revision === providerSessionRevision(input.providerId) && error instanceof ProviderAdapterError && (error.upstreamCode === "outcome_unknown" || error.code === "QMG-PROVIDER-002" || error.upstreamCode === null)) unresolvedWrites.set(key, { revision, request: input });
    throw error;
  }
  finally { writesInFlight.delete(key); }
}
export async function nativeProviderContainer(providerId: NewProviderId, containerId: string): Promise<ProviderContainer> {
  if (containerProvider(containerId) !== providerId) return invalid();
  return parseProviderContainer(await invokeProvider(PROVIDER_COMMANDS.read, { providerId, method: "library.container", params: { containerId } }));
}
export async function nativeProviderLikes(): Promise<{ accountId: string; ids: string[] }> {
  const revision = providerSessionRevision("netease");
  const r = exactRecord(await invokeProvider(PROVIDER_COMMANDS.likes, {}), ["accountId", "ids"]);
  const accountId = charBoundedString(r.accountId, 1, 128);
  if (!Array.isArray(r.ids) || r.ids.length > 100000 || r.ids.some(id => typeof id !== "string" || decodeTrackRef(id)?.providerId !== "netease") || new Set(r.ids).size !== r.ids.length) return invalid();
  for (const [key, entry] of unresolvedWrites) {
    const op = entry.request.operation;
    if (revision === providerSessionRevision("netease") && entry.request.providerId === "netease" && entry.revision === revision && entry.request.accountId === accountId && op.kind === "setLiked" && r.ids.includes(op.trackId) === op.liked) unresolvedWrites.delete(key);
  }
  return { accountId, ids: r.ids as string[] };
}
