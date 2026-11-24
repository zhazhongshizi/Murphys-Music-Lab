import type { ReactNode, RefObject } from "react";
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
import {
  InspectorHeaderBar,
  InspectorToggleButton,
  useInspectorDrawer,
} from "../../components/InspectorDrawerControl";
import { Tooltip } from "../../components/Tooltip";
import { TrackRowActions } from "../../components/TrackRowActions";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { SearchHistoryList } from "../library/searchHistory";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import { SOURCE_LABELS } from "./DesktopProviders";
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
import type { ProviderRow, ProviderTab } from "./ProviderWorkspace";

export interface ProviderNormalEmptyViewProps {
  readonly source: NewProviderId;
  readonly embedded: boolean;
  readonly likesOnly: boolean;
  readonly statusState: ProviderSnapshot["state"] | undefined;
  readonly statusMessage: string;
  readonly sourceNavigation?: ReactNode;
  readonly previewArtworkTrack: ArtworkTrack;
  readonly onAccount: () => void;
  readonly onRefresh: () => void;
}

export function ProviderNormalEmptyView({
  source,
  embedded,
  likesOnly,
  statusState,
  statusMessage,
  sourceNavigation,
  previewArtworkTrack,
  onAccount,
  onRefresh,
}: ProviderNormalEmptyViewProps) {
  const inspector = useInspectorDrawer(false);

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
          <div className="playlist-detail__actions">
            <InspectorToggleButton open={inspector.inspectorOpen} onToggle={inspector.toggleInspector} />
          </div>
        </header>
        {sourceNavigation}
        <div className="catalog-empty provider-empty-card">
          <p role="status">{statusMessage}</p>
          <span>在平台账号面板完成扫码或恢复登录后，即可浏览与管理此来源曲库。</span>
          <div className="provider-empty-card__actions">
            <button className="text-button text-button--primary" type="button" onClick={onAccount}>打开此来源账号</button>
            <button className="text-button" type="button" onClick={onRefresh}>刷新账号状态</button>
          </div>
        </div>
      </div>
      {inspector.inspectorOpen ? (
        <aside className="catalog-inspector provider-inspector" aria-label="来源状态概览">
          <InspectorHeaderBar label="SOURCE STATUS" onClose={inspector.closeInspector} />
          <AlbumArtwork compact track={previewArtworkTrack} />
          <h3>{SOURCE_LABELS[source]}</h3>
          <p>{statusState === "restoring" ? "正在恢复登录凭据" : "尚未连接此来源账号"}</p>
          <dl>
            <div><dt>当前状态</dt><dd>{statusState === "restoring" ? "恢复中" : "待登录"}</dd></div>
            <div><dt>混合队列</dt><dd>保持当前播放</dd></div>
          </dl>
        </aside>
      ) : null}
    </section>
  );
}

