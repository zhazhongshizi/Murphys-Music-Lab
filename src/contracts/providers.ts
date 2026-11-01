/** Renderer-safe multi-provider contract. Private protocol types live in contracts/. */
export type ProviderId = "qqmusic" | "netease" | "bilibili" | "local";
export type OnlineProviderId = Exclude<ProviderId, "local">;
export type NewProviderId = "netease" | "bilibili";
export type ProviderPhase = "disabled" | "starting" | "authenticating" | "restoring" | "ready" | "stopping";
export type ProviderErrorCode =
  | "invalid_params" | "unsupported_capability" | "authentication_required"
  | "credential_invalid" | "network_unavailable" | "rate_limited"
  | "entitlement_denied" | "preview_only" | "media_unavailable" | "unsupported_media"
  | "upstream_schema_changed" | "provider_unavailable" | "outcome_unknown"
  | "verification_failed" | "verification_required" | "cancelled" | "internal_error";
export type ProviderWriteAction =
  | "playlist.create" | "playlist.delete"
  | "song.like" | "song.unlike" | "playlist.subscribe" | "playlist.unsubscribe"
  | "playlist.addTracks" | "playlist.removeTracks"
  | "favorite.addVideos" | "favorite.removeVideos";
export type ProviderQuality = "auto" | "flac" | "320k" | "128k" | "aac";
export type ProviderAvailability = "unknown" | "unavailable" | "authenticationRequired"
  | "deleted" | "permissionDenied" | "processing" | "noAudio";
export interface VideoPartMetadata {
  readonly title: string;
  readonly partTitle: string;
  readonly partNumber: number;
}

export interface AccountRef {
  readonly providerId: OnlineProviderId;
  /** Public upstream account ID; this is never a credential. */
  readonly id: string;
}
export interface ProviderAccount extends AccountRef {
  readonly displayName: string;
}
export interface TrackRef {
  readonly providerId: ProviderId;
  readonly id: string;
}
export interface ProviderCapabilities {
  readonly loginMethods: readonly ("qr" | "qq" | "wx")[];
  readonly searchKinds: readonly ("songs" | "artists" | "albums" | "playlists" | "videos")[];
  readonly libraryKinds: readonly ("created" | "favorite" | "likes")[];
  readonly writeActions: readonly ProviderWriteAction[];
  readonly lyrics: boolean;
  readonly qualities: readonly ProviderQuality[];
}
export type ProviderSnapshot = {
  readonly providerId: OnlineProviderId;
  readonly capabilities: ProviderCapabilities;
} & (
  | { readonly state: "ready"; readonly account: ProviderAccount; readonly persistence: "saved" | "sessionOnly" }
  | { readonly state: Exclude<ProviderPhase, "ready">; readonly error?: ProviderErrorCode; readonly retryAfterMs?: number }
);

/** Additive DTO for new entrypoints; existing QQ/queue DTOs are unchanged in step 1. */
export interface ProviderTrack extends TrackRef {
  readonly title: string;
  readonly artist: string;
  readonly creatorKind: "artist" | "uploader";
  readonly album: string;
  readonly durationMs: number;
  readonly coverCacheKey?: string;
  readonly availability: ProviderAvailability;
  /** Required for Bilibili by the runtime schema; absent for music tracks. */
  readonly video?: VideoPartMetadata;
}
/** A browse result, not a playable TrackRef. Resolve parts before queueing. */
export interface ProviderVideo {
  readonly providerId: "bilibili";
  readonly bvid: string;
  readonly aid: string;
  readonly title: string;
  readonly uploader: string;
  readonly durationMs: number;
  readonly coverCacheKey?: string;
  readonly availability: ProviderAvailability;
}
export interface ProviderContainer {
  readonly providerId: OnlineProviderId;
  readonly id: string;
  readonly kind: "playlist" | "favoriteFolder";
  readonly ownership: "created" | "collected";
  readonly owner: AccountRef;
  readonly title: string;
  readonly description: string;
  readonly itemCount: number;
  readonly allowedActions: readonly ProviderWriteAction[];
}
export interface ProviderPage<T> {
  readonly page: number;
  readonly hasMore: boolean;
  readonly total: number | null;
  readonly items: readonly T[];
}
export interface ProviderWriteReceipt {
  readonly status: "applied" | "verificationPending";
  readonly affectedCount: number | null;
}
export type ProviderWriteOperation =
  | { readonly kind: "setLiked"; readonly trackId: string; readonly liked: boolean }
  | { readonly kind: "setSubscribed"; readonly containerId: string; readonly subscribed: boolean }
  | { readonly kind: "addItems" | "removeItems"; readonly containerId: string; readonly trackIds: readonly string[] };
export interface ProviderWriteRequest {
  readonly providerId: NewProviderId;
  readonly accountId: string;
  readonly operation: ProviderWriteOperation;
}
export interface ProviderQrImage {
  readonly sessionId: string;
  readonly mimeType: "image/png";
  readonly imageBase64: string;
  readonly expiresAtMs: number;
  readonly pollAfterMs: number;
}
export type ProviderQrState =
  | { readonly sessionId: string; readonly state: "waitingScan" | "waitingConfirmation" | "expired" | "rejected" | "cancelled" }
  | { readonly sessionId: string; readonly state: "authenticated"; readonly account: ProviderAccount; readonly persistence: "saved" | "sessionOnly" };
