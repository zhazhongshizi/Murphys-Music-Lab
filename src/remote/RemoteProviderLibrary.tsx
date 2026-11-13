import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import type {
  NewProviderId,
  ProviderContainer,
  ProviderErrorCode,
  ProviderId,
  ProviderPage,
  ProviderSnapshot,
  ProviderTrack,
  ProviderVideo,
} from "../contracts/providers";
import {
  ProviderAdapterError,
  nativeProviderContainer,
  nativeProviderEnqueueTrack,
  nativeProviderEnqueueTracks,
  nativeProviderLibraryContainers,
  nativeProviderLibraryLikes,
  nativeProviderLibraryTracks,
  nativeProviderLibraryVideos,
  nativeProviderResolveVideo,
  nativeProviderSearchPlaylists,
  nativeProviderSearchSongs,
  nativeProviderSearchVideos,
  nativeProviderStatus,
  nativeProviderVideoParts,
  providerTrackToQueueTrack,
} from "../backend/providersAdapter";
import {
  nativeQueueEnqueueNext,
  nativeQueueReplace,
} from "../backend/nativeQueueAdapter";
import { SourceBadge } from "../features/providers/SourceBadge";
import { SOURCE_LABELS } from "../features/providers/DesktopProviders";
import {
  MAX_PROVIDER_BATCH_ITEMS,
  collectBilibiliFolderFirstParts,
  collectPlayableProviderTracks,
  formatProviderAvailability,
  hasBrowsableProviderItems,
  isProviderTrackPlayable,
  isProviderVideoPlayable,
  readAllProviderPages,
} from "../features/providers/providerListHelpers";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../features/player/playerStore";
import { AlbumArtwork, type ArtworkTrack } from "../features/stage/AlbumArtwork";

export interface RemoteProviderLibraryProps {
  readonly providerId: NewProviderId;
  readonly initialTab?: "containers" | "search";
  readonly onBack: () => void;
  readonly onSelectSource: (source: ProviderId) => void;
}

type NeteaseView = "likes" | "created" | "favorite" | "search";
type BilibiliView = "created" | "favorite" | "search";

const ARTWORK_VARIANTS = ["fern", "moon", "tide", "train", "mist"] as const;

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function artworkFromProviderTrack(track: ProviderTrack): ArtworkTrack {
  let hash = 0;
  for (let i = 0; i < track.id.length; i += 1) {
    hash = (hash * 31 + track.id.charCodeAt(i)) | 0;
  }
  const variant = ARTWORK_VARIANTS[Math.abs(hash) % ARTWORK_VARIANTS.length] ?? "fern";
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    accent: track.providerId === "bilibili" ? "#57b8d8" : "#d86b57",
    artworkVariant: variant,
    ...(track.coverCacheKey ? { coverCacheKey: track.coverCacheKey } : {}),
  };
}

export function describeRemoteProviderError(error: unknown): string {
  const code: ProviderErrorCode | string | null =
    error instanceof ProviderAdapterError
      ? error.upstreamCode
      : error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code: string }).code)
        : null;
  switch (code) {
    case "authentication_required":
      return "请在桌面端登录";
    case "credential_invalid":
      return "登录状态已失效，请在桌面端重新扫码登录";
    case "verification_required":
      return "平台要求风险验证，请在桌面端处理后重试";
    case "rate_limited":
      return "当前来源请求过于频繁，请稍后重试（不影响其他来源）";
    case "provider_unavailable":
      return "当前来源正在恢复或暂不可用，请稍后重试";
    case "cancelled":
      return "来源会话已变化，旧代次请求已取消";
    case "entitlement_denied":
      return "当前账号没有此内容的访问权限";
    case "preview_only":
      return "该内容仅提供试听片段，暂不支持完整播放";
    case "unsupported_capability":
      return "远端仅支持只读浏览与播放入队，写操作请在桌面端完成";
    default:
      return error && typeof error === "object" && "userMessage" in error && typeof (error as { userMessage?: unknown }).userMessage === "string"
        ? (error as { userMessage: string }).userMessage
        : "读取来源内容失败，请稍后重试";
  }
}

export function describeNonReadySnapshot(snapshot: ProviderSnapshot): {
  readonly headline: string;
  readonly detail: string;
} {
  if (
    snapshot.state === "restoring" ||
    snapshot.state === "starting" ||
    snapshot.state === "authenticating" ||
    snapshot.state === "stopping"
  ) {
    return {
      headline: "来源正在恢复会话",
      detail: "请在桌面端登录或等待会话恢复完成；远端不会启动未就绪的来源进程。",
    };
  }
  if (snapshot.state === "disabled") {
    switch (snapshot.error) {
      case "credential_invalid":
        return {
          headline: "请在桌面端登录",
          detail: "登录状态已失效，请在桌面端重新扫码登录。",
        };
      case "verification_required":
        return {
          headline: "请在桌面端登录",
          detail: "平台要求完成风险验证，请在桌面端处理后重试。",
        };
      case "rate_limited":
        return {
          headline: "请在桌面端登录",
          detail: "当前来源处于限流冷却中，请稍后在桌面端查看状态。",
        };
      case "provider_unavailable":
      case "network_unavailable":
        return {
          headline: "请在桌面端登录",
          detail: "当前来源服务暂不可用，请在桌面端确认状态后刷新。",
        };
      default:
        return {
          headline: "请在桌面端登录",
          detail: "远端仅支持只读浏览已登录来源，不提供扫码、登录或云端写操作。",
        };
    }
  }
  return {
    headline: "请在桌面端登录",
    detail: "远端仅支持只读浏览已登录来源。",
  };
}

