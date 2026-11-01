import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_COMMANDS,
  ProviderAdapterError,
  nativeProviderCancel,
  nativeProviderEnqueueTrack,
  nativeProviderLibraryContainers,
  nativeProviderLibraryLikes,
  nativeProviderLibraryTracks,
  nativeProviderLogin,
  nativeProviderLogout,
  nativeProviderPoll,
  nativeProviderRestore,
  nativeProviderSearchPlaylists,
  nativeProviderSearchSongs,
  nativeProviderSongDetail,
  nativeProviderStatus,
  parseProviderContainer,
  parseProviderContainerPage,
  parseProviderQrImage,
  parseProviderQrState,
  parseProviderSnapshot,
  parseProviderTrack,
  parseProviderTrackPage,
  providerTrackToQueueTrack,
} from "./providersAdapter";
import { parseQueueTrack, QueueAdapterError } from "./nativeQueueAdapter";
import { invalidateProviderSession } from "./providerSessions";
import { playerErrorFromInvoke } from "./nativePlayerAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

const NETEASE_TRACK = {
  providerId: "netease",
  id: "netease:track:1901371647",
  title: "孤勇者",
  artist: "陈奕迅",
  creatorKind: "artist",
  album: "孤勇者",
  durationMs: 256_000,
  availability: "unknown",
} as const;

const NETEASE_CONTAINER = {
  providerId: "netease",
  id: "netease:playlist:24381616",
  kind: "playlist",
  ownership: "created",
  owner: { providerId: "netease", id: "123456" },
  title: "我喜欢的音乐",
  description: "",
  itemCount: 42,
  allowedActions: [],
} as const;

const READY_SNAPSHOT = {
  providerId: "netease",
  capabilities: {
    loginMethods: ["qr"],
    searchKinds: ["songs", "playlists"],
    libraryKinds: ["created", "favorite", "likes"],
    writeActions: [],
    lyrics: true,
    qualities: ["auto", "flac", "320k", "128k"],
  },
  state: "ready",
  account: {
    providerId: "netease",
    id: "123456",
    displayName: "测试账号",
  },
  persistence: "saved",
} as const;

