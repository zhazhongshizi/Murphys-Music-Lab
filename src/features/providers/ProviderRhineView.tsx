import type { RefObject } from "react";
import type {
  NewProviderId,
  ProviderCapabilities,
  ProviderContainer,
  ProviderPage,
  ProviderSnapshot,
  ProviderTrack,
  ProviderVideo,
  ProviderWriteRequest,
} from "../../contracts/providers";
import { Icon } from "../../components/Icon";
import { CatalogSearchInput } from "../catalog/CatalogSearchInput";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { SearchHistoryList } from "../library/searchHistory";
import { ArchiveSearchBody, ArchiveSearchHeading } from "../rhine/ArchiveSearchLayout";
import { PlaylistActionIcon } from "../rhine/PlaylistActionIcon";
import { RhinePlaylistSelection } from "../rhine/RhinePlaylistView";
import { SongCover } from "../rhine/SongCover";
import { SOURCE_LABELS } from "./DesktopProviders";
import { ProviderPlaylistDetail } from "./ProviderPlaylistDetail";
import { SourceBadge } from "./SourceBadge";
import {
  MAX_SEARCH_SELECT_ALL,
  formatProviderAvailability,
  hasBrowsableProviderItems,
  isProviderTrackPlayable,
  isProviderVideoPlayable,
  type OrderedTrackSelection,
} from "./providerListHelpers";
import type { ProviderSearchKind } from "./providerSearchHistory";
import type {
  ClassifiedProviderEntry,
  ProviderRow,
  ProviderTab,
} from "./ProviderWorkspace";

export interface ProviderRhineEmptyViewProps {
  readonly source: NewProviderId;
  readonly statusMessage: string;
  readonly onAccount: () => void;
  readonly onRefresh: () => void;
  readonly onDeck?: () => void;
}

export function ProviderRhineEmptyView({
  source,
  statusMessage,
  onAccount,
  onRefresh,
  onDeck,
}: ProviderRhineEmptyViewProps) {
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
        <button type="button" onClick={onRefresh}>刷新账号状态</button>
        {onDeck && <button type="button" onClick={onDeck}>进入当前播放磁带机</button>}
      </div>
    </section>
  );
}

