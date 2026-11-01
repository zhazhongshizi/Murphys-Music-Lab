/** Private stdin/stdout types. MUST NOT be imported by renderer production code. */
import type { NewProviderId, ProviderAvailability, ProviderErrorCode, ProviderQuality, ProviderWriteAction, ProviderWriteReceipt, VideoPartMetadata } from "../src/contracts/providers";

export type RawTrackRef = { readonly kind: "song"; readonly songId: string }
  | { readonly kind: "videoPart"; readonly bvid: string; readonly cid: string };
export type RawWriteItem = { readonly kind: "song"; readonly songId: string }
  | { readonly kind: "video"; readonly bvid: string };
export interface PrivateCredential { readonly version: 1; readonly providerId: NewProviderId; readonly payload: string }
export interface PrivateAccount { readonly id: string; readonly displayName: string }
export interface PrivateTrack {
  readonly ref: RawTrackRef;
  readonly title: string;
  readonly artist: string;
  readonly creatorKind: "artist" | "uploader";
  readonly album: string;
  readonly durationMs: number;
  readonly coverUrl: string | null;
  readonly availability: ProviderAvailability;
  readonly video?: VideoPartMetadata;
}
export interface PrivateVideo {
  readonly bvid: string; readonly aid: string; readonly title: string; readonly uploader: string;
  readonly durationMs: number; readonly coverUrl: string | null;
  readonly availability: ProviderAvailability;
}
export interface PrivateContainer {
  readonly id: string; readonly kind: "playlist" | "favoriteFolder";
  readonly ownership: "created" | "collected"; readonly ownerId: string;
  readonly title: string; readonly description: string; readonly itemCount: number;
  readonly allowedActions: readonly Exclude<ProviderWriteAction, "playlist.create" | "playlist.delete">[];
}
export interface PrivateCapabilities {
  readonly loginMethods: readonly "qr"[];
  readonly searchKinds: readonly ("songs" | "playlists" | "videos")[];
  readonly libraryKinds: readonly ("created" | "favorite" | "likes")[];
  readonly writeActions: PrivateContainer["allowedActions"];
  readonly lyrics: boolean; readonly qualities: readonly ProviderQuality[];
}
type Empty = Record<string, never>;
interface Paging { readonly page: number; readonly pageSize: number }
interface Search extends Paging { readonly keyword: string }
interface Contents extends Paging { readonly containerId: string }
interface WriteItems { readonly containerId: string; readonly items: readonly RawWriteItem[] }
interface Session { readonly sessionId: string }
export interface RequestParams {
  "system.handshake": { readonly protocolVersion: 2; readonly providerId: NewProviderId };
  "system.ping": Empty;
  "auth.qr.start": Empty;
  "auth.qr.poll": Session;
  "auth.qr.cancel": Session;
  "auth.credential.restore": { readonly credential: PrivateCredential };
  "auth.credential.check": Empty;
  "auth.credential.refresh": Empty;
  "auth.logout": Empty;
  "search.songs": Search;
  "search.playlists": Search;
  "search.videos": Search;
  "song.detail": { readonly songId: string };
  "video.resolve": { readonly input: string };
  "video.parts": Paging & { readonly bvid: string };
  "library.containers": Paging & { readonly kind: "created" | "favorite" };
  "library.tracks": Contents;
  "library.videos": Contents;
  "library.likes": Paging;
  "library.likeIds": Empty;
  "library.container": { readonly containerId: string };
  "library.verify": { [M in "library.setLiked" | "library.setSubscribed" | "library.addItems" | "library.removeItems"]: { readonly method: M; readonly params: RequestParams[M] } }["library.setLiked" | "library.setSubscribed" | "library.addItems" | "library.removeItems"];
  "library.setLiked": { readonly songId: string; readonly liked: boolean };
  "library.setSubscribed": { readonly containerId: string; readonly subscribed: boolean };
  "library.addItems": WriteItems;
  "library.removeItems": WriteItems;
  "lyrics.get": { readonly songId: string };
  "playback.resolve": { readonly track: RawTrackRef; readonly preferredQuality: ProviderQuality };
}
export interface PrivatePage<T> { readonly page: number; readonly hasMore: boolean; readonly total: number | null; readonly items: readonly T[] }
export interface ResultMap {
  "system.handshake": { readonly protocolVersion: 2; readonly provider: { readonly id: NewProviderId; readonly name: "netease-provider" | "bilibili-provider"; readonly version: string }; readonly maxLineBytes: 1048576; readonly capabilities: PrivateCapabilities; readonly implementedMethods: readonly Method[] };
  "system.ping": { readonly alive: true };
  "auth.qr.start": { readonly sessionId: string; readonly mimeType: "image/png"; readonly imageBase64: string; readonly expiresAtMs: number; readonly pollAfterMs: number };
  "auth.qr.poll": (Session & { readonly state: "waitingScan" | "waitingConfirmation" | "expired" | "rejected" | "cancelled" }) | (Session & { readonly state: "authenticated"; readonly account: PrivateAccount; readonly credential: PrivateCredential });
  "auth.qr.cancel": Session & { readonly state: "cancelled" };
  "auth.credential.restore": { readonly account: PrivateAccount };
  "auth.credential.check": { readonly valid: false } | { readonly valid: true; readonly account: PrivateAccount };
  "auth.credential.refresh": { readonly account: PrivateAccount; readonly credential: PrivateCredential };
  "auth.logout": { readonly upstreamRevoked: boolean };
  "search.songs": PrivatePage<PrivateTrack>;
  "search.playlists": PrivatePage<PrivateContainer>;
  "search.videos": PrivatePage<PrivateVideo>;
  "song.detail": PrivateTrack;
  "video.resolve": PrivateVideo;
  "video.parts": PrivatePage<PrivateTrack> & { readonly bvid: string };
  "library.containers": PrivatePage<PrivateContainer>;
  "library.tracks": PrivatePage<PrivateTrack>;
  "library.videos": PrivatePage<PrivateVideo>;
  "library.likes": PrivatePage<PrivateTrack>;
  "library.likeIds": readonly string[];
  "library.container": PrivateContainer;
  "library.verify": ProviderWriteReceipt;
  "library.setLiked": ProviderWriteReceipt;
  "library.setSubscribed": ProviderWriteReceipt;
  "library.addItems": ProviderWriteReceipt;
  "library.removeItems": ProviderWriteReceipt;
  "lyrics.get": { readonly songId: string; readonly original: string | null; readonly translation: string | null; readonly romanization: string | null };
  "playback.resolve": { readonly track: RawTrackRef; readonly quality: Exclude<ProviderQuality, "auto">; readonly codec: "flac" | "mp3" | "aac"; readonly bitrate: number; readonly url: string; readonly backupUrls?: readonly string[]; readonly dash?: { readonly initialization: string; readonly indexRange: string }; readonly headers: { readonly Referer?: string; readonly "User-Agent"?: string }; readonly expiresInSeconds: number; readonly durationMs: number };
}
export type Method = keyof RequestParams;
export type Request = { [M in Method]: { readonly v: 2; readonly id: string; readonly method: M; readonly params: RequestParams[M] } }[Method];
export type Response<M extends Method> =
  | { readonly v: 2; readonly id: string; readonly ok: true; readonly result: ResultMap[M]; readonly warnings: readonly { readonly code: "items_omitted" | "metadata_incomplete"; readonly count: number }[] }
  | { readonly v: 2; readonly id: string; readonly ok: false; readonly error: { readonly code: ProviderErrorCode; readonly retryable: boolean; readonly retryAfterMs?: number } };
export type Event = { readonly v: 2; readonly event: "auth.qr.progress"; readonly payload: Session & { readonly state: "waitingScan" | "waitingConfirmation" | "expired" | "rejected" } }
  | { readonly v: 2; readonly event: "provider.invalidated"; readonly payload: { readonly code: "credential_invalid" | "authentication_required" } };