export interface ProviderNormalViewProps {
  readonly id: NewProviderId;
  readonly status: Extract<ProviderSnapshot, { state: "ready" }>;
  readonly caps: ProviderCapabilities;
  readonly embedded: boolean;
  readonly likesOnly: boolean;
  readonly sourceNavigation?: ReactNode;
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
  readonly busy: boolean;
  readonly notice: string;
  readonly loading: boolean;
  readonly readError: boolean;
  readonly isRowsLoading: boolean;
  readonly isRowsError: boolean;
  readonly result: ProviderPage<ProviderRow> | null;
  readonly parts: ProviderPage<ProviderTrack> | null;
  readonly container: ProviderContainer | null;
  readonly video: ProviderVideo | null;
  readonly pagedRowsCount: number;
  readonly rawMatchedRowsCount: number;
  readonly containerRows: readonly ProviderContainer[];
  readonly visibleTrackRows: readonly ProviderTrack[];
  readonly videoRows: readonly ProviderVideo[];
  readonly pagedTrackEntries: readonly { readonly row: ProviderTrack; readonly position: number }[];
  readonly pagedVideoEntries: readonly { readonly row: ProviderVideo; readonly position: number }[];
  readonly showingVideos: boolean;
  readonly activeSelectableCount: number;
  readonly allInScopeSelected: boolean;
  readonly activeSelectionCount: number;
  readonly selected: ReadonlyMap<string, OrderedTrackSelection>;
  readonly selectedVideos: ReadonlyMap<string, { video: ProviderVideo; position: number }>;
  readonly selectAllRef: RefObject<HTMLInputElement | null>;
  readonly inListSearching: boolean;
  readonly displayMatchSize: number;
  readonly playingTrackId: string;
  readonly inspectedTrack: ProviderTrack | null;
  readonly inspectedVideo: ProviderVideo | null;
  readonly canRemoveFromContainer: boolean;
  readonly lastWrite: ProviderWriteRequest | null;
  readonly addAction: "playlist.addTracks" | "favorite.addVideos";
  readonly orderedSelectedTracks: readonly ProviderTrack[];
  readonly orderedSelectedVideos: readonly ProviderVideo[];
  readonly searchHistoryEntries: readonly { query: string; type: ProviderSearchKind }[];
  readonly formatDuration: (milliseconds: number) => string;
  readonly getArtworkTrack: (item: { id: string; title: string; artist: string; coverCacheKey?: string }) => ArtworkTrack;
  readonly onClearSearchHistory: () => void;
  readonly onAccount: () => void;
  readonly onNavigate: (next: ProviderTab) => void;
  readonly onSubmitSearch: (value: string, kind?: ProviderTab) => void;
  readonly onInputChange: (value: string) => void;
  readonly onLinkInputChange: (value: string) => void;
  readonly onFilterQueryChange: (value: string) => void;
  readonly onFilterResultPageChange: (nextPage: number) => void;
  readonly onOpenContainer: (row: ProviderContainer) => void;
  readonly onResolveLinkInput: () => void;
  readonly onHandleBack: () => void;
  readonly onCheckTrack: (track: ProviderTrack, position: number, checked: boolean) => void;
  readonly onCheckVideo: (videoRow: ProviderVideo, position: number, checked: boolean) => void;
  readonly onToggleSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onEnqueue: (tracks: readonly ProviderTrack[], play: boolean, next?: boolean) => void;
  readonly onEnqueueLikes: (play: boolean) => void;
  readonly onEnqueueAll: (play: boolean) => void;
  readonly onEnqueueContainer: (play: boolean) => void;
  readonly onRunSelectedVideosBatch: (play: boolean) => void;
  readonly onOpenVideo: (row: ProviderVideo, play: boolean, next?: boolean) => void;
  readonly onWrite: (request: ProviderWriteRequest, verify?: boolean) => void;
  readonly onRefreshList: () => void;
  readonly onRetryList: () => void;
  readonly onPageChange: (nextPage: number) => void;
  readonly onActiveTrackIdChange: (trackId: string) => void;
  readonly onActiveVideoBvidChange: (bvid: string | null) => void;
}

