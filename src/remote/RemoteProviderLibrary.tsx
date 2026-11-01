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
  const [actionNotice, setActionNotice] = useState("");
  const [trackPage, setTrackPage] = useState<ProviderPage<ProviderTrack> | null>(null);
  const [containers, setContainers] = useState<ProviderPage<ProviderContainer> | null>(null);
  const [videoPage, setVideoPage] = useState<ProviderPage<ProviderVideo> | null>(null);
  const [partsPage, setPartsPage] = useState<ProviderPage<ProviderTrack> | null>(null);

  const requestTokenRef = useRef(0);

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

  async function handlePlayTrack(track: ProviderTrack) {
    setActionNotice(`正在准备播放：${track.title}…`);
    try {
      const queue = await nativeProviderEnqueueTrack(track);
      await playerActions.hydrateNative(queue);
      const started = await playerActions.playTrack(track.id);
      setActionNotice(started ? `正在播放：${track.title}` : `播放未完成：${track.title}`);
    } catch (error) {
      setActionNotice(describeRemoteProviderError(error));
    }
  }

  async function handleEnqueueTrack(track: ProviderTrack) {
    setActionNotice(`正在加入队列：${track.title}…`);
    try {
      const queue = await nativeProviderEnqueueTrack(track);
      await playerActions.hydrateNative(queue);
      setActionNotice(`已加入队列：${track.title}`);
    } catch (error) {
      setActionNotice(describeRemoteProviderError(error));
    }
  }

  async function handleEnqueueNextTrack(track: ProviderTrack) {
    setActionNotice(`正在安排下一首：${track.title}…`);
    try {
      const queue = await nativeQueueEnqueueNext(providerTrackToQueueTrack(track));
      await playerActions.hydrateNative(queue);
      setActionNotice(`下一首播放：${track.title}`);
    } catch (error) {
      setActionNotice(describeRemoteProviderError(error));
    }
  }

  async function handleEnqueueAll(tracks: readonly ProviderTrack[]) {
    if (!tracks.length) return;
    setActionNotice(`正在批量加入 ${tracks.length} 首曲目…`);
    try {
      const queue = await nativeProviderEnqueueTracks(tracks);
      await playerActions.hydrateNative(queue);
      setActionNotice(`已加入队列（${tracks.length} 首）`);
    } catch (error) {
      setActionNotice(describeRemoteProviderError(error));
    }
  }

  async function handleReplaceQueue(tracks: readonly ProviderTrack[]) {
    if (!tracks.length) return;
    const first = tracks[0]!;
    setActionNotice(`正在替换队列并播放：${first.title}…`);
    try {
      const queue = await nativeQueueReplace(tracks.map(providerTrackToQueueTrack));
      await playerActions.hydrateNative(queue);
      await playerActions.playTrack(first.id);
      setActionNotice(`已替换队列并播放：${first.title}`);
    } catch (error) {
      setActionNotice(describeRemoteProviderError(error));
    }
  }

  function renderTrackTable(tracks: readonly ProviderTrack[], pageInfo: ProviderPage<ProviderTrack>, onPageChange: (next: number) => void) {
    return (
      <>
        <div className="remote-provider__toolbar">
          <button
            className="text-button text-button--primary"
            disabled={tracks.length === 0}
            onClick={() => void handleReplaceQueue(tracks)}
            type="button"
          >
            <Icon name="play" size={16} />替换队列并播放本页
          </button>
          <button
            className="text-button"
            disabled={tracks.length === 0}
            onClick={() => void handleEnqueueAll(tracks)}
            type="button"
          >
            本页全部加入队列
          </button>
        </div>
        {tracks.length === 0 ? (
          <div className="catalog-empty">
            <p>暂无可播放条目</p>
            <span>可尝试更换搜索词或切换其他歌单与分 P。</span>
          </div>
        ) : (
          <table className="catalog-table" aria-label={`${SOURCE_LABELS[providerId]}曲目列表`}>
            <thead>
              <tr>
                <th scope="col">封面</th>
                <th scope="col">标题 / 来源</th>
                <th scope="col">创作者 / 专辑</th>
                <th scope="col">时长</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => {
                const active = currentTrack?.id === track.id;
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
                        </small>
                      </div>
                    </td>
                    <td>
                      <span>{track.artist}</span>
                      {track.album ? <small style={{ display: "block", opacity: 0.7 }}>{track.album}</small> : null}
                    </td>
                    <td className="catalog-table__duration">{formatDuration(track.durationMs)}</td>
                    <td>
                      <div className="remote-provider__row-actions">
                        <button className="text-button text-button--primary" onClick={() => void handlePlayTrack(track)} type="button">
                          播放
                        </button>
                        <button className="text-button" onClick={() => void handleEnqueueNextTrack(track)} type="button">
                          下一首
                        </button>
                        <button className="text-button" onClick={() => void handleEnqueueTrack(track)} type="button">
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
            disabled={pageInfo.page <= 1}
            onClick={() => onPageChange(pageInfo.page - 1)}
            type="button"
          >
            上一页
          </button>
          <span>第 {pageInfo.page} 页</span>
          <button
            className="text-button"
            disabled={!pageInfo.hasMore}
            onClick={() => onPageChange(pageInfo.page + 1)}
            type="button"
          >
            下一页
          </button>
        </div>
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
                  setSelectedContainer(null);
                  setTrackPage(null);
                  setVideoPage(null);
                  setContainerPage(1);
                }}
                type="button"
              >
                <Icon name="back" size={16} />返回列表
              </button>
            ) : null}
            <button
              className="text-button"
              onClick={() => setStatusSeq((v) => v + 1)}
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
                renderTrackTable(trackPage.items, trackPage, setContainerPage)
              ) : neteaseView === "likes" && trackPage ? (
                renderTrackTable(trackPage.items, trackPage, setPage)
              ) : neteaseView === "search" && searchKind === "songs" ? (
                trackPage ? (
                  renderTrackTable(trackPage.items, trackPage, setPage)
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
                        onClick={() => setPage(containers.page - 1)}
                        type="button"
                      >
                        上一页
                      </button>
                      <span>第 {containers.page} 页</span>
                      <button
                        className="text-button"
                        disabled={!containers.hasMore}
                        onClick={() => setPage(containers.page + 1)}
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
              renderTrackTable(partsPage.items, partsPage, setPartPage)
            ) : selectedContainer && videoPage ? (
              videoPage.items.length === 0 ? (
                <div className="catalog-empty">
                  <p>收藏夹暂无视频</p>
                  <span>此收藏夹中没有可显示的视频条目。</span>
                </div>
              ) : (
                <>
                  <table className="catalog-table" aria-label="Bilibili 视频列表">
                    <thead>
                      <tr>
                        <th scope="col">视频标题</th>
                        <th scope="col">UP 主 / BV 号</th>
                        <th scope="col">总时长</th>
                        <th scope="col">分 P 操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videoPage.items.map((video) => (
                        <tr key={video.bvid} className="catalog-table__row">
                          <td>
                            <div className="catalog-table__title">
                              <strong>{video.title}</strong>
                              <small>视频摘要需先展开分 P 后入队播放</small>
                            </div>
                          </td>
                          <td>
                            <span>{video.uploader}</span>
                            <small style={{ display: "block", opacity: 0.7 }}>{video.bvid}</small>
                          </td>
                          <td className="catalog-table__duration">{formatDuration(video.durationMs)}</td>
                          <td>
                            <button
                              className="text-button text-button--primary"
                              onClick={() => {
                                setSelectedVideo(video);
                                setPartPage(1);
                              }}
                              type="button"
                            >
                              展开分 P
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="remote-pagination">
                    <button
                      className="text-button"
                      disabled={videoPage.page <= 1}
                      onClick={() => setContainerPage(videoPage.page - 1)}
                      type="button"
                    >
                      上一页
                    </button>
                    <span>第 {videoPage.page} 页</span>
                    <button
                      className="text-button"
                      disabled={!videoPage.hasMore}
                      onClick={() => setContainerPage(videoPage.page + 1)}
                      type="button"
                    >
                      下一页
                    </button>
                  </div>
                </>
              )
            ) : bilibiliView === "search" ? (
              videoPage ? (
                videoPage.items.length === 0 ? (
                  <div className="catalog-empty">
                    <p>未找到匹配的 Bilibili 视频</p>
                    <span>可尝试其他关键词，或直接输入 BV/AV 号解析分 P。</span>
                  </div>
                ) : (
                  <>
                    <table className="catalog-table" aria-label="Bilibili 搜索结果">
                      <thead>
                        <tr>
                          <th scope="col">视频标题</th>
                          <th scope="col">UP 主 / BV 号</th>
                          <th scope="col">总时长</th>
                          <th scope="col">分 P 操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {videoPage.items.map((video) => (
                          <tr key={video.bvid} className="catalog-table__row">
                            <td>
                              <div className="catalog-table__title">
                                <strong>{video.title}</strong>
                                <small>视频摘要需先展开分 P 后入队播放</small>
                              </div>
                            </td>
                            <td>
                              <span>{video.uploader}</span>
                              <small style={{ display: "block", opacity: 0.7 }}>{video.bvid}</small>
                            </td>
                            <td className="catalog-table__duration">{formatDuration(video.durationMs)}</td>
                            <td>
                              <button
                                className="text-button text-button--primary"
                                onClick={() => {
                                  setSelectedVideo(video);
                                  setPartPage(1);
                                }}
                                type="button"
                              >
                                展开分 P
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="remote-pagination">
                      <button
                        className="text-button"
                        disabled={videoPage.page <= 1}
                        onClick={() => setPage(videoPage.page - 1)}
                        type="button"
                      >
                        上一页
                      </button>
                      <span>第 {videoPage.page} 页</span>
                      <button
                        className="text-button"
                        disabled={!videoPage.hasMore}
                        onClick={() => setPage(videoPage.page + 1)}
                        type="button"
                      >
                        下一页
                      </button>
                    </div>
                  </>
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
                      onClick={() => setPage(containers.page - 1)}
                      type="button"
                    >
                      上一页
                    </button>
                    <span>第 {containers.page} 页</span>
                    <button
                      className="text-button"
                      disabled={!containers.hasMore}
                      onClick={() => setPage(containers.page + 1)}
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