export interface ProviderRhineViewProps {
  readonly id: NewProviderId;
  readonly status: Extract<ProviderSnapshot, { state: "ready" }>;
  readonly caps: ProviderCapabilities;
  readonly tabs: readonly ProviderTab[];
  readonly tab: ProviderTab;
  readonly tabLabels: Record<ProviderTab, string>;
  readonly query: string;
  readonly input: string;
  readonly linkInput: string;
  readonly filterQuery: string;
  readonly filterResultPage: number;
  readonly page: number;
  readonly partsPage: number;
  readonly reload: number;
  readonly busy: boolean;
  readonly notice: string;
  readonly loading: boolean;
  readonly readError: boolean;
  readonly partsError: boolean;
  readonly isRowsLoading: boolean;
  readonly isRowsError: boolean;
  readonly result: ProviderPage<ProviderRow> | null;
  readonly parts: ProviderPage<ProviderTrack> | null;
  readonly container: ProviderContainer | null;
  readonly video: ProviderVideo | null;
  readonly pagedRowsCount: number;
  readonly classifiedPagedEntries: readonly ClassifiedProviderEntry[];
  readonly rawMatchedRowsCount: number;
  readonly containerRows: readonly ProviderContainer[];
  readonly selectableEntries: readonly OrderedTrackSelection[];
  readonly selected: ReadonlyMap<string, OrderedTrackSelection>;
  readonly selectAllRef: RefObject<HTMLInputElement | null>;
  readonly allInScopeSelected: boolean;
  readonly inListSearching: boolean;
  readonly displayMatchSize: number;
  readonly activePageSize: number;
  readonly playingTrackId: string;
  readonly lastWrite: ProviderWriteRequest | null;
  readonly addAction: "playlist.addTracks" | "favorite.addVideos";
  readonly removeAction: "playlist.removeTracks" | "favorite.removeVideos";
  readonly orderedSelectedTracks: readonly ProviderTrack[];
  readonly isRhineShelf: boolean;
  readonly isRhineDetail: boolean;
  readonly safeContainerIdx: number;
  readonly activeContainer: ProviderContainer | null;
  readonly searchHistoryEntries: readonly { query: string; type: ProviderSearchKind }[];
  readonly formatDuration: (milliseconds: number) => string;
  readonly onClearSearchHistory: () => void;
  readonly onArchive?: () => void;
  readonly onNavigate: (next: ProviderTab) => void;
  readonly onSubmitSearch: (value: string, kind?: ProviderTab) => void;
  readonly onInputChange: (value: string) => void;
  readonly onLinkInputChange: (value: string) => void;
  readonly onFilterQueryChange: (value: string) => void;
  readonly onFilterResultPageChange: (nextPage: number) => void;
  readonly onSetContainerIdx: (index: number) => void;
  readonly onOpenContainer: (row: ProviderContainer) => void;
  readonly onResolveLinkInput: () => void;
  readonly onHandleBack: () => void;
  readonly onDetailPageChange: (nextPage: number) => void;
  readonly onDetailRefresh: () => void;
  readonly onCheck: (track: ProviderTrack, position: number, checked: boolean) => void;
  readonly onToggleSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onEnqueue: (tracks: readonly ProviderTrack[], play: boolean, next?: boolean) => void;
  readonly onEnqueueLikes: (play: boolean) => void;
  readonly onEnqueueAll: (play: boolean) => void;
  readonly onEnqueueContainer: (play: boolean) => void;
  readonly onOpenVideo: (row: ProviderVideo, play: boolean, next?: boolean) => void;
  readonly onWrite: (request: ProviderWriteRequest, verify?: boolean) => void;
  readonly onRefreshList: () => void;
  readonly onRetryList: () => void;
  readonly onPageChange: (nextPage: number) => void;
  readonly onActiveTrackIdChange: (trackId: string) => void;
}

