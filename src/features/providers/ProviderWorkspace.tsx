import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { nativeQueueEnqueueNext, nativeQueuePlay, nativeQueueReplace } from "../../backend/nativeQueueAdapter";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../player/playerStore";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { PlaylistActionIcon } from "../rhine/PlaylistActionIcon";
import { SongCover } from "../rhine/SongCover";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import { SOURCE_LABELS, useDesktopProviders } from "./DesktopProviders";
import { SourceBadge } from "./SourceBadge";
import { ProviderPlaylistDetail } from "./ProviderPlaylistDetail";
import {
  MAX_PROVIDER_BATCH_ITEMS,
  MAX_SEARCH_SELECT_ALL,
  collectBilibiliFolderFirstParts,
  collectPlayableProviderTracks,
  filterProviderTracks,
  filterProviderVideos,
  formatProviderAvailability,
  hasBrowsableProviderItems,
  isProviderTrackPlayable,
  isProviderVideoPlayable,
  readAllProviderPages,
  sortSelectedProviderTracks,
  type OrderedTrackSelection,
} from "./providerListHelpers";
import { RhinePlaylistSelection } from "../rhine/RhinePlaylistView";
import { ArchiveSearchHeading, ArchiveSearchBody } from "../rhine/ArchiveSearchLayout";
import { CatalogSearchInput } from "../catalog/CatalogSearchInput";
import { SearchHistoryList } from "../library/searchHistory";
import { useProviderSearchHistory, type ProviderSearchKind } from "./providerSearchHistory";

type Tab = "songs" | "playlists" | "videos" | "created" | "favorite" | "likes";
type Row = ProviderTrack | ProviderContainer | ProviderVideo;

