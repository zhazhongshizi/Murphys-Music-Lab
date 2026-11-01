import { useEffect, useRef, useState } from "react";
import * as api from "../../backend/providersAdapter";
import { providerSessionRevision } from "../../backend/providerSessions";
import type {
  NewProviderId,
  ProviderContainer,
  ProviderPage,
  ProviderSnapshot,
  ProviderTrack,
  ProviderVideo,
  ProviderWriteRequest,
} from "../../contracts/providers";
import { nativeQueuePlay } from "../../backend/nativeQueueAdapter";
import { Icon } from "../../components/Icon";
import { playerActions } from "../player/playerStore";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { PlaylistActionIcon } from "../rhine/PlaylistActionIcon";
import { SongCover } from "../rhine/SongCover";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import { SOURCE_LABELS, useDesktopProviders } from "./DesktopProviders";
import { SourceBadge } from "./SourceBadge";
import { ArchiveSearchHeading, ArchiveSearchBody } from "../rhine/ArchiveSearchLayout";
import { CatalogSearchInput } from "../catalog/CatalogSearchInput";
import { SearchHistoryList } from "../library/searchHistory";
import { useProviderSearchHistory, type ProviderSearchKind } from "./providerSearchHistory";

type Tab = "songs" | "playlists" | "videos" | "created" | "favorite" | "likes";
type Row = ProviderTrack | ProviderContainer | ProviderVideo;

const label: Record<Tab, string> = {
  songs: "歌曲搜索",
  playlists: "歌单搜索",
  videos: "视频搜索",
  created: "自建",
  favorite: "收藏",
  likes: "喜欢的歌曲",
};