export function ProviderRhineView(props: ProviderRhineViewProps) {
  const {
    id,
    status,
    caps,
    tabs,
    tab,
    tabLabels,
    query,
    input,
    linkInput,
    filterQuery,
    filterResultPage,
    page,
    partsPage,
    reload,
    busy,
    notice,
    loading,
    readError,
    partsError,
    isRowsLoading,
    isRowsError,
    result,
    parts,
    container,
    video,
    pagedRowsCount,
    classifiedPagedEntries,
    rawMatchedRowsCount,
    containerRows,
    selectableEntries,
    selected,
    selectAllRef,
    allInScopeSelected,
    inListSearching,
    displayMatchSize,
    activePageSize,
    playingTrackId,
    lastWrite,
    addAction,
    removeAction,
    orderedSelectedTracks,
    isRhineShelf,
    isRhineDetail,
    safeContainerIdx,
    activeContainer,
    searchHistoryEntries,
    formatDuration,
    onClearSearchHistory,
    onArchive,
    onNavigate,
    onSubmitSearch,
    onInputChange,
    onLinkInputChange,
    onFilterQueryChange,
    onFilterResultPageChange,
    onSetContainerIdx,
    onOpenContainer,
    onResolveLinkInput,
    onHandleBack,
    onDetailPageChange,
    onDetailRefresh,
    onCheck,
    onToggleSelectAll,
    onClearSelection,
    onEnqueue,
    onEnqueueLikes,
    onEnqueueAll,
    onEnqueueContainer,
    onOpenVideo,
    onWrite,
    onRefreshList,
    onRetryList,
    onPageChange,
    onActiveTrackIdChange,
  } = props;

  if (container || video) {
    return (
      <section className="provider-workspace provider-workspace--rhine" data-variant="rhine" data-rhine-view="detail" aria-label={`${SOURCE_LABELS[id]}曲库`}>
        <ProviderPlaylistDetail
          key={video?.bvid ?? container!.id}
          id={id}
          container={container}
          video={video}
          data={(video ? parts : result) as ProviderPage<ProviderTrack | ProviderVideo> | null}
          loading={video ? !parts && !partsError : loading}
          failed={video ? partsError : readError}
          page={video ? partsPage : page}
          pageSize={video ? 100 : 20}
          reload={reload}
          busy={busy}
          notice={notice}
          selected={selected}
          playingTrackId={playingTrackId}
          onBack={onHandleBack}
          onPage={onDetailPageChange}
          onRefresh={onDetailRefresh}
          onCheck={onCheck}
          onClear={onClearSelection}
          onEnqueue={(tracks, play, next) => {
            if (play && tracks[0]) onActiveTrackIdChange(tracks[0].id);
            onEnqueue(tracks, play, next);
          }}
          onVideo={(row, play, next) => onOpenVideo(row, play, next)}
          onEnqueueAll={play => (video ? onEnqueueAll(Boolean(play)) : onEnqueueContainer(Boolean(play)))}
          canRemove={!lastWrite && caps.writeActions.includes(removeAction) && !!container?.allowedActions.includes(removeAction)}
          onRemove={() => {
            if (container) {
              onWrite({
                providerId: id,
                accountId: status.account.id,
                operation: { kind: "removeItems", containerId: container.id, trackIds: orderedSelectedTracks.map(t => t.id) },
              });
            }
          }}
          verification={lastWrite ? { disabled: busy, onVerify: () => onWrite(lastWrite, true) } : undefined}
          subscriptions={
            container && id === "netease" && container.allowedActions.some(action => action === "playlist.subscribe" || action === "playlist.unsubscribe") ? (
              <RhinePlaylistSelection>
                {([true, false] as const)
                  .filter(subscribed => container.allowedActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe"))
                  .map(subscribed => (
                    <button
                      key={String(subscribed)}
                      disabled={busy || !!lastWrite || !caps.writeActions.includes(subscribed ? "playlist.subscribe" : "playlist.unsubscribe")}
                      onClick={() =>
                        onWrite({
                          providerId: id,
                          accountId: status.account.id,
                          operation: { kind: "setSubscribed", containerId: container.id, subscribed },
                        })
                      }
                    >
                      {subscribed ? "收藏此歌单" : "取消收藏此歌单"}
                    </button>
                  ))}
              </RhinePlaylistSelection>
            ) : undefined
          }
        />
      </section>
    );
  }

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
            <p className="rhine-empty">
              {id === "bilibili" && tab === "favorite"
                ? result ? "本页没有收藏的他人收藏夹" : "暂未读取到收藏的他人收藏夹"
                : result ? "此页没有条目" : "请选择功能或输入关键词"}
            </p>
          )}
          {activeContainer && (
            <div className="rhine-browse-content">
              <section className="rhine-selection">
                <p className="rhine-eyebrow">
                  {activeContainer.ownership === "created" ? "CREATED" : "FAVORITE"} / {String(safeContainerIdx + 1).padStart(2, "0")} · ID {activeContainer.id}
                </p>
                <h1>{activeContainer.title}</h1>
                <p>{activeContainer.itemCount} 项 · {activeContainer.ownership === "created" ? "自建" : "收藏"}</p>
                <button type="button" aria-label={id === "bilibili" ? "打开收藏夹" : "打开歌单"} onClick={() => onOpenContainer(activeContainer)}>
                  抽取档案 · {id === "bilibili" ? "打开收藏夹" : "打开歌单"} ↗
                </button>
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
                    onClick={() => onSetContainerIdx(index)}
                    onDoubleClick={() => onOpenContainer(row)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{row.title}</strong>
                    <small>{row.itemCount} 项</small>
                  </button>
                ))}
              </div>
            )}
            <nav className="rhine-pages provider-pagination" aria-label="来源列表分页">
              <button type="button" disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
              <span>第 {page} 页{result?.total != null ? ` · 共 ${result.total} 项` : ""}</span>
              <button type="button" disabled={busy || !result?.hasMore || page >= 1000} onClick={() => onPageChange(page + 1)}>下一页</button>
            </nav>
          </div>
          <p className="rhine-shelf-notice" role="status" aria-live="polite">{notice}</p>
        </>
      ) : (
        <div
          className="rhine-search provider-rhine-search"
          onKeyDown={event => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.stopPropagation();
            if (onArchive) onArchive();
          }}
        >
          <ArchiveSearchHeading
            onClose={() => {
              if (onArchive) onArchive();
              else onNavigate(tabs.includes("created") ? "created" : "favorite");
            }}
          />
          <div className="provider-search-forms">
            {["songs", "playlists", "videos"].includes(tab) && (
              <form className="rhine-search-form" onSubmit={event => { event.preventDefault(); onSubmitSearch(input); }}>
                <CatalogSearchInput
                  autoFocus
                  suggestions={false}
                  label="搜索关键词"
                  placeholder={tab === "playlists" ? "搜索歌单" : tab === "videos" ? "搜索视频标题或 UP 主" : "搜索歌曲、歌手或专辑名"}
                  value={input}
                  onChange={onInputChange}
                  onSubmit={value => onSubmitSearch(value)}
                />
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
                    onResolveLinkInput();
                  }}
                >
                  <label className="sr-only" htmlFor="rhine-bili-link-input">BV/AV 或视频链接</label>
                  <input
                    id="rhine-bili-link-input"
                    aria-label="BV/AV 或视频链接"
                    placeholder="粘贴 BV / AV 号、bilibili.com 或 b23.tv 链接直达分 P…"
                    value={linkInput}
                    onChange={e => onLinkInputChange(e.target.value)}
                    maxLength={4096}
                  />
                  <button type="submit" disabled={!linkInput.trim()}>读取视频分 P</button>
                </form>
              </details>
            )}
          </div>
          <div className="catalog-type-tabs" aria-label="搜索类型">
            {tabs.filter(t => ["songs", "playlists", "videos", "likes"].includes(t)).map(t => (
              <button
                key={t}
                type="button"
                aria-pressed={t === tab}
                onClick={() => {
                  if (query && t !== "likes") onSubmitSearch(input || query, t);
                  else onNavigate(t);
                }}
              >
                {t === "songs" ? "歌曲" : t === "playlists" ? "歌单" : t === "videos" ? "视频" : tabLabels[t]}
              </button>
            ))}
          </div>
          <ArchiveSearchBody
            history={
              <SearchHistoryList
                entries={searchHistoryEntries.filter(entry => tabs.includes(entry.type))}
                labels={{ songs: "歌曲", playlists: "歌单", videos: "视频" }}
                onSelect={entry => onSubmitSearch(entry.query, entry.type)}
                onClear={onClearSearchHistory}
              />
            }
          >
            <div className="rhine-search-summary">
              <h2>{tab === "songs" ? "歌曲" : tab === "playlists" ? "歌单" : tab === "videos" ? "视频" : tabLabels[tab]}</h2>
              {query && <span>“{query}”{result?.total != null ? " · 共 " + result.total + " 项" : ""}</span>}
            </div>

            {tab === "likes" && id === "netease" && (
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
                      onFilterQueryChange(event.currentTarget.value);
                      onFilterResultPageChange(1);
                    }}
                  />
                  {filterQuery && (
                    <button aria-label="清空列表搜索" type="button" onClick={() => { onFilterQueryChange(""); onFilterResultPageChange(1); }}>
                      <Icon name="close" size={16} />
                    </button>
                  )}
                </label>
              </div>
            )}

            {(pagedRowsCount > 0 || selected.size > 0 || lastWrite || tab === "likes") && (
              <div className="rhine-playlist-selection provider-buttons">
                {tab === "likes" && id === "netease" && (
                  <>
                    <button type="button" disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)} onClick={() => onEnqueueLikes(true)}>
                      播放全部
                    </button>
                    <button type="button" disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)} onClick={() => onEnqueueLikes(false)}>
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
                        onChange={onToggleSelectAll}
                      />
                      {inListSearching ? "全选搜索结果" : "全选本页"}
                    </label>
                    <span>已选 {selected.size} 项</span>
                    <button type="button" disabled={busy || !selected.size} onClick={onClearSelection}>
                      清空选择
                    </button>
                  </>
                )}
                <button type="button" disabled={busy || !selected.size} onClick={() => onEnqueue(orderedSelectedTracks, false)}>
                  选中加入队列（{selected.size}/{MAX_SEARCH_SELECT_ALL}）
                </button>
                <button type="button" disabled={busy || !selected.size} onClick={() => onEnqueue(orderedSelectedTracks, true)}>
                  播放选中
                </button>
                {lastWrite && (
                  <button type="button" disabled={busy} onClick={() => onWrite(lastWrite, true)}>
                    只读核对结果
                  </button>
                )}
                <button type="button" disabled={busy} onClick={onRefreshList}>
                  刷新
                </button>
              </div>
            )}

            <p className="rhine-notice" role="status" aria-live="polite">{notice}</p>

            <div className="provider-rhine-results">
              {isRowsLoading && <p role="status">{inListSearching ? "正在读取完整列表以搜索…" : "正在读取此来源…"}</p>}
              {!isRowsLoading && isRowsError && (
                <p role="alert">
                  {inListSearching ? "未能读取完整列表，搜索尚未完成" : "读取失败；请手动重试，应用没有重放写入"}{" "}
                  <button type="button" onClick={onRetryList}>
                    重试
                  </button>
                </p>
              )}
              {!isRowsLoading && !isRowsError && !pagedRowsCount && (
                <p className="rhine-search-empty">
                  {inListSearching
                    ? <>没有匹配“{filterQuery.trim()}”的条目 <button type="button" onClick={() => { onFilterQueryChange(""); onFilterResultPageChange(1); }}>清空搜索</button></>
                    : result ? "此页没有条目" : tab === "videos" ? "输入视频标题或 UP 主，寻找想听的内容。" : "输入歌名、歌手或专辑名，寻找想听的音乐。"}
                </p>
              )}
              {!isRowsLoading && !isRowsError && classifiedPagedEntries.length > 0 && (
                <ol className="rhine-songs provider-rhine-songs" start={inListSearching ? (filterResultPage - 1) * displayMatchSize + 1 : (page - 1) * activePageSize + 1}>
                  {classifiedPagedEntries.map(entry => (
                    <li
                      key={entry.kind === "video" ? entry.row.bvid : entry.row.id}
                      className={entry.kind === "video" ? "provider-rhine-video-row" : undefined}
                      data-playing={entry.kind === "track" && playingTrackId === entry.row.id ? "true" : undefined}
                    >
                      {entry.kind === "track" ? (
                        <>
                          <div className="rhine-song-info rhine-song-info--editable">
                            <input
                              type="checkbox"
                              aria-label={entry.row.title}
                              checked={selected.has(entry.row.id)}
                              disabled={!isProviderTrackPlayable(entry.row) || busy || (selected.size >= MAX_SEARCH_SELECT_ALL && !selected.has(entry.row.id))}
                              onChange={e => onCheck(entry.row, entry.position, e.target.checked)}
                            />
                            <SongCover cacheKey={entry.row.coverCacheKey} title={entry.row.title} />
                            <span className="rhine-song-text">
                              <strong>
                                {entry.row.title} <SourceBadge track={entry.row} />
                              </strong>
                              <small>
                                {entry.row.creatorKind === "uploader" ? "UP" : "艺人"}：{entry.row.artist} · {entry.row.album} · {formatDuration(entry.row.durationMs)} ·{" "}
                                {formatProviderAvailability(id, entry.row.availability)}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button
                              type="button"
                              className="play-next-button"
                              title="下一首播放"
                              aria-label={`下一首播放 ${entry.row.title}`}
                              disabled={busy || !isProviderTrackPlayable(entry.row)}
                              onClick={() => onEnqueue([entry.row], false, true)}
                            >
                              <Icon name="play-next" size={20} />
                            </button>
                            <button
                              type="button"
                              className="rhine-playlist-icon-button"
                              title="播放"
                              aria-label="播放此项"
                              disabled={busy || !isProviderTrackPlayable(entry.row)}
                              onClick={() => {
                                onActiveTrackIdChange(entry.row.id);
                                onEnqueue([entry.row], true);
                              }}
                            >
                              <PlaylistActionIcon kind="play" />
                            </button>
                            <button
                              type="button"
                              className="rhine-playlist-icon-button"
                              title="加入队列"
                              aria-label="加入队列"
                              disabled={busy || !isProviderTrackPlayable(entry.row)}
                              onClick={() => onEnqueue([entry.row], false)}
                            >
                              <PlaylistActionIcon kind="queueAdd" />
                            </button>
                            <ProviderLibraryActions
                              track={entry.row}
                              variant="rhine"
                              iconOnly
                            />
                          </span>
                        </>
                      ) : entry.kind === "container" ? (
                        <>
                          <div className="rhine-song-info">
                            <SongCover title={entry.row.title} />
                            <span className="rhine-song-text">
                              <strong>{entry.row.title}</strong>
                              <small>
                                {entry.row.id} · {entry.row.itemCount} 项 · {entry.row.ownership === "created" ? "自建" : "收藏"}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button type="button" className="rhine-action-pill" onClick={() => onOpenContainer(entry.row)}>
                              {entry.row.kind === "favoriteFolder" ? "打开收藏夹" : "打开歌单"}
                            </button>
                          </span>
                        </>
                      ) : (
                        <>
                          <div className="rhine-song-info">
                            <SongCover cacheKey={entry.row.coverCacheKey} title={entry.row.title} />
                            <span className="rhine-song-text">
                              <strong>{entry.row.title}</strong>
                              <small>
                                UP：{entry.row.uploader} · {entry.row.bvid} · {formatDuration(entry.row.durationMs)} · {formatProviderAvailability("bilibili", entry.row.availability)}
                              </small>
                            </span>
                          </div>
                          <span className="rhine-song-actions provider-rhine-actions">
                            <button
                              type="button"
                              className="play-next-button"
                              title="下一首播放"
                              aria-label={`下一首播放 ${entry.row.title}`}
                              disabled={busy || !isProviderVideoPlayable(entry.row)}
                              onClick={() => onOpenVideo(entry.row, false, true)}
                            >
                              <Icon name="play-next" size={20} />
                            </button>
                            <button type="button" className="rhine-playlist-icon-button" title="播放" aria-label="播放" disabled={busy || !isProviderVideoPlayable(entry.row)} onClick={() => onOpenVideo(entry.row, true)}>
                              <PlaylistActionIcon kind="play" />
                            </button>
                            <button type="button" className="rhine-playlist-icon-button" title="加入队列" aria-label="加入队列" disabled={busy || !isProviderVideoPlayable(entry.row)} onClick={() => onOpenVideo(entry.row, false)}>
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

            <nav className="rhine-pages provider-pagination" aria-label="来源列表分页">
              <button
                type="button"
                disabled={busy || (inListSearching ? filterResultPage : page) <= 1}
                onClick={() => (inListSearching ? onFilterResultPageChange(filterResultPage - 1) : onPageChange(page - 1))}
              >
                上一页
              </button>
              <span>第 {inListSearching ? filterResultPage : page} 页</span>
              <button
                type="button"
                disabled={
                  busy ||
                  (inListSearching
                    ? filterResultPage * displayMatchSize >= rawMatchedRowsCount
                    : !result?.hasMore || page >= 1000)
                }
                onClick={() => (inListSearching ? onFilterResultPageChange(filterResultPage + 1) : onPageChange(page + 1))}
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