describe("multi-provider stage 3b adapter", () => {
  it("discards a delayed local status response after a provider account revision", async () => {
    let resolve!: (value: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const request = nativeProviderStatus("netease");
    invalidateProviderSession("netease");
    resolve(READY_SNAPSHOT);
    await expect(request).rejects.toMatchObject({ upstreamCode: "cancelled" });
  });
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => {
    setTauriRuntime(false);
  });

  it("validates public ProviderTrack, ProviderContainer, and ProviderPage DTOs strictly", () => {
    expect(parseProviderTrack(NETEASE_TRACK)).toEqual(NETEASE_TRACK);
    expect(parseProviderContainer(NETEASE_CONTAINER)).toEqual(NETEASE_CONTAINER);

    const trackPage = {
      page: 1,
      hasMore: false,
      total: 1,
      items: [NETEASE_TRACK],
    };
    expect(parseProviderTrackPage(trackPage)).toEqual(trackPage);

    const containerPage = {
      page: 1,
      hasMore: false,
      total: 1,
      items: [NETEASE_CONTAINER],
    };
    expect(parseProviderContainerPage(containerPage)).toEqual(containerPage);

    // Rejects top-level providerId on ProviderPage
    expect(() =>
      parseProviderTrackPage({ ...trackPage, providerId: "netease" }),
    ).toThrow(ProviderAdapterError);

    // Rejects missing creatorKind, mediaMid, null coverCacheKey, or leaked url/credential
    const { creatorKind: _omit, ...missingCreator } = NETEASE_TRACK;
    expect(() => parseProviderTrack(missingCreator)).toThrow(ProviderAdapterError);
    expect(() => parseProviderTrack({ ...NETEASE_TRACK, mediaMid: null })).toThrow(
      ProviderAdapterError,
    );
    expect(() => parseProviderTrack({ ...NETEASE_TRACK, coverCacheKey: null })).toThrow(
      ProviderAdapterError,
    );
    expect(() =>
      parseProviderTrack({ ...NETEASE_TRACK, url: "https://m801.music.126.net/a.mp3" }),
    ).toThrow(ProviderAdapterError);

    // Rejects legacy ownerId instead of owner: { providerId, id }
    const { owner: _owner, ...legacyContainer } = NETEASE_CONTAINER;
    expect(() =>
      parseProviderContainer({ ...legacyContainer, ownerId: "123456" }),
    ).toThrow(ProviderAdapterError);
  });

  it("explicitly converts ProviderTrack to QueueTrack for mixed-queue enqueueing", async () => {
    // Raw ProviderTrack has creatorKind and availability, which QueueTrack rejects
    expect(() => parseQueueTrack(NETEASE_TRACK)).toThrow(QueueAdapterError);

    const queueTrack = providerTrackToQueueTrack(NETEASE_TRACK);
    expect(queueTrack).toEqual({
      providerId: "netease",
      id: "netease:track:1901371647",
      title: "孤勇者",
      artist: "陈奕迅",
      album: "孤勇者",
      durationMs: 256_000,
    });
    expect(parseQueueTrack(queueTrack)).toEqual(queueTrack);

    const snapshot = { generation: 1, selectedIndex: 0, items: [queueTrack] };
    invokeMock.mockResolvedValueOnce(snapshot);
    expect(await nativeProviderEnqueueTrack(NETEASE_TRACK)).toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("queue_enqueue", { item: queueTrack });
  });

  it("invokes NetEase auth, status, and read commands through desktop IPC", async () => {
    invokeMock.mockResolvedValueOnce(READY_SNAPSHOT);
    expect(await nativeProviderStatus("netease")).toEqual(READY_SNAPSHOT);
    expect(invokeMock).toHaveBeenCalledWith(PROVIDER_COMMANDS.status, {
      providerId: "netease",
    });

    const qr = {
      sessionId: "session-1",
      mimeType: "image/png",
      imageBase64: "iVBORw0KGgo=",
      expiresAtMs: 1_700_000_000_000,
      pollAfterMs: 3_000,
    } as const;
    invokeMock.mockResolvedValueOnce(qr);
    expect(await nativeProviderLogin("netease")).toEqual(qr);
    expect(parseProviderQrImage(qr)).toEqual(qr);

    const pollState = {
      sessionId: "session-1",
      state: "authenticated",
      account: READY_SNAPSHOT.account,
      persistence: "saved",
    } as const;
    invokeMock.mockResolvedValueOnce(pollState);
    expect(await nativeProviderPoll("netease", "session-1")).toEqual(pollState);
    expect(parseProviderQrState(pollState)).toEqual(pollState);

    invokeMock.mockResolvedValueOnce(null);
    await nativeProviderCancel("netease", "session-1");
    expect(invokeMock).toHaveBeenCalledWith(PROVIDER_COMMANDS.cancel, {
      providerId: "netease",
      sessionId: "session-1",
    });

    invokeMock.mockResolvedValueOnce(true);
    expect(await nativeProviderRestore("netease")).toBe(true);

    invokeMock.mockResolvedValueOnce(null);
    await nativeProviderLogout("netease");
    expect(invokeMock).toHaveBeenCalledWith(PROVIDER_COMMANDS.logout, {
      providerId: "netease",
    });

    const songsPage = { page: 1, hasMore: false, total: 1, items: [NETEASE_TRACK] };
    invokeMock.mockResolvedValueOnce(songsPage);
    expect(await nativeProviderSearchSongs("netease", "孤勇者", 1, 20)).toEqual(songsPage);
    expect(invokeMock).toHaveBeenCalledWith(PROVIDER_COMMANDS.read, {
      providerId: "netease",
      method: "search.songs",
      params: { keyword: "孤勇者", page: 1, pageSize: 20 },
    });

    const playlistsPage = { page: 1, hasMore: false, total: 1, items: [NETEASE_CONTAINER] };
    invokeMock.mockResolvedValueOnce(playlistsPage);
    expect(await nativeProviderSearchPlaylists("netease", "喜欢", 1, 20)).toEqual(
      playlistsPage,
    );

    invokeMock.mockResolvedValueOnce(NETEASE_TRACK);
    expect(
      await nativeProviderSongDetail("netease", "netease:track:1901371647"),
    ).toEqual(NETEASE_TRACK);

    invokeMock.mockResolvedValueOnce(playlistsPage);
    expect(
      await nativeProviderLibraryContainers("netease", "created", 1, 20),
    ).toEqual(playlistsPage);

    invokeMock.mockResolvedValueOnce(songsPage);
    expect(
      await nativeProviderLibraryTracks("netease", "netease:playlist:24381616", 1, 20),
    ).toEqual(songsPage);

    invokeMock.mockResolvedValueOnce(songsPage);
    expect(await nativeProviderLibraryLikes("netease", 1, 20)).toEqual(songsPage);
  });

  it("maps provider and playback error codes including preview_only and verification_required", async () => {
    invokeMock.mockRejectedValueOnce("verification_required");
    await expect(nativeProviderSearchSongs("netease", "test")).rejects.toMatchObject({
      code: "QMG-PROVIDER-001",
      upstreamCode: "verification_required",
    });

    invokeMock.mockRejectedValueOnce("provider_v2_Cooldown");
    await expect(nativeProviderRestore("netease")).rejects.toMatchObject({
      code: "QMG-PROVIDER-001",
      upstreamCode: "rate_limited",
    });

    const disabledSnapshot = parseProviderSnapshot({
      providerId: "netease",
      capabilities: READY_SNAPSHOT.capabilities,
      state: "disabled",
      error: "rate_limited",
      retryAfterMs: 60_000,
    });
    expect(disabledSnapshot.state).toBe("disabled");

    const previewErr = playerErrorFromInvoke({
      code: "preview_only",
      retryable: false,
      operation: "playback",
      correlationId: "12345678-1234-1234-1234-123456789abc",
      userMessage: "该歌曲仅提供试听，暂不能完整播放",
    });
    expect(previewErr.reason).toBe("entitlement");

    const verifyErr = playerErrorFromInvoke({
      code: "verification_required",
      retryable: false,
      operation: "playback",
      correlationId: "12345678-1234-1234-1234-123456789abc",
      userMessage: "平台要求完成验证，请在官方客户端处理后重试",
    });
    expect(verifyErr.reason).toBe("authentication");
  });
});