export function RemoteProviderLibrary({
  providerId,
  initialTab = "containers",
  onBack,
  onSelectSource,
}: RemoteProviderLibraryProps) {
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [statusSeq, setStatusSeq] = useState(0);

  const [neteaseView, setNeteaseView] = useState<NeteaseView>(
    initialTab === "search" ? "search" : "likes",
  );
  const [bilibiliView, setBilibiliView] = useState<BilibiliView>(
    initialTab === "search" ? "search" : "created",
  );
  const [searchKind, setSearchKind] = useState<"songs" | "playlists">("songs");
  const [keywordInput, setKeywordInput] = useState("");
  const [submittedKeyword, setSubmittedKeyword] = useState("");
  const [page, setPage] = useState(1);

  const [selectedContainer, setSelectedContainer] = useState<ProviderContainer | null>(null);
  const [containerPage, setContainerPage] = useState(1);
  const [selectedVideo, setSelectedVideo] = useState<ProviderVideo | null>(null);
  const [partPage, setPartPage] = useState(1);

  const [loadingContent, setLoadingContent] = useState(false);
  const [contentError, setContentError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [trackPage, setTrackPage] = useState<ProviderPage<ProviderTrack> | null>(null);
  const [containers, setContainers] = useState<ProviderPage<ProviderContainer> | null>(null);
  const [videoPage, setVideoPage] = useState<ProviderPage<ProviderVideo> | null>(null);
  const [partsPage, setPartsPage] = useState<ProviderPage<ProviderTrack> | null>(null);

  const requestTokenRef = useRef(0);
  const actionTokenRef = useRef(0);

  useEffect(() => () => {
    actionTokenRef.current += 1;
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setStatusLoading(true);
    setStatusError("");
    setSelectedContainer(null);
    setContainerPage(1);
    setSelectedVideo(null);
    setPartPage(1);
    setKeywordInput("");
    setSubmittedKeyword("");
    setPage(1);
    setTrackPage(null);
    setContainers(null);
    setVideoPage(null);
    setPartsPage(null);
    setContentError("");
    setActionNotice("");
    setNeteaseView(initialTab === "search" ? "search" : "likes");
    setBilibiliView(initialTab === "search" ? "search" : "created");
  }, [providerId, initialTab]);

  useEffect(() => {
    let active = true;
    setStatusLoading(true);
    setStatusError("");
    void nativeProviderStatus(providerId).then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setStatusLoading(false);
      },
      (error) => {
        if (!active) return;
        setSnapshot(null);
        setStatusLoading(false);
        setStatusError(describeRemoteProviderError(error));
      },
    );
    return () => {
      active = false;
    };
  }, [providerId, statusSeq]);

  const isReady = snapshot?.state === "ready";
  const accountId = snapshot?.state === "ready" ? snapshot.account.id : "";

  function invalidatePendingActions(clearNotice = false) {
    actionTokenRef.current += 1;
    setActionBusy(false);
    if (clearNotice) {
      setActionNotice("");
    }
  }

  function handlePageChange(setter: (next: number) => void, next: number) {
    invalidatePendingActions(true);
    setter(next);
  }

  useEffect(() => {
    invalidatePendingActions(false);
  }, [
    providerId,
    accountId,
    neteaseView,
    bilibiliView,
    searchKind,
    submittedKeyword,
    page,
    selectedContainer?.id,
    containerPage,
    selectedVideo?.bvid,
    partPage,
  ]);

  useEffect(() => {
    if (!isReady) {
      setTrackPage(null);
      setContainers(null);
      setVideoPage(null);
      setPartsPage(null);
      return;
    }
    const token = ++requestTokenRef.current;
    setLoadingContent(true);
    setContentError("");

    const load = async () => {
      if (providerId === "netease") {
        if (selectedContainer) {
          const [detail, tracks] = await Promise.all([
            nativeProviderContainer("netease", selectedContainer.id).catch(() => selectedContainer),
            nativeProviderLibraryTracks("netease", selectedContainer.id, containerPage, 20),
          ]);
          if (requestTokenRef.current !== token) return;
          setSelectedContainer(detail);
          setTrackPage(tracks);
          return;
        }
        if (neteaseView === "likes") {
          const likes = await nativeProviderLibraryLikes("netease", page, 20);
          if (requestTokenRef.current !== token) return;
          setTrackPage(likes);
          setContainers(null);
          return;
        }
        if (neteaseView === "created" || neteaseView === "favorite") {
          const list = await nativeProviderLibraryContainers("netease", neteaseView, page, 20);
          if (requestTokenRef.current !== token) return;
          setContainers(list);
          setTrackPage(null);
          return;
        }
        if (neteaseView === "search") {
          const kw = submittedKeyword.trim();
          if (!kw) {
            setTrackPage(null);
            setContainers(null);
            return;
          }
          if (searchKind === "songs") {
            const songs = await nativeProviderSearchSongs("netease", kw, page, 20);
            if (requestTokenRef.current !== token) return;
            setTrackPage(songs);
            setContainers(null);
          } else {
            const playlists = await nativeProviderSearchPlaylists("netease", kw, page, 20);
            if (requestTokenRef.current !== token) return;
            setContainers(playlists);
            setTrackPage(null);
          }
          return;
        }
      } else {
        if (selectedVideo) {
          const parts = await nativeProviderVideoParts(selectedVideo.bvid, partPage, 50);
          if (requestTokenRef.current !== token) return;
          setPartsPage(parts);
          return;
        }
        if (selectedContainer) {
          const [detail, videos] = await Promise.all([
            nativeProviderContainer("bilibili", selectedContainer.id).catch(() => selectedContainer),
            nativeProviderLibraryVideos(selectedContainer.id, containerPage, 20),
          ]);
          if (requestTokenRef.current !== token) return;
          setSelectedContainer(detail);
          setVideoPage(videos);
          return;
        }
        if (bilibiliView === "created" || bilibiliView === "favorite") {
          const list = await nativeProviderLibraryContainers("bilibili", bilibiliView, page, 20);
          if (requestTokenRef.current !== token) return;
          setContainers(list);
          setVideoPage(null);
          return;
        }
        if (bilibiliView === "search") {
          const kw = submittedKeyword.trim();
          if (!kw) {
            setVideoPage(null);
            return;
          }
          const videos = await nativeProviderSearchVideos(kw, page, 20);
          if (requestTokenRef.current !== token) return;
          setVideoPage(videos);
          setContainers(null);
        }
      }
    };

    void load().then(
      () => {
        if (requestTokenRef.current === token) {
          setLoadingContent(false);
        }
      },
      (error) => {
        if (requestTokenRef.current !== token) return;
        setLoadingContent(false);
        setContentError(describeRemoteProviderError(error));
        if (
          error instanceof ProviderAdapterError &&
          (error.upstreamCode === "authentication_required" ||
            error.upstreamCode === "credential_invalid" ||
            error.upstreamCode === "cancelled")
        ) {
          setStatusSeq((v) => v + 1);
        }
      },
    );
  }, [
    isReady,
    accountId,
    providerId,
    neteaseView,
    bilibiliView,
    searchKind,
    submittedKeyword,
    page,
    selectedContainer?.id,
    containerPage,
    selectedVideo?.bvid,
    partPage,
  ]);

  async function handleResolveBilibiliInput() {
    if (!isReady || providerId !== "bilibili") return;
    const kw = keywordInput.trim();
    if (!kw) return;
    invalidatePendingActions(true);
    const token = ++requestTokenRef.current;
    setLoadingContent(true);
    setContentError("");
    try {
      const video = await nativeProviderResolveVideo(kw);
      const parts = await nativeProviderVideoParts(video.bvid, 1, 50);
      if (requestTokenRef.current !== token) return;
      setSelectedVideo(video);
      setPartPage(1);
      setPartsPage(parts);
      setLoadingContent(false);
    } catch (error) {
      if (requestTokenRef.current !== token) return;
      setLoadingContent(false);
      setContentError(describeRemoteProviderError(error));
    }
  }

  function formatBatchSummary(skippedUnavailable: number, skippedDuplicates: number, truncated: boolean): string {
    const parts: string[] = [];
    if (skippedUnavailable > 0) parts.push(`跳过 ${skippedUnavailable} 个不可用条目`);
    if (skippedDuplicates > 0) parts.push(`去重 ${skippedDuplicates} 个重复条目`);
    if (truncated) parts.push(`已截取前 ${MAX_PROVIDER_BATCH_ITEMS} 首`);
    return parts.length > 0 ? `（${parts.join("，")}）` : "";
  }

  async function runGuardedAction(
    pendingNotice: string,
    work: (isCurrent: () => boolean) => Promise<void>,
  ) {
    if (actionBusy) return;
    const token = ++actionTokenRef.current;
    const isCurrent = () => actionTokenRef.current === token;
    setActionBusy(true);
    setActionNotice(pendingNotice);
    try {
      await work(isCurrent);
    } catch (error) {
      if (isCurrent()) setActionNotice(describeRemoteProviderError(error));
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function handlePlayTrack(track: ProviderTrack) {
    if (!isProviderTrackPlayable(track)) {
      setActionNotice(`无法播放：${track.title}（${formatProviderAvailability(providerId, track.availability)}）`);
      return;
    }
    await runGuardedAction(`正在准备播放：${track.title}…`, async (isCurrent) => {
      const queue = await nativeProviderEnqueueTrack(track);
      if (!isCurrent()) return;
      await playerActions.hydrateNative(queue);
      if (!isCurrent()) return;
      const started = await playerActions.playTrack(track.id);
      if (!isCurrent()) return;
      setActionNotice(started ? `正在播放：${track.title}` : `已加入队列，但未能启动播放：${track.title}`);
    });
  }

  async function handleEnqueueTrack(track: ProviderTrack) {
    if (!isProviderTrackPlayable(track)) {
      setActionNotice(`无法加入队列：${track.title}（${formatProviderAvailability(providerId, track.availability)}）`);
      return;
    }
    await runGuardedAction(`正在加入队列：${track.title}…`, async (isCurrent) => {
      const queue = await nativeProviderEnqueueTrack(track);
      if (!isCurrent()) return;
      await playerActions.hydrateNative(queue);
      if (!isCurrent()) return;
      setActionNotice(`已加入队列：${track.title}`);
    });
  }

  async function handleEnqueueNextTrack(track: ProviderTrack) {
    if (!isProviderTrackPlayable(track)) {
      setActionNotice(`无法安排下一首：${track.title}（${formatProviderAvailability(providerId, track.availability)}）`);
      return;
    }
    await runGuardedAction(`正在安排下一首：${track.title}…`, async (isCurrent) => {
      const queue = await nativeQueueEnqueueNext(providerTrackToQueueTrack(track));
      if (!isCurrent()) return;
      await playerActions.hydrateNative(queue);
      if (!isCurrent()) return;
      setActionNotice(`下一首播放：${track.title}`);
    });
  }

  async function commitTrackBatch(
    tracks: readonly ProviderTrack[],
    play: boolean,
    truncated = false,
    isCurrent: () => boolean,
    extraSkipped?: { unavailable?: number; duplicates?: number },
  ) {
    const { playable, skippedUnavailable, skippedDuplicates } = collectPlayableProviderTracks(tracks);
    const totalUnavailable = skippedUnavailable + (extraSkipped?.unavailable ?? 0);
    const totalDuplicates = skippedDuplicates + (extraSkipped?.duplicates ?? 0);
    if (!playable.length) {
      if (isCurrent()) setActionNotice("没有可播放条目，队列未修改");
      return;
    }
    const suffix = formatBatchSummary(totalUnavailable, totalDuplicates, truncated);
    if (play) {
      const first = playable[0]!;
      const queue = await nativeQueueReplace(playable.map(providerTrackToQueueTrack));
      if (!isCurrent()) return;
      await playerActions.hydrateNative(queue);
      if (!isCurrent()) return;
      const started = await playerActions.playTrack(first.id);
      if (!isCurrent()) return;
      setActionNotice(
        started
          ? `已替换队列并播放：${first.title}（共 ${playable.length} 首）${suffix}`
          : `已替换队列（${playable.length} 首），但未能启动播放：${first.title}${suffix}`,
      );
      return;
    }
    const queue = await nativeProviderEnqueueTracks(playable);
    if (!isCurrent()) return;
    await playerActions.hydrateNative(queue);
    if (!isCurrent()) return;
    setActionNotice(`已加入队列（${playable.length} 首）${suffix}`);
  }

  async function handlePageBatch(tracks: readonly ProviderTrack[], play: boolean) {
    const playableCount = tracks.filter(isProviderTrackPlayable).length;
    if (!playableCount) {
      setActionNotice("当前页没有可播放条目，队列未修改");
      return;
    }
    await runGuardedAction(
      play ? `正在替换队列并准备播放本页（${playableCount} 首）…` : `正在批量加入本页 ${playableCount} 首曲目…`,
      async (isCurrent) => {
        await commitTrackBatch(tracks, play, false, isCurrent);
      },
    );
  }

  async function handleFullBatch(
    batchContext: "container" | "likes" | "parts",
    pageInfo: ProviderPage<ProviderTrack>,
    play: boolean,
  ) {
    await runGuardedAction(
      play ? "正在读取全部条目并准备替换队列播放…" : "正在读取全部条目以加入队列…",
      async (isCurrent) => {
        const pageSize = batchContext === "parts" ? 100 : 50;
        const read = await readAllProviderPages(
          (nextPage, size) => {
            if (batchContext === "parts" && selectedVideo) {
              return nativeProviderVideoParts(selectedVideo.bvid, nextPage, size);
            }
            if (batchContext === "container" && selectedContainer && providerId === "netease") {
              return nativeProviderLibraryTracks("netease", selectedContainer.id, nextPage, size);
            }
            return nativeProviderLibraryLikes("netease", nextPage, size);
          },
          pageSize,
          isCurrent,
          {
            initialPage: pageInfo.page === 1 && !pageInfo.hasMore ? pageInfo : null,
            verifyCompleteTotal: true,
          },
        );
        if (read.aborted || !isCurrent()) return;
        await commitTrackBatch(read.items, play, read.truncated, isCurrent);
      },
    );
  }

  async function handleBilibiliFolderBatch(pageInfo: ProviderPage<ProviderVideo>, play: boolean) {
    if (!selectedContainer) return;
    const folderId = selectedContainer.id;
    await runGuardedAction(
      play ? "正在读取收藏夹全部视频的首 P 并准备替换队列播放…" : "正在读取收藏夹全部视频的首 P 以加入队列…",
      async (isCurrent) => {
        const result = await collectBilibiliFolderFirstParts(
          (nextPage, size) => nativeProviderLibraryVideos(folderId, nextPage, size),
          (bvid, nextPage, size) => nativeProviderVideoParts(bvid, nextPage, size),
          isCurrent,
          pageInfo.page === 1 ? pageInfo : null,
        );
        if (result.aborted || !isCurrent()) return;
        await commitTrackBatch(
          result.tracks,
          play,
          result.truncated,
          isCurrent,
          {
            unavailable: result.skippedUnavailableVideos,
            duplicates: result.skippedDuplicateVideos,
          },
        );
      },
    );
  }

  async function handleVideoAction(video: ProviderVideo, mode: "play" | "next" | "enqueue") {
    if (!isProviderVideoPlayable(video)) {
      setActionNotice(`无法操作：${video.title}（${formatProviderAvailability("bilibili", video.availability)}）`);
      return;
    }
    await runGuardedAction(`正在读取视频分 P：${video.title}…`, async (isCurrent) => {
      const parts = await nativeProviderVideoParts(video.bvid, 1, 100);
      if (!isCurrent()) return;
      if (!parts.items.length) {
        setActionNotice(`该视频暂无可播放分 P：${video.title}`);
        return;
      }
      if (parts.hasMore || parts.items.length > 1) {
        setSelectedVideo(video);
        setPartPage(1);
        setPartsPage(parts);
        setActionNotice("该视频包含多个分 P，已展开分 P 列表，请选择具体分 P 或点击“播放全部分 P”");
        return;
      }
      const single = parts.items[0]!;
      if (!isProviderTrackPlayable(single)) {
        setActionNotice(`无法播放：${single.title}（${formatProviderAvailability("bilibili", single.availability)}）`);
        return;
      }
      if (mode === "next") {
        const queue = await nativeQueueEnqueueNext(providerTrackToQueueTrack(single));
        if (!isCurrent()) return;
        await playerActions.hydrateNative(queue);
        if (!isCurrent()) return;
        setActionNotice(`下一首播放：${single.title}`);
        return;
      }
      const queue = await nativeProviderEnqueueTrack(single);
      if (!isCurrent()) return;
      await playerActions.hydrateNative(queue);
      if (!isCurrent()) return;
      if (mode === "play") {
        const started = await playerActions.playTrack(single.id);
        if (!isCurrent()) return;
        setActionNotice(started ? `正在播放：${single.title}` : `已加入队列，但未能启动播放：${single.title}`);
      } else {
        setActionNotice(`已加入队列：${single.title}`);
      }
    });
  }

  function renderTrackTable(
    tracks: readonly ProviderTrack[],
    pageInfo: ProviderPage<ProviderTrack>,
    onPageChange: (next: number) => void,
    batchContext: "container" | "likes" | "parts" | "search",
  ) {
    const playableOnPage = tracks.filter(isProviderTrackPlayable);
    const isFullReadContext = batchContext !== "search";
    const playAllLabel = batchContext === "parts" ? "播放全部分 P" : isFullReadContext ? "播放全部" : "播放本页";
    const enqueueAllLabel = batchContext === "parts" ? "全部分 P 加入队列" : isFullReadContext ? "全部加入队列" : "本页全部加入队列";
    return (
      <>
        <div className="remote-provider__toolbar">
          <button
            className="text-button text-button--primary"
            disabled={actionBusy || (batchContext === "search" ? playableOnPage.length === 0 : !hasBrowsableProviderItems(pageInfo))}
            onClick={() => isFullReadContext ? void handleFullBatch(batchContext, pageInfo, true) : void handlePageBatch(tracks, true)}
            type="button"
          >
            <Icon name="play" size={16} />{playAllLabel}
          </button>
          <button
            className="text-button"
            disabled={actionBusy || (batchContext === "search" ? playableOnPage.length === 0 : !hasBrowsableProviderItems(pageInfo))}
            onClick={() => isFullReadContext ? void handleFullBatch(batchContext, pageInfo, false) : void handlePageBatch(tracks, false)}
            type="button"
          >
            {enqueueAllLabel}
          </button>
        </div>
        {tracks.length === 0 ? (
          <div className="catalog-empty">
            <p>暂无可播放条目</p>
            <span>可尝试更换搜索词或切换其他歌单与分 P。</span>
          </div>
        ) : (
          <table className="catalog-table provider-tracks-table remote-provider-tracks-table" aria-label={`${SOURCE_LABELS[providerId]}曲目列表`}>
            <thead>
              <tr>
                <th scope="col">封面</th>
                <th scope="col">标题 / 来源</th>
                <th className="remote-provider__creator-cell" scope="col">创作者 / 专辑</th>
                <th className="remote-provider__duration-cell" scope="col">时长</th>
                <th className="remote-provider__actions-cell" scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => {
                const active = currentTrack?.id === track.id;
                const playable = isProviderTrackPlayable(track);
                const availabilityText = formatProviderAvailability(providerId, track.availability);
                return (
                  <tr
                    key={track.id}
                    className={active ? "catalog-table__row catalog-table__row--selected" : "catalog-table__row"}
                  >
                    <td>
                      <AlbumArtwork compact track={artworkFromProviderTrack(track)} />
                    </td>
                    <td>
                      <div className="catalog-table__title">
                        <strong>{track.video ? `P${track.video.partNumber} · ${track.video.partTitle}` : track.title}</strong>
                        <small>
                          <SourceBadge track={track} />
                          {track.video ? ` · ${track.video.title}` : ""}
                          {!playable ? ` · ${availabilityText}` : ""}
                          <span className="remote-provider__mobile-creator">{` · ${track.artist}`}</span>
                        </small>
                      </div>
                    </td>
                    <td className="remote-provider__creator-cell">
                      <span>{track.artist}</span>
                      {track.album ? <small style={{ display: "block", opacity: 0.7 }}>{track.album}</small> : null}
                    </td>
                    <td className="catalog-table__duration remote-provider__duration-cell">{formatDuration(track.durationMs)}</td>
                    <td className="remote-provider__actions-cell">
                      <div className="remote-provider__row-actions">
                        <button
                          className="text-button text-button--primary"
                          disabled={actionBusy || !playable}
                          onClick={() => void handlePlayTrack(track)}
                          type="button"
                        >
                          播放
                        </button>
                        <button
                          className="text-button"
                          disabled={actionBusy || !playable}
                          onClick={() => void handleEnqueueNextTrack(track)}
                          type="button"
                        >
                          下一首
                        </button>
                        <button
                          className="text-button"
                          disabled={actionBusy || !playable}
                          onClick={() => void handleEnqueueTrack(track)}
                          type="button"
                        >
                          加队列
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="remote-pagination">
          <button
            className="text-button"
            disabled={actionBusy || pageInfo.page <= 1}
            onClick={() => onPageChange(pageInfo.page - 1)}
            type="button"
          >
            上一页
          </button>
          <span>第 {pageInfo.page} 页</span>
          <button
            className="text-button"
            disabled={actionBusy || !pageInfo.hasMore}
            onClick={() => onPageChange(pageInfo.page + 1)}
            type="button"
          >
            下一页
          </button>
        </div>
      </>
    );
  }

  function renderVideoTable(
    videos: readonly ProviderVideo[],
    pageInfo: ProviderPage<ProviderVideo>,
    onPageChange: (next: number) => void,
    emptyTitle: string,
    emptyDetail: string,
    ariaLabel: string,
  ) {
    const showPagination = videos.length > 0 || pageInfo.page > 1 || pageInfo.hasMore;
    return (
      <>
        {videos.length === 0 ? (
          <div className="catalog-empty">
            <p>{emptyTitle}</p>
            <span>{emptyDetail}</span>
          </div>
        ) : (
          <table className="catalog-table provider-tracks-table remote-provider-videos-table" aria-label={ariaLabel}>
            <thead>
              <tr>
                <th scope="col">视频标题</th>
                <th className="remote-provider__creator-cell" scope="col">UP 主 / BV 号</th>
                <th className="remote-provider__duration-cell" scope="col">总时长</th>
                <th className="remote-provider__actions-cell" scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => {
                const playable = isProviderVideoPlayable(video);
                const availabilityText = formatProviderAvailability("bilibili", video.availability);
                return (
                  <tr key={video.bvid} className="catalog-table__row">
                    <td>
                      <div className="catalog-table__title">
                        <strong>{video.title}</strong>
                        <small>
                          {playable ? "单 P 直接操作，多 P 自动展开选择" : availabilityText}
                          <span className="remote-provider__mobile-creator">{` · ${video.uploader} (${video.bvid})`}</span>
                        </small>
                      </div>
                    </td>
                    <td className="remote-provider__creator-cell">
                      <span>{video.uploader}</span>
                      <small style={{ display: "block", opacity: 0.7 }}>{video.bvid}</small>
                    </td>
                    <td className="catalog-table__duration remote-provider__duration-cell">{formatDuration(video.durationMs)}</td>
                    <td className="remote-provider__actions-cell">
                      <div className="remote-provider__row-actions">
                        <button
                          className="text-button text-button--primary"
                          disabled={actionBusy || !playable}
                          onClick={() => void handleVideoAction(video, "play")}
                          type="button"
                        >
                          播放
                        </button>
                        <button
                          className="text-button"
                          disabled={actionBusy || !playable}
                          onClick={() => void handleVideoAction(video, "next")}
                          type="button"
                        >
                          下一首
                        </button>
                        <button
                          className="text-button"
                          disabled={actionBusy || !playable}
                          onClick={() => void handleVideoAction(video, "enqueue")}
                          type="button"
                        >
                          加队列
                        </button>
                        <button
                          className="text-button"
                          disabled={actionBusy}
                          onClick={() => {
                            invalidatePendingActions(true);
                            setSelectedVideo(video);
                            setPartPage(1);
                          }}
                          type="button"
                        >
                          查看分 P
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {showPagination ? (
          <div className="remote-pagination">
            <button
              className="text-button"
              disabled={actionBusy || pageInfo.page <= 1}
              onClick={() => onPageChange(pageInfo.page - 1)}
              type="button"
            >
              上一页
            </button>
            <span>第 {pageInfo.page} 页</span>
            <button
              className="text-button"
              disabled={actionBusy || !pageInfo.hasMore}
              onClick={() => onPageChange(pageInfo.page + 1)}
              type="button"
            >
              下一页
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <main className="library-workspace remote-provider-workspace" id="main-content">
      <aside className="library-sidebar" aria-label="多平台曲库导航">
        <button className="library-sidebar__back" onClick={onBack} type="button">
          <Icon name="back" size={17} />返回舞台
        </button>
        <nav aria-label="来源与栏目">
          <div>
            <span className="library-sidebar__group">来源切换</span>
            {(["qqmusic", "netease", "bilibili", "local"] as const).map((sourceId) => (
              <button
                key={sourceId}
                aria-current={sourceId === providerId ? "page" : undefined}
                className={
                  sourceId === providerId
                    ? "library-sidebar__item library-sidebar__item--active"
                    : "library-sidebar__item"
                }
                onClick={() => onSelectSource(sourceId)}
                type="button"
              >
                <span>{SOURCE_LABELS[sourceId]}</span>
              </button>
            ))}
          </div>
          {isReady && providerId === "netease" ? (
            <div>
              <span className="library-sidebar__group">网易云只读曲库</span>
              {([
                ["likes", "我喜欢的音乐"],
                ["created", "创建的歌单"],
                ["favorite", "收藏的歌单"],
                ["search", "搜索歌曲与歌单"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  aria-current={!selectedContainer && neteaseView === id ? "page" : undefined}
                  className={
                    !selectedContainer && neteaseView === id
                      ? "library-sidebar__item library-sidebar__item--active"
                      : "library-sidebar__item"
                  }
                  onClick={() => {
                    invalidatePendingActions(true);
                    setSelectedContainer(null);
                    setContainerPage(1);
                    setPage(1);
                    setNeteaseView(id);
                  }}
                  type="button"
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {isReady && providerId === "bilibili" ? (
            <div>
              <span className="library-sidebar__group">Bilibili 只读曲库</span>
              {([
                ["created", "创建的收藏夹"],
                ["favorite", "订阅的收藏夹"],
                ["search", "搜索 / BV 解析"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  aria-current={!selectedContainer && !selectedVideo && bilibiliView === id ? "page" : undefined}
                  className={
                    !selectedContainer && !selectedVideo && bilibiliView === id
                      ? "library-sidebar__item library-sidebar__item--active"
                      : "library-sidebar__item"
                  }
                  onClick={() => {
                    invalidatePendingActions(true);
                    setSelectedVideo(null);
                    setPartPage(1);
                    setSelectedContainer(null);
                    setContainerPage(1);
                    setPage(1);
                    setBilibiliView(id);
                  }}
                  type="button"
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </nav>
        <div className="library-sidebar__foot">
          <span>远端只读目录</span>
          <strong>{providerId === "netease" ? "NETEASE / READONLY" : "BILIBILI / READONLY"}</strong>
        </div>
      </aside>

      <section className="catalog-pane">
        <header className="catalog-pane__header">
          <div>
            <span className="section-label">REMOTE MULTI-PROVIDER · READ ONLY</span>
            <h1>
              {selectedVideo
                ? `${selectedVideo.title}（${selectedVideo.bvid}）`
                : selectedContainer
                  ? selectedContainer.title
                  : `${SOURCE_LABELS[providerId]} · 远端浏览`}
            </h1>
            <p>
              {isReady && snapshot
                ? `已登录账号：${snapshot.account.displayName || snapshot.account.id} · 远端仅支持只读浏览、搜索、展开分 P 与入队播放`
                : `${SOURCE_LABELS[providerId]} · 桌面端受控会话`}
            </p>
          </div>
          <div className="playlist-detail__actions">
            {selectedVideo ? (
              <button
                className="text-button playlist-detail__back"
                onClick={() => {
                  invalidatePendingActions(true);
                  setSelectedVideo(null);
                  setPartsPage(null);
                  setPartPage(1);
                }}
                type="button"
              >
                <Icon name="back" size={16} />返回视频列表
              </button>
            ) : selectedContainer ? (
              <button
                className="text-button playlist-detail__back"
                onClick={() => {
                  invalidatePendingActions(true);
                  setSelectedContainer(null);
                  setTrackPage(null);
                  setVideoPage(null);
                  setContainerPage(1);
                }}
                type="button"
              >
                <Icon name="back" size={16} />{providerId === "netease" ? "返回歌单列表" : "返回收藏夹列表"}
              </button>
            ) : null}
            <button
              className="text-button"
              onClick={() => {
                invalidatePendingActions(true);
                setStatusSeq((v) => v + 1);
              }}
              type="button"
            >
              刷新来源状态
            </button>
          </div>
        </header>

        {actionNotice ? (
          <p className="catalog-inspector__notice" role="status">
            {actionNotice}
          </p>
        ) : null}

        {statusLoading ? (
          <div aria-live="polite" className="catalog-empty">
            <p>正在读取来源状态</p>
            <span>正在确认桌面端 {SOURCE_LABELS[providerId]} 会话状态…</span>
          </div>
        ) : statusError ? (
          <div role="alert" className="catalog-empty">
            <p>{statusError}</p>
            <span>请在桌面端确认来源状态后点击刷新。</span>
            <button className="text-button text-button--primary" onClick={() => setStatusSeq((v) => v + 1)} type="button">
              重试状态查询
            </button>
          </div>
        ) : !snapshot || snapshot.state !== "ready" ? (
          <div role="status" className="catalog-empty">
            {(() => {
              const info = snapshot ? describeNonReadySnapshot(snapshot) : { headline: "请在桌面端登录", detail: "远端仅支持只读浏览已登录来源。" };
              return (
                <>
                  <p>{info.headline}</p>
                  <span>{info.detail}</span>
                </>
              );
            })()}
          </div>
        ) : (
          <>
            {((providerId === "netease" && neteaseView === "search" && !selectedContainer) ||
              (providerId === "bilibili" && bilibiliView === "search" && !selectedContainer && !selectedVideo)) ? (
              <form
                className="remote-provider__search"
                onSubmit={(event) => {
                  event.preventDefault();
                  invalidatePendingActions(true);
                  setPage(1);
                  setSubmittedKeyword(keywordInput.trim());
                }}
              >
                <label className="catalog-search">
                  <Icon name="search" size={18} />
                  <span className="sr-only">
                    {providerId === "netease" ? "搜索网易云歌曲或歌单" : "搜索 Bilibili 视频或输入 BV/AV 号"}
                  </span>
                  <input
                    maxLength={200}
                    onChange={(event) => setKeywordInput(event.currentTarget.value)}
                    placeholder={
                      providerId === "netease"
                        ? "搜索网易云歌曲或歌单…"
                        : "搜索 Bilibili 视频，或输入 BV/AV 号与链接…"
                    }
                    type="search"
                    value={keywordInput}
                  />
                </label>
                <div className="remote-provider__search-actions">
                  {providerId === "netease" ? (
                    <>
                      <button
                        aria-pressed={searchKind === "songs"}
                        className="text-button"
                        onClick={() => {
                          invalidatePendingActions(true);
                          setSearchKind("songs");
                          setPage(1);
                        }}
                        type="button"
                      >
                        单曲
                      </button>
                      <button
                        aria-pressed={searchKind === "playlists"}
                        className="text-button"
                        onClick={() => {
                          invalidatePendingActions(true);
                          setSearchKind("playlists");
                          setPage(1);
                        }}
                        type="button"
                      >
                        歌单
                      </button>
                      <button className="text-button text-button--primary" type="submit">
                        搜索
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="text-button text-button--primary" type="submit">
                        搜索视频
                      </button>
                      <button
                        className="text-button"
                        onClick={() => void handleResolveBilibiliInput()}
                        type="button"
                      >
                        解析 BV/AV 并展开分 P
                      </button>
                    </>
                  )}
                </div>
              </form>
            ) : null}

            {loadingContent ? (
              <div aria-live="polite" className="catalog-empty">
                <p>正在读取内容</p>
                <span>按页只读加载，不修改云端曲库。</span>
              </div>
            ) : contentError ? (
              <div role="alert" className="catalog-empty">
                <p>{contentError}</p>
                <span>请稍后重试或在桌面端检查来源状态。</span>
              </div>
            ) : providerId === "netease" ? (
              selectedContainer && trackPage ? (
                renderTrackTable(trackPage.items, trackPage, (next) => handlePageChange(setContainerPage, next), "container")
              ) : neteaseView === "likes" && trackPage ? (
                renderTrackTable(trackPage.items, trackPage, (next) => handlePageChange(setPage, next), "likes")
              ) : neteaseView === "search" && searchKind === "songs" ? (
                trackPage ? (
                  renderTrackTable(trackPage.items, trackPage, (next) => handlePageChange(setPage, next), "search")
                ) : (
                  <div className="catalog-empty">
                    <p>输入关键词搜索网易云单曲</p>
                    <span>搜索结果可直接加入队列或立即在电脑端播放。</span>
                  </div>
                )
              ) : containers ? (
                containers.items.length === 0 ? (
                  <div className="catalog-empty">
                    <p>暂无歌单</p>
                    <span>当前账号或搜索条件下没有可展示的歌单。</span>
                  </div>
                ) : (
                  <>
                    <div className="playlist-grid">
                      {containers.items.map((container) => (
                        <article key={container.id} className="playlist-card">
                          <div>
                            <strong>{container.title}</strong>
                            <p>{container.itemCount !== null ? `${container.itemCount} 首歌曲` : "网易云歌单"}</p>
                          </div>
                          <button
                            className="text-button text-button--primary"
                            onClick={() => {
                              invalidatePendingActions(true);
                              setSelectedContainer(container);
                              setContainerPage(1);
                            }}
                            type="button"
                          >
                            查看曲目
                          </button>
                        </article>
                      ))}
                    </div>
                    <div className="remote-pagination">
                      <button
                        className="text-button"
                        disabled={containers.page <= 1}
                        onClick={() => handlePageChange(setPage, containers.page - 1)}
                        type="button"
                      >
                        上一页
                      </button>
                      <span>第 {containers.page} 页</span>
                      <button
                        className="text-button"
                        disabled={!containers.hasMore}
                        onClick={() => handlePageChange(setPage, containers.page + 1)}
                        type="button"
                      >
                        下一页
                      </button>
                    </div>
                  </>
                )
              ) : (
                <div className="catalog-empty">
                  <p>输入关键词搜索网易云歌单</p>
                  <span>打开歌单后可按页浏览曲目并加入播放队列。</span>
                </div>
              )
            ) : selectedVideo && partsPage ? (
              renderTrackTable(partsPage.items, partsPage, (next) => handlePageChange(setPartPage, next), "parts")
            ) : selectedContainer && !selectedVideo && videoPage ? (
              <>
                <div className="remote-provider__toolbar">
                  <button
                    className="text-button text-button--primary"
                    disabled={actionBusy || !hasBrowsableProviderItems(videoPage)}
                    onClick={() => void handleBilibiliFolderBatch(videoPage, true)}
                    type="button"
                  >
                    <Icon name="play" size={16} />播放全部
                  </button>
                  <button
                    className="text-button"
                    disabled={actionBusy || !hasBrowsableProviderItems(videoPage)}
                    onClick={() => void handleBilibiliFolderBatch(videoPage, false)}
                    type="button"
                  >
                    全部加入队列
                  </button>
                </div>
                {renderVideoTable(
                  videoPage.items,
                  videoPage,
                  (next) => handlePageChange(setContainerPage, next),
                  "收藏夹暂无视频",
                  "此收藏夹中没有可显示的视频条目。",
                  "Bilibili 视频列表",
                )}
              </>
            ) : bilibiliView === "search" ? (
              videoPage ? (
                renderVideoTable(
                  videoPage.items,
                  videoPage,
                  (next) => handlePageChange(setPage, next),
                  "未找到匹配的 Bilibili 视频",
                  "可尝试其他关键词，或直接输入 BV/AV 号解析分 P。",
                  "Bilibili 搜索结果",
                )
              ) : (
                <div className="catalog-empty">
                  <p>搜索 Bilibili 视频或直接解析 BV/AV 号</p>
                  <span>选择视频展开分 P 后，可将单个分 P 或全部分 P 加入播放队列。</span>
                </div>
              )
            ) : containers ? (
              containers.items.length === 0 ? (
                <div className="catalog-empty">
                  <p>暂无收藏夹</p>
                  <span>当前账号下没有可展示的 Bilibili 收藏夹。</span>
                </div>
              ) : (
                <>
                  <div className="playlist-grid">
                    {containers.items.map((container) => (
                      <article key={container.id} className="playlist-card">
                        <div>
                          <strong>{container.title}</strong>
                          <p>{container.itemCount !== null ? `${container.itemCount} 个视频` : "Bilibili 收藏夹"}</p>
                        </div>
                        <button
                          className="text-button text-button--primary"
                          onClick={() => {
                            invalidatePendingActions(true);
                            setSelectedContainer(container);
                            setContainerPage(1);
                          }}
                          type="button"
                        >
                          查看视频
                        </button>
                      </article>
                    ))}
                  </div>
                  <div className="remote-pagination">
                    <button
                      className="text-button"
                      disabled={containers.page <= 1}
                      onClick={() => handlePageChange(setPage, containers.page - 1)}
                      type="button"
                    >
                      上一页
                    </button>
                    <span>第 {containers.page} 页</span>
                    <button
                      className="text-button"
                      disabled={!containers.hasMore}
                      onClick={() => handlePageChange(setPage, containers.page + 1)}
                      type="button"
                    >
                      下一页
                    </button>
                  </div>
                </>
              )
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