const ARTWORK_VARIANTS: readonly ArtworkTrack["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const ARTWORK_ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;

function isTrack(row: Row): row is ProviderTrack {
  return "creatorKind" in row;
}

function isContainer(row: Row): row is ProviderContainer {
  return "ownership" in row;
}

function usable(track: ProviderTrack) {
  return track.availability === "unknown";
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function providerArtworkTrack(item: { id: string; title: string; artist: string; coverCacheKey?: string }): ArtworkTrack {
  const seed = [...item.id].reduce((value, character) => value + (character.codePointAt(0) ?? 0), 0);
  const index = seed % ARTWORK_VARIANTS.length;
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    accent: ARTWORK_ACCENTS[index] ?? ARTWORK_ACCENTS[0],
    artworkVariant: ARTWORK_VARIANTS[index] ?? "fern",
    ...(item.coverCacheKey ? { coverCacheKey: item.coverCacheKey } : {}),
  };
}

export interface RhineProviderSceneState {
  readonly titles: readonly string[];
  readonly selected: number;
  readonly detail: boolean;
  readonly searchMode: boolean;
}

export function ProviderWorkspace({
  variant = "default",
  embedded = false,
  onAccount,
  onDeck,
  onArchive,
  initialSection = "search",
  sectionTrigger = 0,
  selectedContainerIndex,
  onSelectContainerIndex,
  openContainerTrigger = 0,
  onRhineSceneChange,
}: {
  variant?: "default" | "rhine";
  embedded?: boolean;
  onAccount: () => void;
  onDeck?: () => void;
  onArchive?: () => void;
  initialSection?: "created" | "favorite" | "search" | "likes";
  sectionTrigger?: number;
  selectedContainerIndex?: number;
  onSelectContainerIndex?: (index: number) => void;
  openContainerTrigger?: number;
  onRhineSceneChange?: (scene: RhineProviderSceneState) => void;
}) {
  const { source, snapshots, refresh } = useDesktopProviders();
  const isNewSource = source === "netease" || source === "bilibili";
  const status = isNewSource ? snapshots[source] : undefined;
  const isReady = status?.state === "ready";

  useEffect(() => {
    if (!isNewSource || !isReady) {
      onRhineSceneChange?.({ titles: [], selected: 0, detail: false, searchMode: false });
    }
  }, [isNewSource, isReady, onRhineSceneChange]);

  if (!isNewSource) return null;

  if (status?.state !== "ready") {
    const statusMessage = status?.state === "restoring"
      ? "正在恢复此来源账号…"
      : "登录此来源后访问曲库。当前播放保持不变。";
    if (variant === "rhine") {
      return (
        <section
          className="provider-workspace provider-workspace--rhine-empty rhine-empty"
          data-variant="rhine"
          aria-label={`${SOURCE_LABELS[source]}曲库`}
        >
          <p className="rhine-eyebrow">ARCHIVE ACCESS / {source.toUpperCase()}</p>
          <h1>{SOURCE_LABELS[source]}</h1>
          <p role="status">{statusMessage}</p>
          <div className="provider-buttons provider-buttons--center">
            <button type="button" onClick={onAccount}>打开此来源账号</button>
            <button type="button" onClick={() => void refresh(source)}>刷新账号状态</button>
            {onDeck && <button type="button" onClick={onDeck}>进入当前播放磁带机</button>}
          </div>
        </section>
      );
    }
    return (
      <section
        id={embedded ? undefined : "main-content"}
        tabIndex={-1}
        className={embedded ? "provider-workspace provider-workspace--embedded" : "provider-workspace"}
        data-variant="default"
        aria-label={`${SOURCE_LABELS[source]}曲库`}
      >
        <div className="catalog-pane provider-catalog-pane">
          <header className="catalog-pane__header">
            <div>
              <span className="section-label">{source === "netease" ? "NETEASE CLOUD MUSIC" : "BILIBILI AUDIO / VIDEO"}</span>
              <h1>{SOURCE_LABELS[source]}</h1>
              <p>此来源搜索与个人曲库 · 切换来源不会打断当前播放</p>
            </div>
          </header>
          <div className="catalog-empty provider-empty-card">
            <p role="status">{statusMessage}</p>
            <span>在平台账号面板完成扫码或恢复登录后，即可浏览与管理此来源曲库。</span>
            <div className="provider-empty-card__actions">
              <button className="text-button text-button--primary" type="button" onClick={onAccount}>打开此来源账号</button>
              <button className="text-button" type="button" onClick={() => void refresh(source)}>刷新账号状态</button>
            </div>
          </div>
        </div>
        <aside className="catalog-inspector provider-inspector" aria-label="来源状态概览">
          <span className="section-label">SOURCE STATUS</span>
          <AlbumArtwork compact track={providerArtworkTrack({ id: `${source}:preview`, title: SOURCE_LABELS[source], artist: "GREENHOUSE SESSION" })} />
          <h3>{SOURCE_LABELS[source]}</h3>
          <p>{status?.state === "restoring" ? "正在恢复登录凭据" : "尚未连接此来源账号"}</p>
          <dl>
            <div><dt>当前状态</dt><dd>{status?.state === "restoring" ? "恢复中" : "待登录"}</dd></div>
            <div><dt>混合队列</dt><dd>保持当前播放</dd></div>
          </dl>
        </aside>
      </section>
    );
  }

  return (
    <ReadyWorkspace
      key={`${source}:${status.account.id}:${providerSessionRevision(source)}`}
      id={source}
      status={status}
      variant={variant}
      embedded={embedded}
      onAccount={onAccount}
      onDeck={onDeck}
      onArchive={onArchive}
      initialSection={initialSection}
      sectionTrigger={sectionTrigger}
      selectedContainerIndex={selectedContainerIndex}
      onSelectContainerIndex={onSelectContainerIndex}
      openContainerTrigger={openContainerTrigger}
      onRhineSceneChange={onRhineSceneChange}
    />
  );
}

function ReadyWorkspace({
  id,
  status,
  variant,
  embedded,
  onAccount,
  onDeck,
  onArchive,
  initialSection,
  sectionTrigger,
  selectedContainerIndex,
  onSelectContainerIndex,
  openContainerTrigger = 0,
  onRhineSceneChange,
}: {
  id: NewProviderId;
  status: Extract<ProviderSnapshot, { state: "ready" }>;
  variant: "default" | "rhine";
  embedded: boolean;
  onAccount: () => void;
  onDeck?: () => void;
  onArchive?: () => void;
  initialSection: "created" | "favorite" | "search" | "likes";
  sectionTrigger: number;
  selectedContainerIndex?: number;
  onSelectContainerIndex?: (index: number) => void;
  openContainerTrigger?: number;
  onRhineSceneChange?: (scene: RhineProviderSceneState) => void;
}) {
  const caps = status.capabilities;
  const tabs = ([...caps.searchKinds, ...caps.libraryKinds] as string[]).filter((t): t is Tab => t in label);
  const [tab, setTab] = useState<Tab>(
    initialSection !== "search" && tabs.includes(initialSection) ? initialSection : tabs[0] ?? "created",
  );
  const prevSection = useRef(initialSection);
  const prevSectionTrigger = useRef(sectionTrigger);
  useEffect(() => {
    if (prevSection.current === initialSection && prevSectionTrigger.current === sectionTrigger) return;
    prevSection.current = initialSection;
    prevSectionTrigger.current = sectionTrigger;
    const nextTab: Tab =
      initialSection !== "search" && tabs.includes(initialSection) ? initialSection : tabs[0] ?? "created";
    navigate(nextTab);
  }, [initialSection, sectionTrigger]);
  const [input, setInput] = useState("");
  const searchHistory = useProviderSearchHistory(id);
  const [linkInput, setLinkInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<ProviderPage<Row> | null>(null);
  const [container, setContainer] = useState<ProviderContainer | null>(null);
  const [video, setVideo] = useState<ProviderVideo | null>(null);
  const [partsPage, setPartsPage] = useState(1);
  const [parts, setParts] = useState<ProviderPage<ProviderTrack> | null>(null);
  const [selected, setSelected] = useState<Map<string, ProviderTrack>>(new Map());
  const [activeTrackId, setActiveTrackId] = useState("");
  const [localContainerIdx, setLocalContainerIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastWrite, setLastWrite] = useState<ProviderWriteRequest | null>(null);
  const live = useRef(true);
  const pending = useRef(false);
  const selection = useRef(0);
  const inputValue = useRef("");
  const lastOpenTrigger = useRef(openContainerTrigger);
  const revision = useRef(providerSessionRevision(id));
  const current = () => live.current && revision.current === providerSessionRevision(id);

  const containerIdx = selectedContainerIndex ?? localContainerIdx;
  const setContainerIdx = (index: number) => {
    setLocalContainerIdx(index);
    onSelectContainerIndex?.(index);
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      selection.current++;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setResult(null);
    setLoading(false);
    if (!tabs.includes(tab) || (!container && ["songs", "playlists", "videos"].includes(tab) && !query)) return;
    setLoading(true);
    const read = container
      ? id === "netease"
        ? api.nativeProviderLibraryTracks(id, container.id, page, 50)
        : api.nativeProviderLibraryVideos(container.id, page, 20)
      : tab === "songs" && id === "netease"
        ? api.nativeProviderSearchSongs(id, query, page, 50)
        : tab === "playlists" && id === "netease"
          ? api.nativeProviderSearchPlaylists(id, query, page, 50)
          : tab === "videos" && id === "bilibili"
            ? api.nativeProviderSearchVideos(query, page, 50)
            : tab === "likes" && id === "netease"
              ? api.nativeProviderLibraryLikes(id, page, 50)
              : api.nativeProviderLibraryContainers(id, tab === "created" ? "created" : "favorite", page, 50);
    void read
      .then(data => {
        if (active && current()) {
          setResult(data);
          setContainerIdx(0);
        }
      })
      .catch(() => {
        if (active && current()) setNotice("读取失败；请手动刷新，应用没有重放写入");
      })
      .finally(() => {
        if (active && current()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, tab, query, container?.id, page, reload]);

  useEffect(() => {
    let active = true;
    setParts(null);
    if (!video) return;
    void api
      .nativeProviderVideoParts(video.bvid, partsPage, 100)
      .then(data => {
        if (active && current()) setParts(data);
      })
      .catch(() => {
        if (active && current()) setNotice("分 P 读取失败，请手动刷新");
      });
    return () => {
      active = false;
    };
  }, [video?.bvid, partsPage, reload]);

  function navigate(next: Tab) {
    selection.current++;
    setTab(next);
    setContainer(null);
    setVideo(null);
    setParts(null);
    setSelected(new Map());
    setLastWrite(null);
    setPage(1);
    setContainerIdx(0);
    setQuery("");
    setInput("");
    setLinkInput("");
    inputValue.current = "";
    setNotice("");
  }

  function submitSearch(value: string, kind: Tab = tab) {
    const keyword = value.trim();
    if (!keyword || !["songs", "playlists", "videos"].includes(kind) || !tabs.includes(kind)) return;
    navigate(kind);
    setInput(keyword);
    setQuery(keyword);
    setReload(r => r + 1);
    searchHistory.remember(keyword, kind as ProviderSearchKind);
  }

  async function openContainer(row: ProviderContainer) {
    const token = ++selection.current;
    setNotice("正在核对容器…");
    setContainer(null);
    setResult(null);
    setSelected(new Map());
    setVideo(null);
    setLastWrite(null);
    try {
      const detail = await api.nativeProviderContainer(id, row.id);
      if (!current() || token !== selection.current) return;
      if (detail.id !== row.id || detail.providerId !== id) throw new Error("container_identity");
      setContainer(detail);
      setPage(1);
      setNotice("");
    } catch {
      if (current() && token === selection.current) setNotice("目标容器读取失败，未打开旧目标");
    }
  }

  async function resolveVideo(value: string, typed = false) {
    const token = ++selection.current;
    setVideo(null);
    setParts(null);
    setSelected(new Map());
    setNotice("正在读取视频与分 P…");
    try {
      const detail = await api.nativeProviderResolveVideo(value);
      if (!current() || token !== selection.current || (typed && inputValue.current !== value)) return;
      setVideo(detail);
      setPartsPage(1);
      setNotice("");
    } catch {
      if (current() && token === selection.current && (!typed || inputValue.current === value)) {
        setNotice("视频读取失败，请检查 BV/AV/标准链接/b23 链接");
      }
    }
  }

  async function enqueue(tracks: readonly ProviderTrack[], play: boolean) {
    if (pending.current || !current() || !tracks.length || tracks.some(t => !usable(t))) return;
    pending.current = true;
    setBusy(true);
    try {
      const queue = await api.nativeProviderEnqueueTracks(tracks);
      if (!current()) return;
      await playerActions.hydrateNative(queue);
      if (play) {
        const index = queue.items.findIndex(t => t.id === tracks[0]!.id);
        if (index < 0) throw new Error("queue_target");
        const playback = await nativeQueuePlay(index);
        if (playback && current()) {
          await playerActions.hydrateNative(
            playback.queue,
            playback.playback.player,
            playback.playback.quality,
            playback.playback.bitrate,
          );
        }
      }
      if (current()) {
        setNotice(play ? `已请求播放：${tracks[0]!.title}` : `已将 ${tracks.length} 项加入混合队列`);
      }
    } catch {
      if (current()) setNotice("播放或入队失败，请检查此来源登录与队列容量");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function enqueueAll() {
    if (!video || pending.current || !current()) return;
    const target = video;
    pending.current = true;
    setBusy(true);
    try {
      const queue = await api.nativeProviderEnqueueVideo(target.bvid, "all");
      if (!current()) return;
      await playerActions.hydrateNative(queue);
      setNotice(`已将“${target.title}”全部分 P 加入队列`);
    } catch {
      if (current()) setNotice("整组读取或入队失败；整组最多1000项，不会部分入队");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function enqueueContainer() {
    if (id !== "netease" || !container || pending.current || !current()) return;
    const target = container;
    pending.current = true;
    setBusy(true);
    try {
      const tracks: ProviderTrack[] = [];
      for (let n = 1; n <= 10; n++) {
        const response = await api.nativeProviderLibraryTracks(id, target.id, n, 100);
        if (!current()) return;
        if (response.page !== n || (response.total !== null && response.total > 1000)) {
          throw new Error("container_capacity");
        }
        tracks.push(...response.items);
        if (!response.hasMore) break;
        if (n === 10) throw new Error("container_capacity");
      }
      if (!tracks.length || tracks.length > 1000 || tracks.some(t => !usable(t))) {
        throw new Error("container_unavailable");
      }
      const queue = await api.nativeProviderEnqueueTracks(tracks);
      if (current()) {
        await playerActions.hydrateNative(queue);
        setNotice(`已将“${target.title}”的 ${tracks.length} 首歌曲加入队列`);
      }
    } catch {
      if (current()) setNotice("整单未入队：最多1000首，须完整读取且条目可用；请分页选择所需歌曲");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  function check(track: ProviderTrack, checked: boolean) {
    setSelected(prev => {
      const next = new Map(prev);
      if (checked && next.size < 100) next.set(track.id, track);
      else if (!checked) next.delete(track.id);
      return next;
    });
  }

  async function write(request: ProviderWriteRequest, verify = false) {
    if (pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setLastWrite(request);
    try {
      const receipt = await api.nativeProviderWrite(request, verify);
      if (!current()) return;
      setNotice(
        receipt.status === "applied"
          ? "已只读核实目标状态；列表可手动刷新"
          : "结果待核对，可能部分完成；请只读核对，不要再次提交",
      );
      if (receipt.status === "applied") {
        setReload(r => r + 1);
        if (id === "netease") void playerActions.refreshProviderLikes(true);
      }
    } catch {
      if (current()) setNotice("操作未获确认，请只读核对；未自动重复提交");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  const rows: Row[] = video ? [...(parts?.items ?? [])] : [...(result?.items ?? [])];
  const trackRows = rows.filter(isTrack);
  const containerRows = rows.filter(isContainer);
  const videoRows = rows.filter((r): r is ProviderVideo => !isTrack(r) && !isContainer(r));
  const inspectedTrack = trackRows.find(t => t.id === activeTrackId) ?? trackRows[0] ?? null;

  const isRhineShelf = variant === "rhine" && (tab === "created" || tab === "favorite") && !container && !video;
  const isRhineDetail = variant === "rhine" && container !== null && !video;
  const safeContainerIdx = containerRows.length ? Math.min(containerIdx, containerRows.length - 1) : 0;
  const activeContainer = containerRows[safeContainerIdx] ?? null;

  useEffect(() => {
    if (variant !== "rhine") return;
    const titles = isRhineShelf
      ? containerRows.map(c => c.title)
      : container
        ? [container.title]
        : [];
    onRhineSceneChange?.({
      titles,
      selected: isRhineShelf ? safeContainerIdx : 0,
      detail: isRhineDetail,
      searchMode: !isRhineShelf && !isRhineDetail,
    });
  }, [variant, isRhineShelf, isRhineDetail, safeContainerIdx, container?.id, container?.title, JSON.stringify(containerRows.map(c => c.title))]);

  useEffect(() => {
    if (openContainerTrigger === lastOpenTrigger.current) return;
    lastOpenTrigger.current = openContainerTrigger;
    if (isRhineShelf && activeContainer) {
      void openContainer(activeContainer);
    }
  }, [openContainerTrigger, isRhineShelf, activeContainer]);

  const addAction = id === "netease" ? "playlist.addTracks" : "favorite.addVideos";
  const removeAction = id === "netease" ? "playlist.removeTracks" : "favorite.removeVideos";

  function handleBack() {
    selection.current++;
    if (video) {
      setVideo(null);
      setParts(null);
    } else {
      setContainer(null);
      setPage(1);
    }
    setSelected(new Map());
    setLastWrite(null);
  }

  if (variant === "rhine") {
    return (
      <section
        className="provider-workspace provider-workspace--rhine"
        data-variant="rhine"
        data-rhine-view={isRhineShelf ? "shelf" : isRhineDetail ? "detail" : "search"}
        aria-label={`${SOURCE_LABELS[id]}曲库`}
      >
        {isRhineShelf ? (
          <>
            {loading && <p className="rhine-empty" role="status">正在读取此来源…</p>}
            {!loading && !containerRows.length && (
              <p className="rhine-empty">{id === "bilibili" && tab === "favorite"
                ? result ? "本页没有收藏的他人收藏夹" : "暂未读取到收藏的他人收藏夹"
                : result ? "此页没有条目" : "请选择功能或输入关键词"}</p>
            )}
            {activeContainer && (
              <div className="rhine-browse-content">
                <section className="rhine-selection">
                  <p className="rhine-eyebrow">
                    {activeContainer.ownership === "created" ? "CREATED" : "FAVORITE"} / {String(safeContainerIdx + 1).padStart(2, "0")} · ID {activeContainer.id}
                  </p>
                  <h1>{activeContainer.title}</h1>
                  <p>{activeContainer.itemCount} 项 · {activeContainer.ownership === "created" ? "自建" : "收藏"}</p>
                  <button type="button" aria-label="打开此容器" onClick={() => void openContainer(activeContainer)}>抽取档案 · {id === "bilibili" ? "打开收藏夹" : "打开歌单"} ↗</button>
                </section>
              </div>
            )}
            <div className="rhine-catalog">
              {containerRows.length > 0 && (
                <div className="rhine-card-list" aria-label="选择容器">
                  {containerRows.map((row, index) => (
                    <button
                      key={row.id}
                      type="button"
                      aria-pressed={index === safeContainerIdx}
                      onClick={() => setContainerIdx(index)}
                      onDoubleClick={() => void openContainer(row)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{row.title}</strong>
                      <small>{row.itemCount} 项</small>
                    </button>
                  ))}
                </div>
              )}
              <nav className="rhine-pages provider-pagination" aria-label="来源列表分页">
                <button type="button" disabled={busy || page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
                <span>第 {page} 页{result?.total != null ? ` · 共 ${result.total} 项` : ""}</span>
                <button type="button" disabled={busy || !result?.hasMore || page >= 1000} onClick={() => setPage(p => p + 1)}>下一页</button>
              </nav>
            </div>
            <p className="rhine-shelf-notice" role="status" aria-live="polite">{notice}</p>
          </>
        ) : (
          <div className={isRhineDetail ? "rhine-document rhine-playlist-document provider-rhine-document" : "rhine-search provider-rhine-search"}
            onKeyDown={event => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.stopPropagation();
              if (container || video) handleBack();
              else if (onArchive) onArchive();
            }}>
            {isRhineDetail && (
              <div className="provider-rhine-back-row">
                <button type="button" className="rhine-back" onClick={handleBack}>
                  返回{video ? "视频列表" : "容器列表"}
                </button>
              </div>
            )}

            {!isRhineDetail && <ArchiveSearchHeading onClose={() => {
              if (video) handleBack();
              else if (onArchive) onArchive();
              else navigate(tabs.includes("created") ? "created" : "favorite");
            }} />}
            {!isRhineDetail && <div className="provider-search-forms">
            {["songs", "playlists", "videos"].includes(tab) && (
              <form className="rhine-search-form" onSubmit={event => { event.preventDefault(); submitSearch(input); }}>
                <CatalogSearchInput autoFocus suggestions={false} label="搜索关键词"
                  placeholder={tab === "playlists" ? "搜索歌单" : tab === "videos" ? "搜索视频标题或 UP 主" : "搜索歌曲、歌手或专辑名"}
                  value={input} onChange={setInput} onSubmit={value => submitSearch(value)} />
                <button type="submit" aria-label="搜索此来源" disabled={!input.trim()}>搜索 ↗</button>
              </form>
            )}

            {id === "bilibili" && (
              <details className="provider-video-link">
              <summary>通过 BV/AV 或链接打开分 P</summary>
              <form
                className="rhine-search-form provider-rhine-bili-form"
                onSubmit={e => {
                  e.preventDefault();
                  void resolveVideo(inputValue.current, true);
                }}
              >
                <label className="sr-only" htmlFor="rhine-bili-link-input">BV/AV 或视频链接</label>
                <input
                  id="rhine-bili-link-input"
                  aria-label="BV/AV 或视频链接"
                  placeholder="粘贴 BV / AV 号、bilibili.com 或 b23.tv 链接直达分 P…"
                  value={linkInput}
                  onChange={e => {
                    inputValue.current = e.target.value;
                    selection.current++;
                    setLinkInput(e.target.value);
                    setVideo(null);
                    setParts(null);
                  }}
                  maxLength={4096}
                />
                <button type="submit" disabled={!linkInput.trim()}>读取视频分 P</button>
              </form>
              </details>
            )}

            </div>}
            {!isRhineDetail && <div className="catalog-type-tabs" aria-label="搜索类型">
              {tabs.filter(t => ["songs", "playlists", "videos", "likes"].includes(t)).map(t => (
                <button key={t} type="button" aria-pressed={t === tab} onClick={() => {
                  if (query && t !== "likes") submitSearch(input || query, t);
                  else navigate(t);
                }}>{t === "songs" ? "歌曲" : t === "playlists" ? "歌单" : t === "videos" ? "视频" : label[t]}</button>
              ))}
            </div>}
            <ArchiveSearchBody history={isRhineDetail ? undefined : <SearchHistoryList
              entries={searchHistory.entries.filter(entry => tabs.includes(entry.type))}
              labels={{songs: "歌曲", playlists: "歌单", videos: "视频"}}
              onSelect={entry => submitSearch(entry.query, entry.type)} onClear={searchHistory.clear}
            />}>
            {!container && !video && <div className="rhine-search-summary">
              <h2>{tab === "songs" ? "歌曲" : tab === "playlists" ? "歌单" : tab === "videos" ? "视频" : label[tab]}</h2>
              {query && <span>“{query}”{result?.total != null ? ' · 共 ' + result.total + ' 项' : ''}</span>}
            </div>}

            {video && (
              <header className="provider-rhine-context">
                <div>
                  <p className="rhine-eyebrow">VIDEO MULTIPART / {video.bvid}</p>
                  <h2>{video.title}</h2>
                  <p>UP：{video.uploader} · {video.bvid} · {parts?.total ?? "未知"} P · 无歌词为正常状态</p>
                </div>
                <div className="rhine-document-actions">
                  <span>共 {parts?.total ?? trackRows.length} 个分 P</span>
                  <button type="button" disabled={busy} onClick={() => void enqueueAll()}>全部分 P 加入队列</button>
                </div>
              </header>
            )}

            {container && !video && (
              <header className="provider-rhine-context">
                <div>
                  <p className="rhine-eyebrow">PLAYLIST / {container.id}</p>
                  <h2>{container.title}</h2>
                  <p>{container.description || `${container.itemCount} 项 · ${container.ownership === "created" ? "自建" : "收藏"}`}</p>
                </div>
                {id === "netease" && (
                  <div className="rhine-document-actions provider-buttons">
                    <span>{container.itemCount} 首歌曲</span>
                    <button type="button" disabled={busy} onClick={() => void enqueueContainer()}>全部歌曲加入队列</button>
                    {([true, false] as const).map(subscribed => (
                      <button
                        type="button"
                        key={String(subscribed)}
                        disabled={
                          busy ||
                          Boolean(lastWrite) ||
                          !caps.writeActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe") ||
                          !container.allowedActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe")
                        }
                        onClick={() =>
                          void write({
                            providerId: id,
                            accountId: status.account.id,
                            operation: { kind: "setSubscribed", containerId: container.id, subscribed },
                          })
                        }
                      >
                        {subscribed ? "收藏此歌单" : "取消收藏此歌单"}
                      </button>
                    ))}
                  </div>
                )}
              </header>
            )}

            {(rows.length > 0 || lastWrite) && <div className="rhine-playlist-selection provider-buttons">
              <button type="button" disabled={busy || !selected.size} onClick={() => void enqueue([...selected.values()], false)}>
                选中加入队列（{selected.size}/100）
              </button>
              <button type="button" disabled={busy || !selected.size} onClick={() => void enqueue([...selected.values()], true)}>
                播放选中
              </button>
              {container && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    Boolean(lastWrite) ||
                    !selected.size ||
                    !caps.writeActions.includes(removeAction) ||
                    !container.allowedActions.includes(removeAction)
                  }
                  onClick={() =>
                    void write({
                      providerId: id,
                      accountId: status.account.id,
                      operation: { kind: "removeItems", containerId: container.id, trackIds: [...selected.keys()] },
                    })
                  }
                >
                  从当前容器移出选中
                </button>
              )}
              {lastWrite && (
                <button type="button" disabled={busy} onClick={() => void write(lastWrite, true)}>
                  只读核对结果
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setReload(r => r + 1)}>
                只读刷新列表
              </button>
            </div>}

            <p className="rhine-notice" role="status" aria-live="polite">{notice}</p>

            <div className="provider-rhine-results">
              {loading && !video && <p role="status">正在读取此来源…</p>}
              {!loading && !rows.length && (
                <p className="rhine-search-empty">{result || parts ? "此页没有条目" : tab === "videos" ? "输入视频标题或 UP 主，寻找想听的内容。" : "输入歌名、歌手或专辑名，寻找想听的音乐。"}</p>
              )}
              {rows.length > 0 && (
                <ol className="rhine-songs provider-rhine-songs" start={((video ? partsPage : page) - 1) * 50 + 1}>
                  {rows.map(row => (
                    <li
                      key={isTrack(row) || isContainer(row) ? row.id : row.bvid}
                      data-playing={isTrack(row) && activeTrackId === row.id ? "true" : undefined}
                    >
                      {isTrack(row) ? (
                        <>
                          <div className="rhine-song-info rhine-song-info--editable">
                            <input
                              type="checkbox"
                              aria-label={row.title}
                              checked={selected.has(row.id)}
                              disabled={!usable(row) || busy || (selected.size >= 100 && !selected.has(row.id))}
                              onChange={e => check(row, e.target.checked)}
                            />
                            <SongCover cacheKey={row.coverCacheKey} title={row.title} />
                            <span className="rhine-song-text">
                              <strong>
                                {row.title} <SourceBadge track={row} />
                              </strong>
                              <small>
                                {row.creatorKind === "uploader" ? "UP" : "艺人"}：{row.artist} · {row.album} · {formatDuration(row.durationMs)} ·{" "}
                                {usable(row) ? "可尝试播放" : row.availability}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button
                              type="button"
                              className="rhine-action-pill"
                              disabled={busy || !usable(row)}
                              onClick={() => {
                                setActiveTrackId(row.id);
                                void enqueue([row], true);
                              }}
                            >
                              <PlaylistActionIcon kind="play" />
                              <span>播放此项</span>
                            </button>
                            <button
                              type="button"
                              className="rhine-action-pill"
                              disabled={busy || !usable(row)}
                              onClick={() => void enqueue([row], false)}
                            >
                              <PlaylistActionIcon kind="queueAdd" />
                              <span>加入队列</span>
                            </button>
                            <ProviderLibraryActions
                              track={row}
                              variant={variant}
                              initialContainer={container?.allowedActions.includes(addAction) ? container : undefined}
                            />
                          </span>
                        </>
                      ) : isContainer(row) ? (
                        <>
                          <div className="rhine-song-info">
                            <SongCover title={row.title} />
                            <span className="rhine-song-text">
                              <strong>{row.title}</strong>
                              <small>
                                {row.id} · {row.itemCount} 项 · {row.ownership === "created" ? "自建" : "收藏"}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button type="button" className="rhine-action-pill" onClick={() => void openContainer(row)}>
                              打开此容器
                            </button>
                          </span>
                        </>
                      ) : (
                        <>
                          <div className="rhine-song-info">
                            <SongCover cacheKey={row.coverCacheKey} title={row.title} />
                            <span className="rhine-song-text">
                              <strong>{row.title}</strong>
                              <small>
                                UP：{row.uploader} · {row.bvid} · {formatDuration(row.durationMs)} · {row.availability}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button type="button" className="rhine-action-pill" onClick={() => void resolveVideo(row.bvid)}>
                              选择分 P
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <nav className="rhine-pages provider-pagination" aria-label={video ? "分 P 分页" : "来源列表分页"}>
              <button
                type="button"
                disabled={busy || (video ? partsPage : page) <= 1}
                onClick={() => (video ? setPartsPage(p => p - 1) : setPage(p => p - 1))}
              >
                上一页
              </button>
              <span>第 {video ? partsPage : page} 页</span>
              <button
                type="button"
                disabled={busy || !(video ? parts?.hasMore : result?.hasMore) || (video ? partsPage : page) >= (video ? 100 : 1000)}
                onClick={() => (video ? setPartsPage(p => p + 1) : setPage(p => p + 1))}
              >
                下一页
              </button>
            </nav>
            </ArchiveSearchBody>
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      id={embedded ? undefined : "main-content"}
      tabIndex={-1}
      className={embedded ? "provider-workspace provider-workspace--embedded" : "provider-workspace"}
      data-variant="default"
      aria-label={`${SOURCE_LABELS[id]}曲库`}
    >
      <div className="catalog-pane provider-catalog-pane">
        <header className="catalog-pane__header">
          <div>
            <span className="section-label">{id === "netease" ? "NETEASE CLOUD CATALOG" : "BILIBILI MEDIA CATALOG"}</span>
            <h1>{SOURCE_LABELS[id]} · {status.account.displayName}</h1>
            <p>
              {container
                ? `${container.title} · ${container.id} · ${container.itemCount} 项`
                : video
                  ? `${video.title} · UP：${video.uploader} · ${video.bvid}`
                  : "此来源搜索与个人曲库"}
            </p>
          </div>
          <div className="playlist-detail__actions">
            {(container || video) && (
              <button className="text-button playlist-detail__back" type="button" onClick={handleBack}>
                <Icon name="back" size={16} />返回{video ? "视频列表" : "容器列表"}
              </button>
            )}
            <button className="text-button" type="button" onClick={onAccount}>
              管理此来源账号
            </button>
          </div>
        </header>

        <nav className="catalog-type-tabs provider-tabs" aria-label="此来源功能">
          {tabs.map(t => (
            <button key={t} type="button" aria-pressed={t === tab} onClick={() => navigate(t)}>
              {label[t]}
            </button>
          ))}
        </nav>

        {((!container && ["songs", "playlists", "videos"].includes(tab)) || id === "bilibili") && (
          <div className="provider-search-stack">
            {!container && ["songs", "playlists", "videos"].includes(tab) && (
              <form
                className="provider-search-form"
                onSubmit={event => {
                  event.preventDefault();
                  selection.current++;
                  setVideo(null);
                  setSelected(new Map());
                  setPage(1);
                  setQuery(input.trim());
                  setReload(r => r + 1);
                }}
              >
                <label className="catalog-search">
                  <Icon name="search" size={18} />
                  <span className="sr-only">搜索关键词</span>
                  <input
                    aria-label="搜索关键词"
                    value={input}
                    maxLength={200}
                    placeholder={
                      tab === "playlists"
                        ? "输入关键词搜索网易云歌单…"
                        : tab === "videos"
                          ? "输入关键词搜索 Bilibili 视频…"
                          : "输入歌名、歌手或专辑并搜索…"
                    }
                    onChange={event => setInput(event.target.value)}
                  />
                </label>
                <button className="text-button text-button--primary" type="submit" disabled={!input.trim()}>
                  搜索此来源
                </button>
              </form>
            )}

            {id === "bilibili" && (
              <form
                className="provider-search-form provider-search-form--link"
                onSubmit={e => {
                  e.preventDefault();
                  void resolveVideo(inputValue.current, true);
                }}
              >
                <label className="catalog-search">
                  <Icon name="search" size={18} />
                  <span className="sr-only">BV/AV 或视频链接</span>
                  <input
                    aria-label="BV/AV 或视频链接"
                    value={linkInput}
                    placeholder="粘贴 BV / AV 号、bilibili.com 或 b23.tv 链接直达分 P…"
                    onChange={e => {
                      inputValue.current = e.target.value;
                      selection.current++;
                      setLinkInput(e.target.value);
                      setVideo(null);
                      setParts(null);
                    }}
                    maxLength={4096}
                  />
                </label>
                <button className="text-button text-button--primary" type="submit" disabled={!linkInput.trim()}>
                  读取视频分 P
                </button>
              </form>
            )}
          </div>
        )}

        {query && !container && !video && <p className="provider-query-summary">搜索结果：{query}</p>}

        {video && (
          <header className="provider-context-banner">
            <div>
              <span className="section-label">VIDEO MULTIPART / {video.bvid}</span>
              <h2>{video.title}</h2>
              <p>UP：{video.uploader} · {video.bvid} · {parts?.total ?? "未知"} P · 无歌词为正常状态</p>
            </div>
            <div className="provider-buttons">
              <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void enqueueAll()}>
                <Icon name="queue" size={16} />全部分 P 加入队列
              </button>
            </div>
          </header>
        )}

        {container && id === "netease" && (
          <header className="provider-context-banner">
            <div>
              <span className="section-label">{container.ownership === "created" ? "CREATED PLAYLIST" : "COLLECTED PLAYLIST"}</span>
              <h2>{container.title}</h2>
              <p>{container.description || `${container.itemCount} 首歌曲 · ${container.id}`}</p>
            </div>
            <div className="provider-buttons">
              <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void enqueueContainer()}>
                <Icon name="queue" size={16} />全部歌曲加入队列
              </button>
              {([true, false] as const).map(subscribed => (
                <button
                  className="text-button"
                  type="button"
                  key={String(subscribed)}
                  disabled={
                    busy ||
                    Boolean(lastWrite) ||
                    !caps.writeActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe") ||
                    !container.allowedActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe")
                  }
                  onClick={() =>
                    void write({
                      providerId: id,
                      accountId: status.account.id,
                      operation: { kind: "setSubscribed", containerId: container.id, subscribed },
                    })
                  }
                >
                  {subscribed ? "收藏此歌单" : "取消收藏此歌单"}
                </button>
              ))}
            </div>
          </header>
        )}

        <div className="playlist-songs__toolbar provider-toolbar">
          <div className="playlist-songs__batch-actions provider-buttons">
            <button
              className="text-button text-button--primary"
              type="button"
              disabled={busy || !selected.size}
              onClick={() => void enqueue([...selected.values()], true)}
            >
              <Icon name="play" size={15} />播放选中
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy || !selected.size}
              onClick={() => void enqueue([...selected.values()], false)}
            >
              选中加入队列（{selected.size}/100）
            </button>
            {container && (
              <button
                className="text-button"
                type="button"
                disabled={
                  busy ||
                  Boolean(lastWrite) ||
                  !selected.size ||
                  !caps.writeActions.includes(removeAction) ||
                  !container.allowedActions.includes(removeAction)
                }
                onClick={() =>
                  void write({
                    providerId: id,
                    accountId: status.account.id,
                    operation: { kind: "removeItems", containerId: container.id, trackIds: [...selected.keys()] },
                  })
                }
              >
                从当前容器移出选中
              </button>
            )}
            {lastWrite && (
              <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void write(lastWrite, true)}>
                只读核对结果
              </button>
            )}
            <button className="text-button" type="button" disabled={busy} onClick={() => setReload(r => r + 1)}>
              只读刷新列表
            </button>
          </div>
          <p className={notice ? "playlist-songs__notice" : "sr-only"} role="status" aria-live="polite">
            {notice}
          </p>
        </div>

        {loading && !video ? (
          <div className="catalog-empty" role="status">
            <p>正在读取此来源…</p>
            <span>按页读取规范化曲目与容器，不会自动重放写操作。</span>
          </div>
        ) : !rows.length ? (
          <div className="catalog-empty">
            <p>{result || parts ? "此页没有条目" : "请选择功能或输入关键词"}</p>
            <span>
              {["songs", "playlists", "videos"].includes(tab)
                ? "输入关键词后点击“搜索此来源”发起查询。"
                : "可切换上方分类标签或点击“只读刷新列表”重新读取。"}
            </span>
          </div>
        ) : containerRows.length > 0 && !trackRows.length ? (
          <div className="playlist-grid provider-container-grid">
            {containerRows.map(row => (
              <article className="playlist-card provider-container-card" key={row.id}>
                <div className="provider-container-card__top">
                  <AlbumArtwork
                    compact
                    track={providerArtworkTrack({
                      id: row.id,
                      title: row.title,
                      artist: row.owner.id,
                    })}
                  />
                  <span className="section-label">
                    {row.ownership === "created" ? "CREATED" : row.ownership === "collected" ? "FAVORITE" : "PLAYLIST"}
                  </span>
                </div>
                <div className="provider-container-card__meta">
                  <h3>{row.title}</h3>
                  <p>
                    {row.itemCount} 项 · {row.ownership === "created" ? "自建" : "收藏"} · {row.id}
                  </p>
                </div>
                {row.description ? <p className="provider-container-card__desc">{row.description}</p> : null}
                <button className="text-button text-button--primary" type="button" onClick={() => void openContainer(row)}>
                  打开此容器
                </button>
              </article>
            ))}
          </div>
        ) : videoRows.length > 0 && !trackRows.length ? (
          <div className="playlist-grid provider-video-grid">
            {videoRows.map(row => (
              <article className="playlist-card provider-container-card" key={row.bvid}>
                <div className="provider-container-card__top">
                  <AlbumArtwork
                    compact
                    track={providerArtworkTrack({
                      id: row.bvid,
                      title: row.title,
                      artist: row.uploader,
                      coverCacheKey: row.coverCacheKey,
                    })}
                  />
                  <span className="section-label">VIDEO / {row.bvid}</span>
                </div>
                <div className="provider-container-card__meta">
                  <h3>{row.title}</h3>
                  <p>
                    UP：{row.uploader} · {row.bvid} · {formatDuration(row.durationMs)} ·{" "}
                    {row.availability === "unknown" ? "可展开分 P" : row.availability}
                  </p>
                </div>
                <button className="text-button text-button--primary" type="button" onClick={() => void resolveVideo(row.bvid)}>
                  选择分 P
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="catalog-table-wrap">
            <table className="catalog-table playlist-songs__table provider-tracks-table">
              <thead>
                <tr>
                  <th scope="col">选择</th>
                  <th scope="col">#</th>
                  <th scope="col">封面</th>
                  <th scope="col">曲目 / 分 P</th>
                  <th scope="col">状态</th>
                  <th scope="col">时长</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {trackRows.map((row, idx) => {
                  const checked = selected.has(row.id);
                  const isActive = inspectedTrack?.id === row.id;
                  return (
                    <tr
                      key={row.id}
                      className={isActive ? "catalog-table__active" : checked ? "playlist-songs__selected" : undefined}
                      onClick={() => setActiveTrackId(row.id)}
                    >
                      <td className="playlist-songs__check" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={row.title}
                          checked={checked}
                          disabled={!usable(row) || busy || (selected.size >= 100 && !checked)}
                          onChange={e => check(row, e.target.checked)}
                        />
                      </td>
                      <td>
                        <span className={isActive ? "catalog-needle catalog-needle--active" : "catalog-needle"}>
                          {String(((video ? partsPage : page) - 1) * 50 + idx + 1).padStart(2, "0")}
                        </span>
                      </td>
                      <td>
                        <AlbumArtwork compact track={providerArtworkTrack(row)} />
                      </td>
                      <td>
                        <div className="provider-track-cell">
                          <button className="catalog-table__title" type="button" onClick={() => setActiveTrackId(row.id)}>
                            <strong>{row.title}</strong>
                            <small>
                              {row.creatorKind === "uploader" ? `UP：${row.artist}` : `艺人：${row.artist}`} · {row.album}
                            </small>
                          </button>
                          <SourceBadge track={row} />
                        </div>
                      </td>
                      <td>
                        <span className="quality-tag">{usable(row) ? "可尝试播放" : row.availability}</span>
                      </td>
                      <td className="catalog-table__duration">{formatDuration(row.durationMs)}</td>
                      <td className="provider-track-actions-cell" onClick={e => e.stopPropagation()}>
                        <div className="provider-row-actions">
                          <button
                            className="text-button text-button--primary"
                            type="button"
                            disabled={busy || !usable(row)}
                            onClick={() => {
                              setActiveTrackId(row.id);
                              void enqueue([row], true);
                            }}
                          >
                            播放此项
                          </button>
                          <button
                            className="text-button"
                            type="button"
                            disabled={busy || !usable(row)}
                            onClick={() => void enqueue([row], false)}
                          >
                            加入队列
                          </button>
                          <ProviderLibraryActions
                            track={row}
                            variant={variant}
                            initialContainer={container?.allowedActions.includes(addAction) ? container : undefined}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <nav className="remote-pagination provider-pagination" aria-label={video ? "分 P 分页" : "来源列表分页"}>
          <button
            className="text-button"
            type="button"
            disabled={busy || (video ? partsPage : page) <= 1}
            onClick={() => (video ? setPartsPage(p => p - 1) : setPage(p => p - 1))}
          >
            上一页
          </button>
          <span>第 {video ? partsPage : page} 页</span>
          <button
            className="text-button"
            type="button"
            disabled={busy || !(video ? parts?.hasMore : result?.hasMore) || (video ? partsPage : page) >= (video ? 100 : 1000)}
            onClick={() => (video ? setPartsPage(p => p + 1) : setPage(p => p + 1))}
          >
            下一页
          </button>
        </nav>
      </div>

      <aside className="catalog-inspector provider-inspector" aria-label="当前选中详情">
        <span className="section-label">{inspectedTrack ? "CURRENT SELECTION" : "SOURCE ARCHIVE"}</span>
        <AlbumArtwork
          compact
          track={
            inspectedTrack
              ? providerArtworkTrack(inspectedTrack)
              : providerArtworkTrack({
                  id: container?.id ?? video?.bvid ?? `${id}:${status.account.id}`,
                  title: container?.title ?? video?.title ?? status.account.displayName,
                  artist: SOURCE_LABELS[id],
                  coverCacheKey: video?.coverCacheKey,
                })
          }
        />
        {inspectedTrack ? (
          <>
            <p className="provider-inspector__creator">
              {inspectedTrack.creatorKind === "uploader" ? `UP 主 · ${inspectedTrack.artist}` : `艺人 · ${inspectedTrack.artist}`}
            </p>
            <dl>
              <div>
                <dt>{id === "bilibili" ? "所属视频" : "专辑"}</dt>
                <dd>{inspectedTrack.album}</dd>
              </div>
              <div>
                <dt>可用性</dt>
                <dd>{usable(inspectedTrack) ? "可尝试播放" : inspectedTrack.availability}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{formatDuration(inspectedTrack.durationMs)}</dd>
              </div>
              <div>
                <dt>批量勾选</dt>
                <dd>{selected.size} / 100</dd>
              </div>
            </dl>
          </>
        ) : (
          <>
            <h3>{container ? container.title : video ? video.title : status.account.displayName}</h3>
            <p>{SOURCE_LABELS[id]} · {label[tab]}</p>
            <dl>
              <div>
                <dt>当前账号</dt>
                <dd>{status.account.displayName}</dd>
              </div>
              <div>
                <dt>当前分类</dt>
                <dd>{container ? `容器 (${container.itemCount} 项)` : video ? `分 P (${parts?.total ?? 0} P)` : label[tab]}</dd>
              </div>
              <div>
                <dt>当前页码</dt>
                <dd>第 {video ? partsPage : page} 页</dd>
              </div>
            </dl>
          </>
        )}
      </aside>
    </section>
  );
}