const SEARCH_DISPLAY_PAGE_SIZE = 50;

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
  return isProviderTrackPlayable(track);
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
  source: selectedSource,
  sourceNavigation,
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
  source?: NewProviderId;
  sourceNavigation?: ReactNode;
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
  const { source: browseSource, snapshots, refresh } = useDesktopProviders();
  const source = selectedSource ?? browseSource;
  const likesOnly = embedded && initialSection === "likes";
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
              <h1>{likesOnly ? "喜欢的音乐" : SOURCE_LABELS[source]}</h1>
              <p>{likesOnly ? `随当前 ${SOURCE_LABELS[source]}账号同步` : "此来源搜索与个人曲库 · 切换来源不会打断当前播放"}</p>
            </div>
          </header>
          {sourceNavigation}
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
      sourceNavigation={sourceNavigation}
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
  sourceNavigation,
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
  sourceNavigation?: ReactNode;
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
  const likesOnly = embedded && initialSection === "likes";
  const availableTabs: readonly string[] = likesOnly
    ? caps.libraryKinds.filter(kind => kind === "likes")
    : [...caps.searchKinds, ...caps.libraryKinds];
  const tabs = availableTabs.filter((t): t is Tab => t in label);
  const [tab, setTab] = useState<Tab>(
    likesOnly ? "likes" : initialSection !== "search" && tabs.includes(initialSection) ? initialSection : tabs[0] ?? "created",
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
  const [filterQuery, setFilterQuery] = useState("");
  const [filterResultPage, setFilterResultPage] = useState(1);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<ProviderPage<Row> | null>(null);
  const [readError, setReadError] = useState(false);
  const [container, setContainer] = useState<ProviderContainer | null>(null);
  const [video, setVideo] = useState<ProviderVideo | null>(null);
  const [partsPage, setPartsPage] = useState(1);
  const [partsError, setPartsError] = useState(false);
  const [parts, setParts] = useState<ProviderPage<ProviderTrack> | null>(null);
  const initialParts = useRef<{ bvid: string; data: ProviderPage<ProviderTrack> } | null>(null);
  const [allListRows, setAllListRows] = useState<readonly Row[] | null>(null);
  const [allListError, setAllListError] = useState(false);
  const [allListRetry, setAllListRetry] = useState(0);
  const allListCache = useRef<{ key: string; rows: readonly Row[] } | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Map<string, OrderedTrackSelection>>(() => new Map());
  const [selectedVideos, setSelectedVideos] = useState<Map<string, { video: ProviderVideo; position: number }>>(() => new Map());
  const [activeTrackId, setActiveTrackId] = useState("");
  const [activeVideoBvid, setActiveVideoBvid] = useState<string | null>(null);
  const currentPlayingTrack = usePlayerSelector(getCurrentTrack);
  const playingTrackId = currentPlayingTrack?.id ?? "";
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

  const listPageSize = container
    ? id === "netease"
      ? variant === "rhine"
        ? 20
        : 50
      : 20
    : 50;
  const activePageSize = video ? 100 : listPageSize;
  const listContextKey = `${id}:${tab}:${container?.id ?? ""}:${video?.bvid ?? ""}:${reload}`;
  const inListSearchSupported =
    (variant === "default" && (likesOnly || tab === "likes" || Boolean(container) || Boolean(video))) ||
    (variant === "rhine" && tab === "likes" && !container && !video);
  const normalizedFilter = inListSearchSupported ? filterQuery.trim().toLocaleLowerCase("zh-CN") : "";
  const inListSearching = Boolean(normalizedFilter);

  useEffect(() => {
    let active = true;
    setResult(null);
    setReadError(false);
    setLoading(false);
    if (!tabs.includes(tab) || (!container && ["songs", "playlists", "videos"].includes(tab) && !query)) return;
    setLoading(true);
    const read = container
      ? id === "netease"
        ? api.nativeProviderLibraryTracks(id, container.id, page, listPageSize)
        : api.nativeProviderLibraryVideos(container.id, page, listPageSize)
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
        if (active && current()) {
          setReadError(true);
          setNotice("读取失败；请手动刷新，应用没有重放写入");
        }
      })
      .finally(() => {
        if (active && current()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, tab, query, container?.id, page, reload, listPageSize]);

  useEffect(() => {
    setAllListRows(null);
    setAllListError(false);
  }, [listContextKey]);

  useEffect(() => {
    if (!inListSearching) return;
    if (allListCache.current?.key === listContextKey) {
      setAllListRows(allListCache.current.rows);
      setAllListError(false);
      return;
    }
    const singlePage = video
      ? parts && parts.page === 1 && !parts.hasMore
        ? parts
        : null
      : result && result.page === 1 && !result.hasMore
        ? result
        : null;
    if (singlePage) {
      allListCache.current = { key: listContextKey, rows: singlePage.items };
      setAllListRows(singlePage.items);
      setAllListError(false);
      return;
    }
    let active = true;
    const token = selection.current;
    const isValid = () => active && current() && token === selection.current;
    setAllListRows(null);
    setAllListError(false);
    void readAllProviderPages<Row>(
      (nextPage, size) => {
        if (video) return api.nativeProviderVideoParts(video.bvid, nextPage, size);
        if (container) {
          return id === "netease"
            ? api.nativeProviderLibraryTracks(id, container.id, nextPage, size)
            : api.nativeProviderLibraryVideos(container.id, nextPage, size);
        }
        return api.nativeProviderLibraryLikes("netease", nextPage, size);
      },
      activePageSize,
      isValid,
      {
        maxItems: Number.POSITIVE_INFINITY,
        allowEmptyPages: Boolean(!video && container && id === "bilibili"),
      },
    )
      .then(read => {
        if (read.aborted || !isValid()) return;
        if (read.truncated) {
          setAllListError(true);
          return;
        }
        allListCache.current = { key: listContextKey, rows: read.items };
        setAllListRows(read.items);
      })
      .catch(() => {
        if (isValid()) setAllListError(true);
      });
    return () => {
      active = false;
    };
  }, [inListSearching, listContextKey, allListRetry, video?.bvid, container?.id, id, activePageSize, parts, result]);

  useEffect(() => {
    let active = true;
    setParts(null);
    setPartsError(false);
    if (!video) return;
    const seed = initialParts.current;
    initialParts.current = null;
    if (seed?.bvid === video.bvid && partsPage === 1) {
      setParts(seed.data);
      return;
    }
    void api
      .nativeProviderVideoParts(video.bvid, partsPage, 100)
      .then(data => {
        if (active && current()) setParts(data);
      })
      .catch(() => {
        if (active && current()) { setPartsError(true); setNotice("分 P 读取失败，请手动刷新"); }
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
    setSelectedVideos(new Map());
    setActiveTrackId("");
    setActiveVideoBvid(null);
    setLastWrite(null);
    setPage(1);
    setContainerIdx(0);
    setQuery("");
    setInput("");
    setLinkInput("");
    inputValue.current = "";
    setNotice("");
    setFilterQuery("");
    setFilterResultPage(1);
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
    const containerLabel = id === "bilibili" ? "收藏夹" : "歌单";
    setNotice(`正在读取${containerLabel}…`);
    setContainer(null);
    setResult(null);
    setSelected(new Map());
    setSelectedVideos(new Map());
    setActiveTrackId("");
    setActiveVideoBvid(null);
    setVideo(null);
    setLastWrite(null);
    setFilterQuery("");
    setFilterResultPage(1);
    try {
      const detail = await api.nativeProviderContainer(id, row.id);
      if (!current() || token !== selection.current) return;
      if (detail.id !== row.id || detail.providerId !== id) throw new Error("container_identity");
      setContainer(detail);
      setPage(1);
      setNotice("");
    } catch {
      if (current() && token === selection.current) setNotice(`目标${containerLabel}读取失败，未打开旧目标`);
    }
  }

  async function resolveVideo(value: string, typed = false) {
    const token = ++selection.current;
    setVideo(null);
    setParts(null);
    setSelected(new Map());
    setSelectedVideos(new Map());
    setActiveVideoBvid(null);
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

  async function openVideo(row: ProviderVideo, play: boolean, next = false) {
    if (!isProviderVideoPlayable(row)) {
      setNotice(`无法播放或入队：${row.title}（${formatProviderAvailability("bilibili", row.availability)}）`);
      return;
    }
    if (pending.current || !current()) return;
    const token = ++selection.current;
    pending.current = true;
    setBusy(true);
    setNotice("正在读取视频…");
    let single: ProviderTrack | undefined;
    try {
      const data = await api.nativeProviderVideoParts(row.bvid, 1, 100);
      if (!current() || token !== selection.current) return;
      if (data.page !== 1 || !data.items.length) throw new Error("video_parts");
      if (!data.hasMore && data.items.length === 1 && (data.total === null || data.total === 1)) {
        single = data.items[0];
        if (!single || !usable(single)) {
          setNotice("此视频当前不可播放或入队");
          return;
        }
      } else {
        initialParts.current = { bvid: row.bvid, data };
        setSelected(new Map());
        setSelectedVideos(new Map());
        setActiveVideoBvid(null);
        setLastWrite(null);
        setPartsPage(1);
        setVideo(row);
        setNotice(play ? "此视频有多个分 P，请选择要播放的内容" : next ? "此视频有多个分 P，请选择要下一首播放的内容" : "此视频有多个分 P，请选择要加入队列的内容");
      }
    } catch {
      if (current() && token === selection.current) setNotice("视频读取失败，请重试；未播放或入队");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
    if (single && current() && token === selection.current) await enqueue([single], play, next);
  }

  async function enqueue(tracks: readonly ProviderTrack[], play: boolean, next = false) {
    if (pending.current || !current() || !tracks.length || tracks.some(t => !usable(t))) return;
    const token = selection.current;
    const active = () => current() && token === selection.current;
    pending.current = true;
    setBusy(true);
    try {
      const queue = next
        ? await nativeQueueEnqueueNext(api.providerTrackToQueueTrack(tracks[0]!))
        : await api.nativeProviderEnqueueTracks(tracks);
      if (!active()) return;
      await playerActions.hydrateNative(queue);
      if (!active()) return;
      if (play) {
        const index = queue.items.findIndex(t => t.id === tracks[0]!.id);
        if (index < 0) throw new Error("queue_target");
        const playback = await nativeQueuePlay(tracks[0]!.id, queue.generation);
        if (playback && active()) {
          await playerActions.hydrateNative(
            playback.queue,
            playback.playback.player,
            playback.playback.quality,
            playback.playback.bitrate,
          );
        }
      }
      if (active()) {
        setNotice(play ? `已请求播放：${tracks[0]!.title}` : next ? `下一首播放：${tracks[0]!.title}` : `已将 ${tracks.length} 项加入混合队列`);
      }
    } catch {
      if (active()) setNotice("播放或入队失败，请检查此来源登录与队列容量");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function commitTrackBatch(
    tracks: readonly ProviderTrack[],
    play: boolean,
    targetTitle: string,
    truncated: boolean,
    isActive: () => boolean,
    unitType: "track" | "part" = "track",
    extraSkipped?: { unavailable?: number; duplicates?: number },
  ) {
    const collected = collectPlayableProviderTracks(tracks);
    const playable = collected.playable;
    const skippedUnavailable = collected.skippedUnavailable + (extraSkipped?.unavailable ?? 0);
    const skippedDuplicates = collected.skippedDuplicates + (extraSkipped?.duplicates ?? 0);
    const first = playable[0];
    if (!first) {
      setNotice("没有可尝试播放的条目，队列未改变");
      return;
    }
    const unavailableUnit = unitType === "part" ? "个不可用分 P" : "首不可用歌曲";
    const dupUnit = unitType === "part" ? "个重复分 P" : "首重复歌曲";
    const countUnit = unitType === "part" ? "个分 P" : "首";
    const summary = `${skippedUnavailable ? `；跳过 ${skippedUnavailable} ${unavailableUnit}` : ""}${skippedDuplicates ? `；去除 ${skippedDuplicates} ${dupUnit}` : ""}${truncated ? `；已截取前 ${MAX_PROVIDER_BATCH_ITEMS} ${countUnit}` : ""}`;
    const queue = play
      ? await nativeQueueReplace(playable.map(api.providerTrackToQueueTrack))
      : await api.nativeProviderEnqueueTracks(playable);
    if (!isActive()) return;
    await playerActions.hydrateNative(queue);
    if (!isActive()) return;
    if (play) {
      const playback = await nativeQueuePlay(first.id, queue.generation);
      if (!isActive()) return;
      if (!playback) {
        setNotice(`已载入 ${playable.length} ${countUnit}，但播放请求未完成或已取消${summary}`);
        return;
      }
      await playerActions.hydrateNative(
        playback.queue,
        playback.playback.player,
        playback.playback.quality,
        playback.playback.bitrate,
      );
    }
    if (isActive()) {
      setNotice(
        `${play ? `正在播放“${targetTitle}”，已载入 ${playable.length} ${countUnit}` : `已将“${targetTitle}”的 ${playable.length} ${countUnit}加入队列`}${summary}`,
      );
    }
  }

  async function enqueueAll(play = false) {
    if (!video || pending.current || !current()) return;
    if (!isProviderVideoPlayable(video)) {
      setNotice(`无法播放或入队：${video.title}（${formatProviderAvailability("bilibili", video.availability)}）`);
      return;
    }
    const token = selection.current;
    const active = () => current() && token === selection.current;
    const target = video;
    pending.current = true;
    setBusy(true);
    setNotice("正在读取视频全部分 P…");
    try {
      const initialPage = parts && parts.page === 1 ? parts : null;
      const read = await readAllProviderPages(
        (nextPage, size) => api.nativeProviderVideoParts(target.bvid, nextPage, size),
        100,
        active,
        { initialPage, verifyCompleteTotal: true },
      );
      if (read.aborted || !active()) return;
      await commitTrackBatch(read.items, play, target.title, read.truncated, active, "part");
    } catch {
      if (active()) setNotice("整组读取或入队失败，队列未改变");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function enqueueLikes(play = false) {
    if (id !== "netease" || pending.current || !current()) return;
    const token = selection.current;
    const active = () => current() && token === selection.current;
    pending.current = true;
    setBusy(true);
    setNotice("正在读取喜欢的歌曲…");
    try {
      const read = await readAllProviderPages(
        (nextPage, size) => api.nativeProviderLibraryLikes("netease", nextPage, size),
        100,
        active,
        { verifyCompleteTotal: true },
      );
      if (read.aborted || !active()) return;
      await commitTrackBatch(read.items, play, "我喜欢的音乐", read.truncated, active);
    } catch {
      if (active()) setNotice(play ? "喜欢歌曲读取或播放失败，队列未改变" : "喜欢歌曲未加入队列，请检查当前队列空间后重试");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function enqueueContainer(play = false) {
    if ((id !== "netease" && id !== "bilibili") || !container || pending.current || !current()) return;
    const token = selection.current;
    const active = () => current() && token === selection.current;
    const target = container;
    pending.current = true;
    setBusy(true);
    setNotice(id === "bilibili" ? "正在读取收藏夹各视频第一 P…" : "正在读取整张歌单…");
    let failure =
      id === "bilibili"
        ? "收藏夹读取未完成，队列未改变；请刷新收藏夹后重试"
        : "整单读取未完成，队列未改变；请刷新歌单后重试";
    try {
      if (id === "bilibili") {
        const collected = await collectBilibiliFolderFirstParts(
          (nextPage, size) => api.nativeProviderLibraryVideos(target.id, nextPage, size),
          (bvid, nextPage, size) => api.nativeProviderVideoParts(bvid, nextPage, size),
          active,
          result && result.page === 1 ? (result as ProviderPage<ProviderVideo>) : null,
        );
        if (collected.aborted || !active()) return;
        if (!collected.tracks.length) {
          setNotice(
            collected.skippedUnavailableVideos || collected.skippedDuplicateVideos
              ? "没有可尝试播放的条目，队列未改变"
              : "这个收藏夹还没有视频",
          );
          return;
        }
        failure = play
          ? "无法载入收藏夹队列或开始播放，请重试"
          : "收藏夹未加入队列，请检查当前队列是否还有空间（最多 1000 首）";
        await commitTrackBatch(
          collected.tracks,
          play,
          target.title,
          collected.truncated,
          active,
          "track",
          {
            unavailable: collected.skippedUnavailableVideos,
            duplicates: collected.skippedDuplicateVideos,
          },
        );
        return;
      }
      const tracks: ProviderTrack[] = [];
      let total: number | null = null;
      for (let n = 1; n <= MAX_PROVIDER_BATCH_ITEMS / 100; n++) {
        const response = await api.nativeProviderLibraryTracks(id, target.id, n, 100);
        if (!active()) return;
        if (response.page !== n || response.total === null || (total !== null && response.total !== total)) {
          throw new Error("container_page");
        }
        total = response.total;
        const remaining = total - (n - 1) * 100;
        if (response.items.length !== Math.min(100, remaining) || response.hasMore !== (remaining > 100)) {
          throw new Error("container_page");
        }
        tracks.push(...response.items);
        if (!response.hasMore) break;
      }
      if (total === 0) {
        setNotice("这个歌单还没有歌曲");
        return;
      }
      const truncated = (total ?? 0) > MAX_PROVIDER_BATCH_ITEMS || tracks.length > MAX_PROVIDER_BATCH_ITEMS;
      failure = play ? "无法载入歌单队列或开始播放，请重试" : "整单未加入队列，请检查当前队列是否还有空间（最多 1000 首）";
      await commitTrackBatch(tracks.slice(0, MAX_PROVIDER_BATCH_ITEMS), play, target.title, truncated, active);
    } catch {
      if (active()) setNotice(failure);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  function check(track: ProviderTrack, position: number, checked: boolean) {
    setSelected(prev => {
      const next = new Map(prev);
      if (checked && !next.has(track.id)) {
        if (next.size < MAX_SEARCH_SELECT_ALL) {
          next.set(track.id, { track, position });
        } else {
          setNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
        }
      } else if (!checked) {
        next.delete(track.id);
      }
      return next;
    });
  }

  function checkVideo(videoRow: ProviderVideo, position: number, checked: boolean) {
    setSelectedVideos(prev => {
      const next = new Map(prev);
      if (checked && !next.has(videoRow.bvid)) {
        if (next.size < MAX_SEARCH_SELECT_ALL) {
          next.set(videoRow.bvid, { video: videoRow, position });
        } else {
          setNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
        }
      } else if (!checked) {
        next.delete(videoRow.bvid);
      }
      return next;
    });
  }

  async function runSelectedVideosBatch(play: boolean) {
    if (pending.current || !current() || !orderedSelectedVideos.length) return;
    const playableVideos = orderedSelectedVideos.filter(isProviderVideoPlayable);
    const initialSkippedUnavailable = orderedSelectedVideos.length - playableVideos.length;
    if (!playableVideos.length) {
      setNotice("没有可尝试播放的条目，队列未改变");
      return;
    }
    const token = selection.current;
    const active = () => current() && token === selection.current;
    pending.current = true;
    setBusy(true);
    setNotice("正在读取选中视频第一 P…");
    try {
      const tracks: ProviderTrack[] = [];
      let skippedUnavailableParts = 0;
      for (const item of playableVideos) {
        if (!active()) return;
        const pageData = await api.nativeProviderVideoParts(item.bvid, 1, 1);
        if (!active()) return;
        const firstPart = pageData.items[0];
        if (!firstPart) throw new Error("video_parts_empty");
        if (!usable(firstPart)) {
          skippedUnavailableParts++;
          continue;
        }
        tracks.push(firstPart);
      }
      await commitTrackBatch(
        tracks,
        play,
        `${tracks.length} 个选中视频`,
        false,
        active,
        "track",
        { unavailable: initialSkippedUnavailable + skippedUnavailableParts },
      );
    } catch {
      if (active()) setNotice("选中视频读取未完成，队列未改变");
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
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
        setSelected(new Map());
        setSelectedVideos(new Map());
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

  const addAction = id === "netease" ? "playlist.addTracks" : "favorite.addVideos";
  const removeAction = id === "netease" ? "playlist.removeTracks" : "favorite.removeVideos";
  const canRemoveFromContainer = Boolean(
    container &&
    !video &&
    caps.writeActions.includes(removeAction) &&
    container.allowedActions.includes(removeAction),
  );

  const rows: Row[] = video ? [...(parts?.items ?? [])] : [...(result?.items ?? [])];
  const currentListPage = video ? partsPage : page;
  const displayMatchSize = variant === "rhine" ? 20 : SEARCH_DISPLAY_PAGE_SIZE;
  const rawMatchedRows: readonly { row: Row; position: number }[] = inListSearching
    ? (allListRows ?? []).flatMap<{ row: Row; position: number }>((row, position) => {
        if (isTrack(row)) {
          return filterProviderTracks([row], filterQuery).length > 0 ? [{ row, position }] : [];
        }
        if (!isContainer(row)) {
          return filterProviderVideos([row], filterQuery).length > 0 ? [{ row, position }] : [];
        }
        return [];
      })
    : [];
  const pagedEntries: readonly { row: Row; position: number }[] = inListSearching
    ? rawMatchedRows.slice((filterResultPage - 1) * displayMatchSize, filterResultPage * displayMatchSize)
    : rows.map((row, index) => ({ row, position: (currentListPage - 1) * activePageSize + index }));
  const isRowsLoading = inListSearching
    ? allListRows === null && !allListError
    : video
      ? !parts && !partsError
      : loading;
  const isRowsError = inListSearching ? allListError : video ? partsError : readError;
  const pagedRows = pagedEntries.map(entry => entry.row);
  const visibleTrackRows = pagedRows.filter(isTrack);
  const containerRows = pagedRows.filter(isContainer);
  const videoRows = pagedRows.filter((r): r is ProviderVideo => !isTrack(r) && !isContainer(r));
  const showingVideos = variant === "default" && !isRowsLoading && !isRowsError && videoRows.length > 0 && !visibleTrackRows.length && !containerRows.length;
  const selectableEntries: readonly OrderedTrackSelection[] = isRowsLoading || isRowsError
    ? []
    : (inListSearching ? rawMatchedRows : pagedEntries).flatMap(({ row, position }) =>
        isTrack(row) && usable(row) ? [{ track: row, position }] : [],
      );
  const selectableVideoEntries: readonly { video: ProviderVideo; position: number }[] = isRowsLoading || isRowsError
    ? []
    : (inListSearching ? rawMatchedRows : pagedEntries).flatMap(({ row, position }) =>
        !isTrack(row) && !isContainer(row) && (isProviderVideoPlayable(row) || canRemoveFromContainer)
          ? [{ video: row, position }]
          : [],
      );
  const activeSelectableCount = showingVideos ? selectableVideoEntries.length : selectableEntries.length;
  const selectedInScopeCount = showingVideos
    ? selectableVideoEntries.filter(({ video: item }) => selectedVideos.has(item.bvid)).length
    : selectableEntries.filter(({ track }) => selected.has(track.id)).length;
  const allInScopeSelected = activeSelectableCount > 0 && selectedInScopeCount === activeSelectableCount;
  const activeSelectionCount = showingVideos ? selectedVideos.size : selected.size;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedInScopeCount > 0 && !allInScopeSelected;
    }
  }, [allInScopeSelected, selectedInScopeCount]);
  const orderedSelectedTracks = sortSelectedProviderTracks(selected);
  const orderedSelectedVideos = [...selectedVideos.values()]
    .sort((left, right) => left.position - right.position)
    .map(entry => entry.video);
  const inspectedTrack = visibleTrackRows.find(t => t.id === activeTrackId) ?? visibleTrackRows[0] ?? null;
  const inspectedVideo = !inspectedTrack
    ? (videoRows.find(row => row.bvid === activeVideoBvid) ?? videoRows[0] ?? null)
    : null;

  const isRhineShelf = variant === "rhine" && (tab === "created" || tab === "favorite") && !container && !video;
  const isRhineDetail = variant === "rhine" && (container !== null || video !== null);
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
    setSelectedVideos(new Map());
    setActiveTrackId("");
    setActiveVideoBvid(null);
    setLastWrite(null);
    setFilterQuery("");
    setFilterResultPage(1);
  }

  if (variant === "rhine" && (container || video)) {
    return <section className="provider-workspace provider-workspace--rhine" data-variant="rhine" data-rhine-view="detail" aria-label={`${SOURCE_LABELS[id]}曲库`}>
      <ProviderPlaylistDetail key={video?.bvid ?? container!.id} id={id} container={container} video={video}
        data={(video ? parts : result) as ProviderPage<ProviderTrack | ProviderVideo> | null}
        loading={video ? !parts && !partsError : loading} failed={video ? partsError : readError}
        page={video ? partsPage : page} pageSize={video ? 100 : 20} reload={reload} busy={busy} notice={notice} selected={selected} playingTrackId={playingTrackId}
        onBack={handleBack} onPage={n => { selection.current++; if (video) setPartsPage(n); else setPage(n); }}
        onRefresh={() => { selection.current++; allListCache.current = null; setSelected(new Map()); setPage(1); setPartsPage(1); setReload(r => r + 1); }}
        onCheck={check} onClear={() => setSelected(new Map())}
        onEnqueue={(tracks, play, next) => { if (play && tracks[0]) setActiveTrackId(tracks[0].id); void enqueue(tracks, play, next); }}
        onVideo={(row, play, next) => void openVideo(row, play, next)} onEnqueueAll={play => video ? void enqueueAll(play) : void enqueueContainer(play)}
        canRemove={!lastWrite && caps.writeActions.includes(removeAction) && !!container?.allowedActions.includes(removeAction)}
        onRemove={() => { if (container) void write({ providerId: id, accountId: status.account.id, operation: { kind: "removeItems", containerId: container.id, trackIds: orderedSelectedTracks.map(t => t.id) } }); }}
        verification={lastWrite ? { disabled: busy, onVerify: () => void write(lastWrite, true) } : undefined}
        subscriptions={container && id === "netease" && container.allowedActions.some(action => action === "playlist.subscribe" || action === "playlist.unsubscribe") ? <RhinePlaylistSelection>
          {([true, false] as const).filter(subscribed => container.allowedActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe")).map(subscribed => <button key={String(subscribed)} disabled={busy || !!lastWrite || !caps.writeActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe")}
            onClick={() => void write({ providerId: id, accountId: status.account.id, operation: { kind: "setSubscribed", containerId: container.id, subscribed } })}>{subscribed ? "收藏此歌单" : "取消收藏此歌单"}</button>)}
        </RhinePlaylistSelection> : undefined} />
    </section>;
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
                  <button type="button" aria-label={id === "bilibili" ? "打开收藏夹" : "打开歌单"} onClick={() => void openContainer(activeContainer)}>抽取档案 · {id === "bilibili" ? "打开收藏夹" : "打开歌单"} ↗</button>
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
          <div className="rhine-search provider-rhine-search"
            onKeyDown={event => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.stopPropagation();
              if (container || video) handleBack();
              else if (onArchive) onArchive();
            }}>
            <ArchiveSearchHeading onClose={() => {
              if (video) handleBack();
              else if (onArchive) onArchive();
              else navigate(tabs.includes("created") ? "created" : "favorite");
            }} />
            <div className="provider-search-forms">
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

            </div>
            <div className="catalog-type-tabs" aria-label="搜索类型">
              {tabs.filter(t => ["songs", "playlists", "videos", "likes"].includes(t)).map(t => (
                <button key={t} type="button" aria-pressed={t === tab} onClick={() => {
                  if (query && t !== "likes") submitSearch(input || query, t);
                  else navigate(t);
                }}>{t === "songs" ? "歌曲" : t === "playlists" ? "歌单" : t === "videos" ? "视频" : label[t]}</button>
              ))}
            </div>
            <ArchiveSearchBody history={<SearchHistoryList
              entries={searchHistory.entries.filter(entry => tabs.includes(entry.type))}
              labels={{songs: "歌曲", playlists: "歌单", videos: "视频"}}
              onSelect={entry => submitSearch(entry.query, entry.type)} onClear={searchHistory.clear}
            />}>
            {!container && !video && <div className="rhine-search-summary">
              <h2>{tab === "songs" ? "歌曲" : tab === "playlists" ? "歌单" : tab === "videos" ? "视频" : label[tab]}</h2>
              {query && <span>“{query}”{result?.total != null ? " · 共 " + result.total + " 项" : ""}</span>}
            </div>}

            {tab === "likes" && id === "netease" && !container && !video && (
              <div className="rhine-playlist-search">
                <label className="catalog-search">
                  <Icon name="search" size={18} />
                  <span className="sr-only">搜索喜欢的歌曲、歌手或专辑</span>
                  <input
                    value={filterQuery}
                    placeholder="在喜欢的歌曲中搜索歌曲、歌手或专辑"
                    type="search"
                    maxLength={100}
                    onChange={event => {
                      setFilterQuery(event.currentTarget.value);
                      setFilterResultPage(1);
                    }}
                  />
                  {filterQuery && (
                    <button aria-label="清空列表搜索" type="button" onClick={() => { setFilterQuery(""); setFilterResultPage(1); }}>
                      <Icon name="close" size={16} />
                    </button>
                  )}
                </label>
              </div>
            )}

            {(pagedRows.length > 0 || selected.size > 0 || lastWrite || tab === "likes") && <div className="rhine-playlist-selection provider-buttons">
              {tab === "likes" && id === "netease" && !container && !video && (
                <>
                  <button type="button" disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)} onClick={() => void enqueueLikes(true)}>
                    播放全部
                  </button>
                  <button type="button" disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)} onClick={() => void enqueueLikes(false)}>
                    全部歌曲加入队列
                  </button>
                </>
              )}
              {(selectableEntries.length > 0 || selected.size > 0) && (
                <>
                  <label className="playlist-songs__select-all">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allInScopeSelected}
                      disabled={busy || !selectableEntries.length}
                      onChange={() => {
                        setSelected(prev => {
                          const next = new Map(prev);
                          let capped = false;
                          for (const entry of selectableEntries) {
                            if (allInScopeSelected) next.delete(entry.track.id);
                            else if (!next.has(entry.track.id)) {
                              if (next.size < MAX_SEARCH_SELECT_ALL) next.set(entry.track.id, entry);
                              else capped = true;
                            }
                          }
                          if (capped) setNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
                          return next;
                        });
                      }}
                    />
                    {inListSearching ? "全选搜索结果" : "全选本页"}
                  </label>
                  <span>已选 {selected.size} 项</span>
                  <button type="button" disabled={busy || !selected.size} onClick={() => setSelected(new Map())}>
                    清空选择
                  </button>
                </>
              )}
              <button type="button" disabled={busy || !selected.size} onClick={() => void enqueue(orderedSelectedTracks, false)}>
                选中加入队列（{selected.size}/{MAX_SEARCH_SELECT_ALL}）
              </button>
              <button type="button" disabled={busy || !selected.size} onClick={() => void enqueue(orderedSelectedTracks, true)}>
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
                      operation: { kind: "removeItems", containerId: container.id, trackIds: orderedSelectedTracks.map(t => t.id) },
                    })
                  }
                >
                  {id === "bilibili" ? "从当前收藏夹移出选中" : "从当前歌单移出选中"}
                </button>
              )}
              {lastWrite && (
                <button type="button" disabled={busy} onClick={() => void write(lastWrite, true)}>
                  只读核对结果
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => { allListCache.current = null; setReload(r => r + 1); }}>
                刷新
              </button>
            </div>}

            <p className="rhine-notice" role="status" aria-live="polite">{notice}</p>

            <div className="provider-rhine-results">
              {isRowsLoading && <p role="status">{inListSearching ? "正在读取完整列表以搜索…" : "正在读取此来源…"}</p>}
              {!isRowsLoading && isRowsError && (
                <p role="alert">
                  {inListSearching ? "未能读取完整列表，搜索尚未完成" : "读取失败；请手动重试，应用没有重放写入"}{" "}
                  <button type="button" onClick={() => inListSearching ? setAllListRetry(r => r + 1) : setReload(r => r + 1)}>
                    重试
                  </button>
                </p>
              )}
              {!isRowsLoading && !isRowsError && !pagedRows.length && (
                <p className="rhine-search-empty">
                  {inListSearching
                    ? <>没有匹配“{filterQuery.trim()}”的条目 <button type="button" onClick={() => { setFilterQuery(""); setFilterResultPage(1); }}>清空搜索</button></>
                    : result || parts ? "此页没有条目" : tab === "videos" ? "输入视频标题或 UP 主，寻找想听的内容。" : "输入歌名、歌手或专辑名，寻找想听的音乐。"}
                </p>
              )}
              {!isRowsLoading && !isRowsError && pagedEntries.length > 0 && (
                <ol className="rhine-songs provider-rhine-songs" start={inListSearching ? (filterResultPage - 1) * displayMatchSize + 1 : ((video ? partsPage : page) - 1) * activePageSize + 1}>
                  {pagedEntries.map(({ row, position }) => (
                    <li
                      key={isTrack(row) || isContainer(row) ? row.id : row.bvid}
                      className={!isTrack(row) && !isContainer(row) ? "provider-rhine-video-row" : undefined}
                      data-playing={isTrack(row) && playingTrackId === row.id ? "true" : undefined}
                    >
                      {isTrack(row) ? (
                        <>
                          <div className="rhine-song-info rhine-song-info--editable">
                            <input
                              type="checkbox"
                              aria-label={row.title}
                              checked={selected.has(row.id)}
                              disabled={!usable(row) || busy || (selected.size >= MAX_SEARCH_SELECT_ALL && !selected.has(row.id))}
                              onChange={e => check(row, position, e.target.checked)}
                            />
                            <SongCover cacheKey={row.coverCacheKey} title={row.title} />
                            <span className="rhine-song-text">
                              <strong>
                                {row.title} <SourceBadge track={row} />
                              </strong>
                              <small>
                                {row.creatorKind === "uploader" ? "UP" : "艺人"}：{row.artist} · {row.album} · {formatDuration(row.durationMs)} ·{" "}
                                {formatProviderAvailability(id, row.availability)}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button
                              type="button"
                              className="play-next-button"
                              title="下一首播放"
                              aria-label={`下一首播放 ${row.title}`}
                              disabled={busy || !usable(row)}
                              onClick={() => void enqueue([row], false, true)}
                            >
                              <Icon name="play-next" size={20} />
                            </button>
                            <button
                              type="button"
                              className="rhine-playlist-icon-button"
                              title="播放"
                              aria-label="播放此项"
                              disabled={busy || !usable(row)}
                              onClick={() => {
                                setActiveTrackId(row.id);
                                void enqueue([row], true);
                              }}
                            >
                              <PlaylistActionIcon kind="play" />
                            </button>
                            <button
                              type="button"
                              className="rhine-playlist-icon-button"
                              title="加入队列"
                              aria-label="加入队列"
                              disabled={busy || !usable(row)}
                              onClick={() => void enqueue([row], false)}
                            >
                              <PlaylistActionIcon kind="queueAdd" />
                            </button>
                            <ProviderLibraryActions
                              track={row}
                              variant={variant}
                              iconOnly
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
                              {row.kind === "favoriteFolder" ? "打开收藏夹" : "打开歌单"}
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
                                UP：{row.uploader} · {row.bvid} · {formatDuration(row.durationMs)} · {formatProviderAvailability("bilibili", row.availability)}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button
                              type="button"
                              className="play-next-button"
                              title="下一首播放"
                              aria-label={`下一首播放 ${row.title}`}
                              disabled={busy || !isProviderVideoPlayable(row)}
                              onClick={() => void openVideo(row, false, true)}
                            >
                              <Icon name="play-next" size={20} />
                            </button>
                            <button type="button" className="rhine-playlist-icon-button" title="播放" aria-label="播放" disabled={busy || !isProviderVideoPlayable(row)} onClick={() => void openVideo(row, true)}>
                              <PlaylistActionIcon kind="play" />
                            </button>
                            <button type="button" className="rhine-playlist-icon-button" title="加入队列" aria-label="加入队列" disabled={busy || !isProviderVideoPlayable(row)} onClick={() => void openVideo(row, false)}>
                              <PlaylistActionIcon kind="queueAdd" />
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
                disabled={busy || (inListSearching ? filterResultPage : video ? partsPage : page) <= 1}
                onClick={() => inListSearching ? setFilterResultPage(p => p - 1) : (video ? setPartsPage(p => p - 1) : setPage(p => p - 1))}
              >
                上一页
              </button>
              <span>第 {inListSearching ? filterResultPage : video ? partsPage : page} 页</span>
              <button
                type="button"
                disabled={
                  busy ||
                  (inListSearching
                    ? filterResultPage * displayMatchSize >= rawMatchedRows.length
                    : !(video ? parts?.hasMore : result?.hasMore) || (video ? partsPage : page) >= (video ? 100 : 1000))
                }
                onClick={() => inListSearching ? setFilterResultPage(p => p + 1) : (video ? setPartsPage(p => p + 1) : setPage(p => p + 1))}
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
            <span className="section-label">
              {video
                ? `VIDEO MULTIPART / ${video.bvid}`
                : container
                  ? container.ownership === "created"
                    ? "CREATED ARCHIVE"
                    : "COLLECTED ARCHIVE"
                  : likesOnly
                    ? "RECORD CATALOG"
                    : id === "netease"
                      ? "NETEASE CLOUD CATALOG"
                      : "BILIBILI MEDIA CATALOG"}
            </span>
            <h1>
              {video
                ? video.title
                : container
                  ? container.title
                  : likesOnly
                    ? "喜欢的音乐"
                    : `${SOURCE_LABELS[id]} · ${status.account.displayName}`}
            </h1>
            <p>
              {video
                ? `${SOURCE_LABELS[id]} · ${status.account.displayName} · UP：${video.uploader} · ${parts?.total ?? "未知"} 个分 P · 无歌词为正常状态`
                : container
                  ? `${container.itemCount} ${id === "bilibili" ? "个视频" : "首歌曲"} · ${SOURCE_LABELS[id]}${container.ownership === "created" ? "自建" : "收藏"}${id === "bilibili" ? "收藏夹" : "歌单"}${container.description ? ` · ${container.description}` : ""}`
                  : likesOnly
                    ? `随当前${SOURCE_LABELS[id]}账号同步 · ${status.account.displayName}`
                    : "此来源搜索与个人曲库"}
            </p>
          </div>
          <div className="playlist-detail__actions">
            {video && (
              <>
                <button
                  className="text-button text-button--primary"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(parts)}
                  onClick={() => void enqueueAll(true)}
                >
                  <Icon name="play" size={16} />播放全部分 P
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(parts)}
                  onClick={() => void enqueueAll(false)}
                >
                  <Icon name="queue" size={16} />全部分 P 加入队列
                </button>
              </>
            )}
            {!video && container && (id === "netease" || id === "bilibili") && (
              <>
                <button
                  className="text-button text-button--primary"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)}
                  onClick={() => void enqueueContainer(true)}
                >
                  <Icon name="play" size={16} />播放全部
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)}
                  onClick={() => void enqueueContainer(false)}
                >
                  <Icon name="queue" size={16} />{id === "bilibili" ? "全部加入队列" : "全部歌曲加入队列"}
                </button>
                {id === "netease" && ([true, false] as const)
                  .filter(subscribed =>
                    caps.writeActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe") &&
                    container.allowedActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe"),
                  )
                  .map(subscribed => (
                    <button
                      className="text-button"
                      type="button"
                      key={String(subscribed)}
                      disabled={busy || Boolean(lastWrite)}
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
              </>
            )}
            {!video && !container && (likesOnly || tab === "likes") && id === "netease" && (
              <>
                <button
                  className="text-button text-button--primary"
                  type="button"
                  disabled={busy || loading || readError || !hasBrowsableProviderItems(result)}
                  onClick={() => void enqueueLikes(true)}
                >
                  <Icon name="play" size={16} />播放全部
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || loading || readError || !hasBrowsableProviderItems(result)}
                  onClick={() => void enqueueLikes(false)}
                >
                  <Icon name="queue" size={16} />全部歌曲加入队列
                </button>
              </>
            )}
            {(container || video) && (
              <button className="text-button playlist-detail__back" type="button" onClick={handleBack}>
                <Icon name="back" size={16} />{video ? "返回视频列表" : id === "bilibili" ? "返回收藏夹列表" : "返回歌单列表"}
              </button>
            )}
            {!likesOnly && !container && !video && (
              <button className="text-button" type="button" onClick={onAccount}>
                管理此来源账号
              </button>
            )}
          </div>
        </header>

        {sourceNavigation}

        {!likesOnly && !container && !video && <nav className="catalog-type-tabs provider-tabs" aria-label="此来源功能">
          {tabs.map(t => (
            <button key={t} type="button" aria-pressed={t === tab} onClick={() => navigate(t)}>
              {label[t]}
            </button>
          ))}
        </nav>}

        {likesOnly && !tabs.includes("likes") && <p role="status">此来源暂不支持读取喜欢的歌曲。</p>}

        {(likesOnly || tab === "likes" || container || video) && (
          <label className="catalog-search">
            <Icon name="search" size={18} />
            <span className="sr-only">搜索列表内容</span>
            <input
              value={filterQuery}
              placeholder={
                video
                  ? "在此视频中搜索分 P 标题"
                  : container && id === "bilibili"
                    ? "在此收藏夹中搜索视频、UP 主或 BV 号"
                    : container
                      ? "在此歌单中搜索歌曲、歌手或专辑"
                      : "在喜欢的歌曲中搜索歌曲、歌手或专辑"
              }
              type="search"
              maxLength={100}
              onChange={event => {
                setFilterQuery(event.currentTarget.value);
                setFilterResultPage(1);
              }}
            />
            {filterQuery && (
              <button aria-label="清空搜索" type="button" onClick={() => { setFilterQuery(""); setFilterResultPage(1); }}>
                <Icon name="close" size={16} />
              </button>
            )}
          </label>
        )}

        {!container && (["songs", "playlists", "videos"].includes(tab) || (id === "bilibili" && !video)) && (
          <div className="provider-search-stack">
            {["songs", "playlists", "videos"].includes(tab) && (
              <form
                className="provider-search-form"
                onSubmit={event => {
                  event.preventDefault();
                  submitSearch(input);
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

            {id === "bilibili" && !video && (
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
            {!video && ["songs", "playlists", "videos"].includes(tab) && (
              <SearchHistoryList
                entries={searchHistory.entries.filter(entry => tabs.includes(entry.type))}
                labels={{ songs: "歌曲", playlists: "歌单", videos: "视频" }}
                onSelect={entry => submitSearch(entry.query, entry.type)}
                onClear={searchHistory.clear}
              />
            )}
          </div>
        )}

        {query && !container && !video && <p className="provider-query-summary">搜索结果：{query}</p>}
        {inListSearching && !isRowsLoading && !isRowsError && (
          <p className="provider-query-summary" role="status">“{filterQuery.trim()}” · 共 {rawMatchedRows.length} 项匹配</p>
        )}

        <div className="playlist-songs__toolbar provider-toolbar">
          <div className="playlist-songs__batch-actions provider-buttons">
            {(activeSelectableCount > 0 || activeSelectionCount > 0) && (
              <>
                <label className="playlist-songs__select-all">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allInScopeSelected}
                    disabled={busy || !activeSelectableCount}
                    onChange={() => {
                      if (showingVideos) {
                        setSelectedVideos(prev => {
                          const next = new Map(prev);
                          let capped = false;
                          for (const entry of selectableVideoEntries) {
                            if (allInScopeSelected) next.delete(entry.video.bvid);
                            else if (!next.has(entry.video.bvid)) {
                              if (next.size < MAX_SEARCH_SELECT_ALL) next.set(entry.video.bvid, entry);
                              else capped = true;
                            }
                          }
                          if (capped) setNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
                          return next;
                        });
                        return;
                      }
                      setSelected(prev => {
                        const next = new Map(prev);
                        let capped = false;
                        for (const entry of selectableEntries) {
                          if (allInScopeSelected) next.delete(entry.track.id);
                          else if (!next.has(entry.track.id)) {
                            if (next.size < MAX_SEARCH_SELECT_ALL) next.set(entry.track.id, entry);
                            else capped = true;
                          }
                        }
                        if (capped) setNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
                        return next;
                      });
                    }}
                  />
                  {inListSearching ? "全选搜索结果" : "全选本页"}
                </label>
                <span className="playlist-songs__count">已选 {activeSelectionCount} 项</span>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || !activeSelectionCount}
                  onClick={() => {
                    setSelected(new Map());
                    setSelectedVideos(new Map());
                  }}
                >
                  清空选择
                </button>
              </>
            )}
            {(!((!container && !video && (tab === "created" || tab === "favorite")) || (containerRows.length > 0 && !visibleTrackRows.length && !showingVideos))) && (
              <>
                <button
                  className="text-button text-button--primary"
                  type="button"
                  disabled={busy || !activeSelectionCount}
                  onClick={() => showingVideos ? void runSelectedVideosBatch(true) : void enqueue(orderedSelectedTracks, true)}
                >
                  <Icon name="play" size={15} />播放选中
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || !activeSelectionCount}
                  onClick={() => showingVideos ? void runSelectedVideosBatch(false) : void enqueue(orderedSelectedTracks, false)}
                >
                  选中加入队列（{activeSelectionCount}/{MAX_SEARCH_SELECT_ALL}）
                </button>
                {container && !video && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={
                      busy ||
                      Boolean(lastWrite) ||
                      !activeSelectionCount ||
                      !canRemoveFromContainer
                    }
                    onClick={() =>
                      void write({
                        providerId: id,
                        accountId: status.account.id,
                        operation: {
                          kind: "removeItems",
                          containerId: container.id,
                          trackIds: showingVideos
                            ? orderedSelectedVideos.map(item => `bilibili:video:${item.bvid}:1`)
                            : orderedSelectedTracks.map(t => t.id),
                        },
                      })
                    }
                  >
                    {id === "bilibili" ? "从当前收藏夹移出选中" : "从当前歌单移出选中"}
                  </button>
                )}
              </>
            )}
            {lastWrite && (
              <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => void write(lastWrite, true)}>
                只读核对结果
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                allListCache.current = null;
                setSelected(new Map());
                setSelectedVideos(new Map());
                setReload(r => r + 1);
              }}
            >
              刷新
            </button>
          </div>
          <p className={notice ? "playlist-songs__notice" : "sr-only"} role="status" aria-live="polite">
            {notice}
          </p>
        </div>

        {isRowsLoading ? (
          <div className="catalog-empty" role="status">
            <p>{inListSearching ? "正在读取完整列表以搜索…" : "正在读取此来源…"}</p>
            <span>按页读取规范化曲目与容器，不会自动重放写操作。</span>
          </div>
        ) : isRowsError ? (
          <div className="catalog-empty" role="alert">
            <p>{inListSearching ? "未能读取完整列表，搜索尚未完成" : "读取失败；未执行自动重放"}</p>
            <span>请检查连接与来源状态后手动重试。</span>
            <button
              className="text-button text-button--primary"
              type="button"
              onClick={() => inListSearching ? setAllListRetry(r => r + 1) : setReload(r => r + 1)}
            >
              重试
            </button>
          </div>
        ) : !pagedRows.length ? (
          <div className="catalog-empty">
            <p>
              {inListSearching
                ? `没有匹配“${filterQuery.trim()}”的条目`
                : result || parts
                  ? "此页没有条目"
                  : "请选择功能或输入关键词"}
            </p>
            <span>
              {inListSearching
                ? "请尝试更换关键词，或清空搜索查看完整列表。"
                : ["songs", "playlists", "videos"].includes(tab) && !container && !video
                  ? "输入关键词后点击“搜索此来源”发起查询。"
                  : "可切换上方分类标签或点击“刷新”重新读取。"}
            </span>
            {inListSearching && (
              <button className="text-button" type="button" onClick={() => { setFilterQuery(""); setFilterResultPage(1); }}>
                清空搜索
              </button>
            )}
          </div>
        ) : containerRows.length > 0 && !visibleTrackRows.length ? (
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
                  {row.kind === "favoriteFolder" ? "打开收藏夹" : "打开歌单"}
                </button>
              </article>
            ))}
          </div>
        ) : videoRows.length > 0 && !visibleTrackRows.length ? (
          <div className="catalog-table-wrap playlist-detail__table">
            <table className={`catalog-table playlist-songs__table provider-tracks-table${canRemoveFromContainer ? " playlist-songs__table--editable" : ""}`}>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">选择视频</span>#</th>
                  <th scope="col">封面</th>
                  <th scope="col">曲目</th>
                  <th scope="col">UP 主</th>
                  <th scope="col">BV 号</th>
                  <th scope="col">状态</th>
                  <th scope="col">时长</th>
                  {canRemoveFromContainer && <th scope="col">操作</th>}
                </tr>
              </thead>
              <tbody>
                {pagedEntries.flatMap(({ row, position }) => {
                  if (isTrack(row) || isContainer(row)) return [];
                  const checked = selectedVideos.has(row.bvid);
                  const playable = isProviderVideoPlayable(row);
                  const isPlaying = playingTrackId.startsWith(`bilibili:video:${row.bvid}:`);
                  const isInspected = inspectedVideo?.bvid === row.bvid;
                  const displayNumber = String(position + 1).padStart(2, "0");
                  return [
                    <tr
                      key={row.bvid}
                      data-playing={isPlaying ? "true" : undefined}
                      data-selected={isInspected ? "true" : undefined}
                      className={
                        isPlaying
                          ? "catalog-table__active"
                          : checked
                            ? "playlist-songs__selected"
                            : isInspected
                              ? "provider-row--inspected"
                              : undefined
                      }
                      onClick={() => setActiveVideoBvid(row.bvid)}
                      onDoubleClick={() => {
                        if (!busy && playable) {
                          setActiveVideoBvid(row.bvid);
                          void openVideo(row, true);
                        }
                      }}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <label className="playlist-songs__check">
                          <input
                            type="checkbox"
                            aria-label={row.title}
                            checked={checked}
                            disabled={(!playable && !canRemoveFromContainer) || busy || (selectedVideos.size >= MAX_SEARCH_SELECT_ALL && !checked)}
                            onChange={e => checkVideo(row, position, e.target.checked)}
                          />
                          <span className={isPlaying ? "catalog-needle catalog-needle--active" : "catalog-needle"}>
                            {displayNumber}
                          </span>
                        </label>
                      </td>
                      <td>
                        <AlbumArtwork
                          compact
                          track={providerArtworkTrack({
                            id: row.bvid,
                            title: row.title,
                            artist: row.uploader,
                            coverCacheKey: row.coverCacheKey,
                          })}
                        />
                      </td>
                      <td>
                        <div className="provider-track-cell">
                          <button className="catalog-table__title" type="button" onClick={() => setActiveVideoBvid(row.bvid)}>
                            <strong>{row.title}</strong>
                            <small>{row.bvid}</small>
                          </button>
                        </div>
                      </td>
                      <td>{row.uploader}</td>
                      <td>{row.bvid}</td>
                      <td>
                        <span className="quality-tag">{formatProviderAvailability("bilibili", row.availability)}</span>
                      </td>
                      <td className="catalog-table__duration">{formatDuration(row.durationMs)}</td>
                      {canRemoveFromContainer && (
                        <td onClick={e => e.stopPropagation()}>
                          <Tooltip content="移出收藏夹">
                            <button
                              className="icon-button icon-button--quiet icon-button--danger"
                              type="button"
                              disabled={busy || Boolean(lastWrite)}
                              aria-label={`将《${row.title}》移出收藏夹`}
                              onClick={() =>
                                void write({
                                  providerId: id,
                                  accountId: status.account.id,
                                  operation: {
                                    kind: "removeItems",
                                    containerId: container!.id,
                                    trackIds: [`bilibili:video:${row.bvid}:1`],
                                  },
                                })
                              }
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          </Tooltip>
                        </td>
                      )}
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="catalog-table-wrap playlist-detail__table">
            <table className={`catalog-table playlist-songs__table provider-tracks-table${canRemoveFromContainer ? " playlist-songs__table--editable" : ""}`}>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">选择歌曲</span>#</th>
                  <th scope="col">封面</th>
                  <th scope="col">曲目</th>
                  <th scope="col">{id === "bilibili" ? "UP 主" : "歌手"}</th>
                  <th scope="col">{id === "bilibili" ? "视频" : "专辑"}</th>
                  <th scope="col">状态</th>
                  <th scope="col">时长</th>
                  {canRemoveFromContainer && <th scope="col">操作</th>}
                </tr>
              </thead>
              <tbody>
                {pagedEntries.flatMap(({ row, position }) => {
                  if (!isTrack(row)) return [];
                  const checked = selected.has(row.id);
                  const isPlaying = playingTrackId === row.id;
                  const isInspected = inspectedTrack?.id === row.id;
                  const displayNumber = String(position + 1).padStart(2, "0");
                  return [
                    <tr
                      key={row.id}
                      data-playing={isPlaying ? "true" : undefined}
                      data-selected={isInspected ? "true" : undefined}
                      className={
                        isPlaying
                          ? "catalog-table__active"
                          : checked
                            ? "playlist-songs__selected"
                            : isInspected
                              ? "provider-row--inspected"
                              : undefined
                      }
                      onClick={() => setActiveTrackId(row.id)}
                      onDoubleClick={() => {
                        if (!busy && usable(row)) {
                          setActiveTrackId(row.id);
                          void enqueue([row], true);
                        }
                      }}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <label className="playlist-songs__check">
                          <input
                            type="checkbox"
                            aria-label={row.title}
                            checked={checked}
                            disabled={!usable(row) || busy || (selected.size >= MAX_SEARCH_SELECT_ALL && !checked)}
                            onChange={e => check(row, position, e.target.checked)}
                          />
                          <span className={isPlaying ? "catalog-needle catalog-needle--active" : "catalog-needle"}>
                            {displayNumber}
                          </span>
                        </label>
                      </td>
                      <td>
                        <AlbumArtwork compact track={providerArtworkTrack(row)} />
                      </td>
                      <td>
                        <div className="provider-track-cell">
                          <button className="catalog-table__title" type="button" onClick={() => setActiveTrackId(row.id)}>
                            <strong>{row.title}</strong>
                            <small>{row.id.replace(/^netease:track:/, "")}</small>
                          </button>
                          {row.providerId === "bilibili" && <SourceBadge track={row} />}
                        </div>
                      </td>
                      <td>{row.artist}</td>
                      <td>{row.album}</td>
                      <td>
                        <span className="quality-tag">{formatProviderAvailability(id, row.availability)}</span>
                      </td>
                      <td className="catalog-table__duration">{formatDuration(row.durationMs)}</td>
                      {canRemoveFromContainer && (
                        <td onClick={e => e.stopPropagation()}>
                          <Tooltip content="移出歌单">
                            <button
                              className="icon-button icon-button--quiet icon-button--danger"
                              type="button"
                              disabled={busy || Boolean(lastWrite)}
                              aria-label={`将《${row.title}》移出歌单`}
                              onClick={() =>
                                void write({
                                  providerId: id,
                                  accountId: status.account.id,
                                  operation: {
                                    kind: "removeItems",
                                    containerId: container!.id,
                                    trackIds: [row.id],
                                  },
                                })
                              }
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          </Tooltip>
                        </td>
                      )}
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}

        <nav className="remote-pagination provider-pagination" aria-label={video ? "分 P 分页" : "来源列表分页"}>
          <button
            className="text-button"
            type="button"
            disabled={busy || (inListSearching ? filterResultPage : video ? partsPage : page) <= 1}
            onClick={() => inListSearching ? setFilterResultPage(p => p - 1) : (video ? setPartsPage(p => p - 1) : setPage(p => p - 1))}
          >
            上一页
          </button>
          <span>第 {inListSearching ? filterResultPage : video ? partsPage : page} 页</span>
          <button
            className="text-button"
            type="button"
            disabled={
              busy ||
              (inListSearching
                ? filterResultPage * displayMatchSize >= rawMatchedRows.length
                : !(video ? parts?.hasMore : result?.hasMore) || (video ? partsPage : page) >= (video ? 100 : 1000))
            }
            onClick={() => inListSearching ? setFilterResultPage(p => p + 1) : (video ? setPartsPage(p => p + 1) : setPage(p => p + 1))}
          >
            下一页
          </button>
        </nav>
      </div>

      <aside className="catalog-inspector provider-inspector" aria-label="当前选中详情">
        <span className="section-label">{inspectedTrack || inspectedVideo ? "CURRENT SELECTION" : "SOURCE ARCHIVE"}</span>
        <AlbumArtwork
          compact
          track={
            inspectedTrack
              ? providerArtworkTrack(inspectedTrack)
              : inspectedVideo
                ? providerArtworkTrack({
                    id: inspectedVideo.bvid,
                    title: inspectedVideo.title,
                    artist: inspectedVideo.uploader,
                    coverCacheKey: inspectedVideo.coverCacheKey,
                  })
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
            <h2>{inspectedTrack.title}</h2>
            <p className="provider-inspector__creator">
              {inspectedTrack.creatorKind === "uploader" ? `UP 主 · ${inspectedTrack.artist}` : inspectedTrack.artist}
            </p>
            <dl>
              <div>
                <dt>{id === "bilibili" ? "所属视频" : "专辑"}</dt>
                <dd>{inspectedTrack.album}</dd>
              </div>
              <div>
                <dt>可用状态</dt>
                <dd>{formatProviderAvailability(id, inspectedTrack.availability)}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{formatDuration(inspectedTrack.durationMs)}</dd>
              </div>
              <div>
                <dt>批量勾选</dt>
                <dd>{selected.size} / {MAX_SEARCH_SELECT_ALL}</dd>
              </div>
            </dl>
            <div className="catalog-inspector__play-actions">
              <button
                aria-label={`下一首播放 ${inspectedTrack.title}`}
                title="下一首播放"
                className="text-button play-next-button"
                disabled={busy || !usable(inspectedTrack)}
                onClick={() => void enqueue([inspectedTrack], false, true)}
                type="button"
              >
                <Icon name="play-next" size={20} />
              </button>
              <button
                aria-label="播放此项"
                className="text-button text-button--primary catalog-inspector__play"
                disabled={busy || !usable(inspectedTrack)}
                onClick={() => {
                  setActiveTrackId(inspectedTrack.id);
                  void enqueue([inspectedTrack], true);
                }}
                type="button"
              >
                <Icon name="play" size={17} />播放
              </button>
            </div>
            <button
              aria-label="加入队列"
              className="text-button"
              disabled={busy || !usable(inspectedTrack)}
              onClick={() => void enqueue([inspectedTrack], false)}
              type="button"
            >
              <Icon name="queue" size={17} />加入队列
            </button>
            <ProviderLibraryActions
              track={inspectedTrack}
              variant={variant}
              initialContainer={container?.allowedActions.includes(addAction) ? container : undefined}
            />
          </>
        ) : inspectedVideo ? (
          <>
            <h2>{inspectedVideo.title}</h2>
            <p className="provider-inspector__creator">UP 主 · {inspectedVideo.uploader}</p>
            <dl>
              <div>
                <dt>BV 号</dt>
                <dd>{inspectedVideo.bvid}</dd>
              </div>
              <div>
                <dt>可用状态</dt>
                <dd>{formatProviderAvailability("bilibili", inspectedVideo.availability)}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{formatDuration(inspectedVideo.durationMs)}</dd>
              </div>
              <div>
                <dt>批量勾选</dt>
                <dd>{selectedVideos.size} / {MAX_SEARCH_SELECT_ALL}</dd>
              </div>
            </dl>
            <div className="catalog-inspector__play-actions">
              <button
                aria-label={`下一首播放 ${inspectedVideo.title}`}
                title="下一首播放"
                className="text-button play-next-button"
                disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
                onClick={() => void openVideo(inspectedVideo, false, true)}
                type="button"
              >
                <Icon name="play-next" size={20} />
              </button>
              <button
                className="text-button text-button--primary catalog-inspector__play"
                disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
                onClick={() => {
                  setActiveVideoBvid(inspectedVideo.bvid);
                  void openVideo(inspectedVideo, true);
                }}
                type="button"
              >
                <Icon name="play" size={17} />播放
              </button>
            </div>
            <button
              className="text-button"
              disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
              onClick={() => void openVideo(inspectedVideo, false)}
              type="button"
            >
              <Icon name="queue" size={17} />加入队列
            </button>
            <ProviderLibraryActions
              track={{ id: `bilibili:video:${inspectedVideo.bvid}:1`, title: inspectedVideo.title }}
              variant={variant}
              initialContainer={container?.allowedActions.includes(addAction) ? container : undefined}
            />
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
