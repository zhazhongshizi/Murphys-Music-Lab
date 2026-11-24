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
import { getCurrentTrack, playerActions, usePlayerSelector } from "../player/playerStore";
import type { ArtworkTrack } from "../stage/AlbumArtwork";
import { useDesktopProviders } from "./DesktopProviders";
import {
  MAX_PROVIDER_BATCH_ITEMS,
  MAX_SEARCH_SELECT_ALL,
  collectBilibiliFolderFirstParts,
  collectPlayableProviderTracks,
  filterProviderTracks,
  filterProviderVideos,
  formatProviderAvailability,
  isProviderTrackPlayable,
  isProviderVideoPlayable,
  readAllProviderPages,
  sortSelectedProviderTracks,
  type OrderedTrackSelection,
} from "./providerListHelpers";
import { useProviderSearchHistory, type ProviderSearchKind } from "./providerSearchHistory";
import { ProviderRhineEmptyView, ProviderRhineView } from "./ProviderRhineView";
import { ProviderNormalEmptyView, ProviderNormalView } from "./ProviderNormalView";

export type ProviderTab = "songs" | "playlists" | "videos" | "created" | "favorite" | "likes";
export type ProviderRow = ProviderTrack | ProviderContainer | ProviderVideo;

export type ClassifiedProviderEntry =
  | { readonly kind: "track"; readonly row: ProviderTrack; readonly position: number }
  | { readonly kind: "container"; readonly row: ProviderContainer; readonly position: number }
  | { readonly kind: "video"; readonly row: ProviderVideo; readonly position: number };

const SEARCH_DISPLAY_PAGE_SIZE = 50;

const TAB_LABELS: Record<ProviderTab, string> = {
  songs: "歌曲搜索",
  playlists: "歌单搜索",
  videos: "视频搜索",
  created: "自建",
  favorite: "收藏",
  likes: "喜欢的歌曲",
};