export function ProviderNormalView(props: ProviderNormalViewProps) {
  const {
    id,
    status,
    caps,
    embedded,
    likesOnly,
    sourceNavigation,
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
    busy,
    notice,
    loading,
    readError,
    isRowsLoading,
    isRowsError,
    result,
    parts,
    container,
    video,
    pagedRowsCount,
    rawMatchedRowsCount,
    containerRows,
    visibleTrackRows,
    videoRows,
    pagedTrackEntries,
    pagedVideoEntries,
    showingVideos,
    activeSelectableCount,
    allInScopeSelected,
    activeSelectionCount,
    selected,
    selectedVideos,
    selectAllRef,
    inListSearching,
    displayMatchSize,
    playingTrackId,
    inspectedTrack,
    inspectedVideo,
    canRemoveFromContainer,
    lastWrite,
    addAction,
    orderedSelectedTracks,
    orderedSelectedVideos,
    searchHistoryEntries,
    formatDuration,
    getArtworkTrack,
    onClearSearchHistory,
    onAccount,
    onNavigate,
    onSubmitSearch,
    onInputChange,
    onLinkInputChange,
    onFilterQueryChange,
    onFilterResultPageChange,
    onOpenContainer,
    onResolveLinkInput,
    onHandleBack,
    onCheckTrack,
    onCheckVideo,
    onToggleSelectAll,
    onClearSelection,
    onEnqueue,
    onEnqueueLikes,
    onEnqueueAll,
    onEnqueueContainer,
    onRunSelectedVideosBatch,
    onOpenVideo,
    onWrite,
    onRefreshList,
    onRetryList,
    onPageChange,
    onActiveTrackIdChange,
    onActiveVideoBvidChange,
  } = props;

  const inspector = useInspectorDrawer(false);

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
                  onClick={() => onEnqueueAll(true)}
                >
                  <Icon name="play" size={16} />播放全部分 P
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(parts)}
                  onClick={() => onEnqueueAll(false)}
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
                  onClick={() => onEnqueueContainer(true)}
                >
                  <Icon name="play" size={16} />播放全部
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || isRowsLoading || isRowsError || !hasBrowsableProviderItems(result)}
                  onClick={() => onEnqueueContainer(false)}
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
              </>
            )}
            {!video && !container && (likesOnly || tab === "likes") && id === "netease" && (
              <>
                <button
                  className="text-button text-button--primary"
                  type="button"
                  disabled={busy || loading || readError || !hasBrowsableProviderItems(result)}
                  onClick={() => onEnqueueLikes(true)}
                >
                  <Icon name="play" size={16} />播放全部
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || loading || readError || !hasBrowsableProviderItems(result)}
                  onClick={() => onEnqueueLikes(false)}
                >
                  <Icon name="queue" size={16} />全部歌曲加入队列
                </button>
              </>
            )}
            {(container || video) && (
              <button className="text-button playlist-detail__back" type="button" onClick={onHandleBack}>
                <Icon name="back" size={16} />{video ? "返回视频列表" : id === "bilibili" ? "返回收藏夹列表" : "返回歌单列表"}
              </button>
            )}
            {!likesOnly && !container && !video && (
              <button className="text-button" type="button" onClick={onAccount}>
                管理此来源账号
              </button>
            )}
            <InspectorToggleButton open={inspector.inspectorOpen} onToggle={inspector.toggleInspector} />
          </div>
        </header>

        {sourceNavigation}

        {!likesOnly && !container && !video && (
          <nav className="catalog-type-tabs provider-tabs" aria-label="此来源功能">
            {tabs.map(t => (
              <button key={t} type="button" aria-pressed={t === tab} onClick={() => onNavigate(t)}>
                {tabLabels[t]}
              </button>
            ))}
          </nav>
        )}

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
                onFilterQueryChange(event.currentTarget.value);
                onFilterResultPageChange(1);
              }}
            />
            {filterQuery && (
              <button aria-label="清空搜索" type="button" onClick={() => { onFilterQueryChange(""); onFilterResultPageChange(1); }}>
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
                  onSubmitSearch(input);
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
                    onChange={event => onInputChange(event.target.value)}
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
                  onResolveLinkInput();
                }}
              >
                <label className="catalog-search">
                  <Icon name="search" size={18} />
                  <span className="sr-only">BV/AV 或视频链接</span>
                  <input
                    aria-label="BV/AV 或视频链接"
                    value={linkInput}
                    placeholder="粘贴 BV / AV 号、bilibili.com 或 b23.tv 链接直达分 P…"
                    onChange={e => onLinkInputChange(e.target.value)}
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
                entries={searchHistoryEntries.filter(entry => tabs.includes(entry.type))}
                labels={{ songs: "歌曲", playlists: "歌单", videos: "视频" }}
                onSelect={entry => onSubmitSearch(entry.query, entry.type)}
                onClear={onClearSearchHistory}
              />
            )}
          </div>
        )}

        {query && !container && !video && <p className="provider-query-summary">搜索结果：{query}</p>}
        {inListSearching && !isRowsLoading && !isRowsError && (
          <p className="provider-query-summary" role="status">“{filterQuery.trim()}” · 共 {rawMatchedRowsCount} 项匹配</p>
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
                    onChange={onToggleSelectAll}
                  />
                  {inListSearching ? "全选搜索结果" : "全选本页"}
                </label>
                <span className="playlist-songs__count">已选 {activeSelectionCount} 项</span>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || !activeSelectionCount}
                  onClick={onClearSelection}
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
                  onClick={() => (showingVideos ? onRunSelectedVideosBatch(true) : onEnqueue(orderedSelectedTracks, true))}
                >
                  <Icon name="play" size={15} />播放选中
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || !activeSelectionCount}
                  onClick={() => (showingVideos ? onRunSelectedVideosBatch(false) : onEnqueue(orderedSelectedTracks, false))}
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
                      onWrite({
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
              <button className="text-button text-button--primary" type="button" disabled={busy} onClick={() => onWrite(lastWrite, true)}>
                只读核对结果
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={onRefreshList}
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
              onClick={onRetryList}
            >
              重试
            </button>
          </div>
        ) : !pagedRowsCount ? (
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
              <button className="text-button" type="button" onClick={() => { onFilterQueryChange(""); onFilterResultPageChange(1); }}>
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
                    track={getArtworkTrack({
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
                <button className="text-button text-button--primary" type="button" onClick={() => onOpenContainer(row)}>
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
                {pagedVideoEntries.map(({ row, position }) => {
                  const checked = selectedVideos.has(row.bvid);
                  const playable = isProviderVideoPlayable(row);
                  const isPlaying = playingTrackId.startsWith(`bilibili:video:${row.bvid}:`);
                  const isInspected = inspectedVideo?.bvid === row.bvid;
                  const displayNumber = String(position + 1).padStart(2, "0");
                  return (
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
                      onClick={() => {
                        onActiveVideoBvidChange(row.bvid);
                        inspector.openInspector();
                      }}
                      onDoubleClick={() => {
                        if (!busy && playable) {
                          onActiveVideoBvidChange(row.bvid);
                          onOpenVideo(row, true);
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
                            onChange={e => onCheckVideo(row, position, e.target.checked)}
                          />
                          <span className={isPlaying ? "catalog-needle catalog-needle--active" : "catalog-needle"}>
                            {displayNumber}
                          </span>
                        </label>
                      </td>
                      <td>
                        <AlbumArtwork
                          compact
                          track={getArtworkTrack({
                            id: row.bvid,
                            title: row.title,
                            artist: row.uploader,
                            coverCacheKey: row.coverCacheKey,
                          })}
                        />
                      </td>
                      <td>
                        <div className="provider-track-cell">
                          <button
                            className="catalog-table__title"
                            type="button"
                            onClick={() => {
                              onActiveVideoBvidChange(row.bvid);
                              inspector.openInspector();
                            }}
                          >
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
                      <td className="catalog-table__duration">
                        <div className="catalog-duration-actions">
                          <TrackRowActions
                            className="catalog-row-quick-actions"
                            title={row.title}
                            variant="compact"
                            stopPropagation
                            disabled={busy || !playable}
                            onPlay={() => {
                              onActiveVideoBvidChange(row.bvid);
                              onOpenVideo(row, true);
                            }}
                            onNext={() => onOpenVideo(row, false, true)}
                            onEnqueue={() => onOpenVideo(row, false)}
                          />
                          <span>{formatDuration(row.durationMs)}</span>
                        </div>
                      </td>
                      {canRemoveFromContainer && (
                        <td onClick={e => e.stopPropagation()}>
                          <Tooltip content="移出收藏夹">
                            <button
                              className="icon-button icon-button--quiet icon-button--danger"
                              type="button"
                              disabled={busy || Boolean(lastWrite)}
                              aria-label={`将《${row.title}》移出收藏夹`}
                              onClick={() =>
                                onWrite({
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
                    </tr>
                  );
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
                {pagedTrackEntries.map(({ row, position }) => {
                  const checked = selected.has(row.id);
                  const playable = isProviderTrackPlayable(row);
                  const isPlaying = playingTrackId === row.id;
                  const isInspected = inspectedTrack?.id === row.id;
                  const displayNumber = String(position + 1).padStart(2, "0");
                  return (
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
                      onClick={() => {
                        onActiveTrackIdChange(row.id);
                        inspector.openInspector();
                      }}
                      onDoubleClick={() => {
                        if (!busy && playable) {
                          onActiveTrackIdChange(row.id);
                          onEnqueue([row], true);
                        }
                      }}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <label className="playlist-songs__check">
                          <input
                            type="checkbox"
                            aria-label={row.title}
                            checked={checked}
                            disabled={!playable || busy || (selected.size >= MAX_SEARCH_SELECT_ALL && !checked)}
                            onChange={e => onCheckTrack(row, position, e.target.checked)}
                          />
                          <span className={isPlaying ? "catalog-needle catalog-needle--active" : "catalog-needle"}>
                            {displayNumber}
                          </span>
                        </label>
                      </td>
                      <td>
                        <AlbumArtwork compact track={getArtworkTrack(row)} />
                      </td>
                      <td>
                        <div className="provider-track-cell">
                          <button
                            className="catalog-table__title"
                            type="button"
                            onClick={() => {
                              onActiveTrackIdChange(row.id);
                              inspector.openInspector();
                            }}
                          >
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
                      <td className="catalog-table__duration">
                        <div className="catalog-duration-actions">
                          <TrackRowActions
                            className="catalog-row-quick-actions"
                            title={row.title}
                            variant="compact"
                            stopPropagation
                            disabled={busy || !playable}
                            onPlay={() => {
                              onActiveTrackIdChange(row.id);
                              onEnqueue([row], true);
                            }}
                            onNext={() => onEnqueue([row], false, true)}
                            onEnqueue={() => onEnqueue([row], false)}
                          />
                          <span>{formatDuration(row.durationMs)}</span>
                        </div>
                      </td>
                      {canRemoveFromContainer && (
                        <td onClick={e => e.stopPropagation()}>
                          <Tooltip content="移出歌单">
                            <button
                              className="icon-button icon-button--quiet icon-button--danger"
                              type="button"
                              disabled={busy || Boolean(lastWrite)}
                              aria-label={`将《${row.title}》移出歌单`}
                              onClick={() =>
                                onWrite({
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
            disabled={busy || (inListSearching ? filterResultPage : video ? partsPage : page) <= 1}
            onClick={() => (inListSearching ? onFilterResultPageChange(filterResultPage - 1) : onPageChange((video ? partsPage : page) - 1))}
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
                ? filterResultPage * displayMatchSize >= rawMatchedRowsCount
                : !(video ? parts?.hasMore : result?.hasMore) || (video ? partsPage : page) >= (video ? 100 : 1000))
            }
            onClick={() => (inListSearching ? onFilterResultPageChange(filterResultPage + 1) : onPageChange((video ? partsPage : page) + 1))}
          >
            下一页
          </button>
        </nav>
      </div>

      {inspector.inspectorOpen ? (
        <aside className="catalog-inspector provider-inspector" aria-label="当前选中详情">
          <InspectorHeaderBar
            label={inspectedTrack || inspectedVideo ? "CURRENT SELECTION" : "SOURCE ARCHIVE"}
            onClose={inspector.closeInspector}
          />
          <AlbumArtwork
            compact
            track={
              inspectedTrack
                ? getArtworkTrack(inspectedTrack)
                : inspectedVideo
                  ? getArtworkTrack({
                      id: inspectedVideo.bvid,
                      title: inspectedVideo.title,
                      artist: inspectedVideo.uploader,
                      coverCacheKey: inspectedVideo.coverCacheKey,
                    })
                  : getArtworkTrack({
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
                  aria-label="下一首播放选中曲目"
                  title="下一首播放"
                  className="text-button play-next-button"
                  disabled={busy || !isProviderTrackPlayable(inspectedTrack)}
                  onClick={() => onEnqueue([inspectedTrack], false, true)}
                  type="button"
                >
                  <Icon name="play-next" size={20} />
                </button>
                <button
                  aria-label="播放此项"
                  className="text-button text-button--primary catalog-inspector__play"
                  disabled={busy || !isProviderTrackPlayable(inspectedTrack)}
                  onClick={() => {
                    onActiveTrackIdChange(inspectedTrack.id);
                    onEnqueue([inspectedTrack], true);
                  }}
                  type="button"
                >
                  <Icon name="play" size={17} />播放
                </button>
              </div>
              <button
                aria-label="加入队列"
                className="text-button"
                disabled={busy || !isProviderTrackPlayable(inspectedTrack)}
                onClick={() => onEnqueue([inspectedTrack], false)}
                type="button"
              >
                <Icon name="queue" size={17} />加入队列
              </button>
              <ProviderLibraryActions
                track={inspectedTrack}
                variant="default"
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
                  aria-label="下一首播放选中曲目"
                  title="下一首播放"
                  className="text-button play-next-button"
                  disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
                  onClick={() => onOpenVideo(inspectedVideo, false, true)}
                  type="button"
                >
                  <Icon name="play-next" size={20} />
                </button>
                <button
                  className="text-button text-button--primary catalog-inspector__play"
                  disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
                  onClick={() => {
                    onActiveVideoBvidChange(inspectedVideo.bvid);
                    onOpenVideo(inspectedVideo, true);
                  }}
                  type="button"
                >
                  <Icon name="play" size={17} />播放
                </button>
              </div>
              <button
                className="text-button"
                disabled={busy || !isProviderVideoPlayable(inspectedVideo)}
                onClick={() => onOpenVideo(inspectedVideo, false)}
                type="button"
              >
                <Icon name="queue" size={17} />加入队列
              </button>
              <ProviderLibraryActions
                track={{ id: `bilibili:video:${inspectedVideo.bvid}:1`, title: inspectedVideo.title }}
                variant="default"
                initialContainer={container?.allowedActions.includes(addAction) ? container : undefined}
              />
            </>
          ) : (
            <>
              <h3>{container ? container.title : video ? video.title : status.account.displayName}</h3>
              <p>{SOURCE_LABELS[id]} · {tabLabels[tab]}</p>
              <dl>
                <div>
                  <dt>当前账号</dt>
                  <dd>{status.account.displayName}</dd>
                </div>
                <div>
                  <dt>当前分类</dt>
                  <dd>{container ? `容器 (${container.itemCount} 项)` : video ? `分 P (${parts?.total ?? 0} P)` : tabLabels[tab]}</dd>
                </div>
                <div>
                  <dt>当前页码</dt>
                  <dd>第 {video ? partsPage : page} 页</dd>
                </div>
              </dl>
            </>
          )}
        </aside>
      ) : null}
    </section>
  );
}
