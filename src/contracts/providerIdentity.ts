import type { ProviderId, TrackRef } from "./providers";

const decimal = /^[1-9][0-9]{0,19}$/;
const bvid = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
const legacyQq = /^[A-Za-z0-9_-]{1,128}$/;
const local = /^local_[0-9a-f]{64}_(mp3|flac|ogg)$/;
const matches = (pattern: RegExp, value: string): boolean => pattern.exec(value)?.[0] === value;

/** Does not normalize legacy IDs, numeric IDs, or BVID case. */
export function trackProvider(id: string): ProviderId | null {
  if (id.length > 128) return null;
  if (id.startsWith("local_")) return matches(local, id) ? "local" : null;
  const parts = id.split(":");
  if (parts.length === 3 && parts[0] === "netease" && parts[1] === "track" && matches(decimal, parts[2]!)) return "netease";
  if (parts.length === 4 && parts[0] === "bilibili" && parts[1] === "video" && matches(bvid, parts[2]!) && matches(decimal, parts[3]!)) return "bilibili";
  return matches(legacyQq, id) ? "qqmusic" : null;
}

/** Missing providerId is accepted only at a legacy persisted-data boundary. */
export function decodeTrackRef(id: string, providerId?: ProviderId): TrackRef | null {
  const inferred = trackProvider(id);
  return inferred && (providerId === undefined || inferred === providerId)
    ? { id, providerId: inferred } : null;
}

export function neteaseTrackId(songId: string): string {
  if (!matches(decimal, songId)) throw new Error("invalid_track_identity");
  return `netease:track:${songId}`;
}

export function bilibiliTrackId(videoId: string, cid: string): string {
  if (!matches(bvid, videoId) || !matches(decimal, cid)) throw new Error("invalid_track_identity");
  return `bilibili:video:${videoId}:${cid}`;
}

export function containerProvider(id: string): "netease" | "bilibili" | null {
  const parts = id.split(":");
  if (parts.length !== 3 || !matches(decimal, parts[2]!)) return null;
  if (parts[0] === "netease" && parts[1] === "playlist") return "netease";
  if (parts[0] === "bilibili" && parts[1] === "favorite") return "bilibili";
  return null;
}