const ARTWORK_VARIANTS: readonly ArtworkTrack["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const ARTWORK_ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;

function isTrack(row: ProviderRow): row is ProviderTrack {
  return "creatorKind" in row;
}

function isContainer(row: ProviderRow): row is ProviderContainer {
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
        <ProviderRhineEmptyView
          source={source}
          statusMessage={statusMessage}
          onAccount={onAccount}
          onRefresh={() => void refresh(source)}
          onDeck={onDeck}
        />
      );
    }
    return (
      <ProviderNormalEmptyView
        source={source}
        embedded={embedded}
        likesOnly={likesOnly}
        statusState={status?.state}
        statusMessage={statusMessage}
        sourceNavigation={sourceNavigation}
        previewArtworkTrack={providerArtworkTrack({
          id: `${source}:preview`,
          title: source === "netease" ? "网易云" : "Bilibili",
          artist: "GREENHOUSE SESSION",
        })}
        onAccount={onAccount}
        onRefresh={() => void refresh(source)}
      />
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
  const tabs = availableTabs.filter((t): t is ProviderTab => t in TAB_LABELS);
  const [tab, setTab] = useState<ProviderTab>(
    likesOnly ? "likes" : initialSection !== "search" && tabs.includes(initialSection) ? initialSection : tabs[0] ?? "created",
  );
  const prevSection = useRef(initialSection);
  const prevSectionTrigger = useRef(sectionTrigger);
  useEffect(() => {
    if (prevSection.current === initialSection && prevSectionTrigger.current === sectionTrigger) return;
    prevSection.current = initialSection;
    prevSectionTrigger.current = sectionTrigger;
    const nextTab: ProviderTab =
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
  const [result, setResult] = useState<ProviderPage<ProviderRow> | null>(null);
  const [readError, setReadError] = useState(false);
  const [container, setContainer] = useState<ProviderContainer | null>(null);
  const [video, setVideo] = useState<ProviderVideo | null>(null);
  const [partsPage, setPartsPage] = useState(1);
  const [partsError, setPartsError] = useState(false);
  const [parts, setParts] = useState<ProviderPage<ProviderTrack> | null>(null);
  const initialParts = useRef<{ bvid: string; data: ProviderPage<ProviderTrack> } | null>(null);
  const [allListRows, setAllListRows] = useState<readonly ProviderRow[] | null>(null);
  const [allListError, setAllListError] = useState(false);
  const [allListRetry, setAllListRetry] = useState(0);
  const allListCache = useRef<{ key: string; rows: readonly ProviderRow[] } | null>(null);
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
    void readAllProviderPages<ProviderRow>(
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
        if (active && current()) {
          setPartsError(true);
          setNotice("分 P 读取失败，请手动刷新");
        }
      });
    return () => {
      active = false;
    };
  }, [video?.bvid, partsPage, reload]);

  function navigate(next: ProviderTab) {
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

  function submitSearch(value: string, kind: ProviderTab = tab) {
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

  const rows: ProviderRow[] = video ? [...(parts?.items ?? [])] : [...(result?.items ?? [])];
  const currentListPage = video ? partsPage : page;
  const displayMatchSize = variant === "rhine" ? 20 : SEARCH_DISPLAY_PAGE_SIZE;
  const rawMatchedRows: readonly { row: ProviderRow; position: number }[] = inListSearching
    ? (allListRows ?? []).flatMap<{ row: ProviderRow; position: number }>((row, position) => {
        if (isTrack(row)) {
          return filterProviderTracks([row], filterQuery).length > 0 ? [{ row, position }] : [];
        }
        if (!isContainer(row)) {
          return filterProviderVideos([row], filterQuery).length > 0 ? [{ row, position }] : [];
        }
        return [];
      })
    : [];
  const pagedEntries: readonly { row: ProviderRow; position: number }[] = inListSearching
    ? rawMatchedRows.slice((filterResultPage - 1) * displayMatchSize, filterResultPage * displayMatchSize)
    : rows.map((row, index) => ({ row, position: (currentListPage - 1) * activePageSize + index }));
  const isRowsLoading = inListSearching
    ? allListRows === null && !allListError
    : video
      ? !parts && !partsError
      : loading;
  const isRowsError = inListSearching ? allListError : video ? partsError : readError;
  const pagedRows = pagedEntries.map(entry => entry.row);
  const classifiedPagedEntries: readonly ClassifiedProviderEntry[] = pagedEntries.map(({ row, position }) =>
    isTrack(row)
      ? { kind: "track", row, position }
      : isContainer(row)
        ? { kind: "container", row, position }
        : { kind: "video", row, position },
  );
  const visibleTrackRows = pagedRows.filter(isTrack);
  const containerRows = pagedRows.filter(isContainer);
  const videoRows = pagedRows.filter((r): r is ProviderVideo => !isTrack(r) && !isContainer(r));
  const pagedTrackEntries = classifiedPagedEntries.flatMap(entry =>
    entry.kind === "track" ? [{ row: entry.row, position: entry.position }] : [],
  );
  const pagedVideoEntries = classifiedPagedEntries.flatMap(entry =>
    entry.kind === "video" ? [{ row: entry.row, position: entry.position }] : [],
  );
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

  function handleToggleSelectAll() {
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
  }

  function handleLinkInputChange(value: string) {
    inputValue.current = value;
    selection.current++;
    setLinkInput(value);
    setVideo(null);
    setParts(null);
  }

  function handlePageChange(nextPage: number) {
    if (video) setPartsPage(nextPage);
    else setPage(nextPage);
  }

  function handleRetryList() {
    if (inListSearching) setAllListRetry(r => r + 1);
    else setReload(r => r + 1);
  }

  if (variant === "rhine") {
    return (
      <ProviderRhineView
        id={id}
        status={status}
        caps={caps}
        tabs={tabs}
        tab={tab}
        tabLabels={TAB_LABELS}
        query={query}
        input={input}
        linkInput={linkInput}
        filterQuery={filterQuery}
        filterResultPage={filterResultPage}
        page={page}
        partsPage={partsPage}
        reload={reload}
        busy={busy}
        notice={notice}
        loading={loading}
        readError={readError}
        partsError={partsError}
        isRowsLoading={isRowsLoading}
        isRowsError={isRowsError}
        result={result}
        parts={parts}
        container={container}
        video={video}
        pagedRowsCount={pagedRows.length}
        classifiedPagedEntries={classifiedPagedEntries}
        rawMatchedRowsCount={rawMatchedRows.length}
        containerRows={containerRows}
        selectableEntries={selectableEntries}
        selected={selected}
        selectAllRef={selectAllRef}
        allInScopeSelected={allInScopeSelected}
        inListSearching={inListSearching}
        displayMatchSize={displayMatchSize}
        activePageSize={activePageSize}
        playingTrackId={playingTrackId}
        lastWrite={lastWrite}
        addAction={addAction}
        removeAction={removeAction}
        orderedSelectedTracks={orderedSelectedTracks}
        isRhineShelf={isRhineShelf}
        isRhineDetail={isRhineDetail}
        safeContainerIdx={safeContainerIdx}
        activeContainer={activeContainer}
        searchHistoryEntries={searchHistory.entries}
        formatDuration={formatDuration}
        onClearSearchHistory={searchHistory.clear}
        onArchive={onArchive}
        onNavigate={navigate}
        onSubmitSearch={submitSearch}
        onInputChange={setInput}
        onLinkInputChange={handleLinkInputChange}
        onFilterQueryChange={setFilterQuery}
        onFilterResultPageChange={setFilterResultPage}
        onSetContainerIdx={setContainerIdx}
        onOpenContainer={row => void openContainer(row)}
        onResolveLinkInput={() => void resolveVideo(inputValue.current, true)}
        onHandleBack={handleBack}
        onDetailPageChange={nextPage => {
          selection.current++;
          handlePageChange(nextPage);
        }}
        onDetailRefresh={() => {
          selection.current++;
          allListCache.current = null;
          setSelected(new Map());
          setPage(1);
          setPartsPage(1);
          setReload(r => r + 1);
        }}
        onCheck={check}
        onToggleSelectAll={handleToggleSelectAll}
        onClearSelection={() => setSelected(new Map())}
        onEnqueue={(tracks, play, next) => void enqueue(tracks, play, next)}
        onEnqueueLikes={play => void enqueueLikes(play)}
        onEnqueueAll={play => void enqueueAll(play)}
        onEnqueueContainer={play => void enqueueContainer(play)}
        onOpenVideo={(row, play, next) => void openVideo(row, play, next)}
        onWrite={(request, verify) => void write(request, verify)}
        onRefreshList={() => {
          allListCache.current = null;
          setReload(r => r + 1);
        }}
        onRetryList={handleRetryList}
        onPageChange={handlePageChange}
        onActiveTrackIdChange={setActiveTrackId}
      />
    );
  }

  return (
    <ProviderNormalView
      id={id}
      status={status}
      caps={caps}
      embedded={embedded}
      likesOnly={likesOnly}
      sourceNavigation={sourceNavigation}
      tabs={tabs}
      tab={tab}
      tabLabels={TAB_LABELS}
      query={query}
      input={input}
      linkInput={linkInput}
      filterQuery={filterQuery}
      filterResultPage={filterResultPage}
      page={page}
      partsPage={partsPage}
      busy={busy}
      notice={notice}
      loading={loading}
      readError={readError}
      isRowsLoading={isRowsLoading}
      isRowsError={isRowsError}
      result={result}
      parts={parts}
      container={container}
      video={video}
      pagedRowsCount={pagedRows.length}
      rawMatchedRowsCount={rawMatchedRows.length}
      containerRows={containerRows}
      visibleTrackRows={visibleTrackRows}
      videoRows={videoRows}
      pagedTrackEntries={pagedTrackEntries}
      pagedVideoEntries={pagedVideoEntries}
      showingVideos={showingVideos}
      activeSelectableCount={activeSelectableCount}
      allInScopeSelected={allInScopeSelected}
      activeSelectionCount={activeSelectionCount}
      selected={selected}
      selectedVideos={selectedVideos}
      selectAllRef={selectAllRef}
      inListSearching={inListSearching}
      displayMatchSize={displayMatchSize}
      playingTrackId={playingTrackId}
      inspectedTrack={inspectedTrack}
      inspectedVideo={inspectedVideo}
      canRemoveFromContainer={canRemoveFromContainer}
      lastWrite={lastWrite}
      addAction={addAction}
      orderedSelectedTracks={orderedSelectedTracks}
      orderedSelectedVideos={orderedSelectedVideos}
      searchHistoryEntries={searchHistory.entries}
      formatDuration={formatDuration}
      getArtworkTrack={providerArtworkTrack}
      onClearSearchHistory={searchHistory.clear}
      onAccount={onAccount}
      onNavigate={navigate}
      onSubmitSearch={submitSearch}
      onInputChange={setInput}
      onLinkInputChange={handleLinkInputChange}
      onFilterQueryChange={setFilterQuery}
      onFilterResultPageChange={setFilterResultPage}
      onOpenContainer={row => void openContainer(row)}
      onResolveLinkInput={() => void resolveVideo(inputValue.current, true)}
      onHandleBack={handleBack}
      onCheckTrack={check}
      onCheckVideo={checkVideo}
      onToggleSelectAll={handleToggleSelectAll}
      onClearSelection={() => {
        setSelected(new Map());
        setSelectedVideos(new Map());
      }}
      onEnqueue={(tracks, play, next) => void enqueue(tracks, play, next)}
      onEnqueueLikes={play => void enqueueLikes(play)}
      onEnqueueAll={play => void enqueueAll(play)}
      onEnqueueContainer={play => void enqueueContainer(play)}
      onRunSelectedVideosBatch={play => void runSelectedVideosBatch(play)}
      onOpenVideo={(row, play, next) => void openVideo(row, play, next)}
      onWrite={(request, verify) => void write(request, verify)}
      onRefreshList={() => {
        allListCache.current = null;
        setSelected(new Map());
        setSelectedVideos(new Map());
        setReload(r => r + 1);
      }}
      onRetryList={handleRetryList}
      onPageChange={handlePageChange}
      onActiveTrackIdChange={setActiveTrackId}
      onActiveVideoBvidChange={setActiveVideoBvid}
    />
  );
}
