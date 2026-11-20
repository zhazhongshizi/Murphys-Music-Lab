import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../../backend/providersAdapter";
import { providerSessionRevision } from "../../backend/providerSessions";
import type { NewProviderId, ProviderContainer, ProviderPage, ProviderTrack, ProviderVideo } from "../../contracts/providers";
import { Icon } from "../../components/Icon";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { PlaylistActionIcon } from "../rhine/PlaylistActionIcon";
import { RhinePlaylistDocument, RhinePlaylistSearch, RhinePlaylistSelection, RhinePlaylistRow, RhinePlaylistPagination } from "../rhine/RhinePlaylistView";
import { SourceBadge } from "./SourceBadge";
import {
  MAX_SEARCH_SELECT_ALL,
  hasBrowsableProviderItems,
  isProviderTrackPlayable,
  isProviderVideoPlayable,
  readAllProviderPages,
  sortSelectedProviderTracks,
  type OrderedTrackSelection,
} from "./providerListHelpers";

type Item = ProviderTrack | ProviderVideo;
const isTrack = (item: Item): item is ProviderTrack => "id" in item;
const playable = (item: ProviderTrack) => isProviderTrackPlayable(item);
const key = (item: Item) => isTrack(item) ? item.id : item.bvid;

export function ProviderPlaylistDetail({ id, container, video, data, loading, failed, page, pageSize, reload, busy, notice, selected, playingTrackId,
  onBack, onPage, onRefresh, onCheck, onClear, onEnqueue, onVideo, onEnqueueAll, canRemove, onRemove, verification, subscriptions,
}: {
  id: NewProviderId; container: ProviderContainer | null; video: ProviderVideo | null; data: ProviderPage<Item> | null;
  loading: boolean; failed: boolean; page: number; pageSize: number; reload: number; busy: boolean; notice: string;
  selected: ReadonlyMap<string, OrderedTrackSelection>; playingTrackId: string; onBack: () => void; onPage: (page: number) => void;
  onRefresh: () => void; onCheck: (track: ProviderTrack, position: number, checked: boolean) => void; onClear: () => void;
  onEnqueue: (tracks: readonly ProviderTrack[], play: boolean, next?: boolean) => void; onVideo: (video: ProviderVideo, play: boolean, next?: boolean) => void;
  onEnqueueAll: (play?: boolean) => void; canRemove: boolean; onRemove: () => void;
  verification?: { disabled: boolean; onVerify: () => void }; subscriptions?: ReactNode;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [allRows, setAllRows] = useState<readonly Item[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const [selectCapNotice, setSelectCapNotice] = useState("");
  const cached = useRef<{ reload: number; rows: readonly Item[] } | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const searching = !!normalized;
  const readPage = useCallback((n: number): Promise<ProviderPage<Item>> => video
    ? api.nativeProviderVideoParts(video.bvid, n, 100)
    : id === "netease"
      ? api.nativeProviderLibraryTracks(id, container!.id, n, 50)
      : api.nativeProviderLibraryVideos(container!.id, n, 20), [id, container?.id, video?.bvid]);
  const isVideoParts = Boolean(video);
  useEffect(() => {
    if (!searching) return;
    if (cached.current?.reload === reload) { setAllRows(cached.current.rows); return; }
    let alive = true;
    const revision = providerSessionRevision(id);
    const current = () => alive && revision === providerSessionRevision(id);
    setAllRows(null); setSearchError(false);
    void readAllProviderPages<Item>(
      (n) => readPage(n),
      isVideoParts ? 100 : id === "netease" ? 50 : 20,
      current,
      {
        maxItems: Number.POSITIVE_INFINITY,
        allowEmptyPages: Boolean(!isVideoParts && id === "bilibili"),
      },
    )
      .then(read => {
        if (read.aborted || !current()) return;
        if (read.truncated) {
          setSearchError(true);
          return;
        }
        cached.current = { reload, rows: read.items };
        setAllRows(read.items);
      })
      .catch(() => { if (current()) setSearchError(true); });
    return () => { alive = false; };
  }, [id, searching, reload, readPage, searchRetry, isVideoParts]);
  const matches = (allRows ?? []).map((item, index) => ({ item, index })).filter(({ item }) =>
    (isTrack(item) ? `${item.title}\n${item.artist}\n${item.album}\n${item.video?.partTitle ?? ""}` : `${item.title}\n${item.uploader}\n${item.bvid}`).toLocaleLowerCase("zh-CN").includes(normalized));
  const rows = searching ? matches.slice((resultPage - 1) * 20, resultPage * 20)
    : (data?.items ?? []).map((item, index) => ({ item, index: (page - 1) * pageSize + index }));
  const shownPage = searching ? resultPage : page;
  const rowsLoading = searching ? !allRows && !searchError : loading;
  const rowsError = searching ? searchError : failed;
  const selectScopeRows = searching ? matches : rows;
  const selectable = rowsLoading || rowsError ? [] : selectScopeRows.flatMap(({ item, index }) => isTrack(item) && playable(item) ? [{ track: item, position: index }] : []);
  const selectedInScopeCount = selectable.filter(({ track }) => selected.has(track.id)).length;
  const allChecked = selectable.length > 0 && selectedInScopeCount === selectable.length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedInScopeCount > 0 && !allChecked;
    }
  }, [allChecked, selectedInScopeCount]);
  const retry = () => { cached.current = null; setSearchRetry(n => n + 1); };
  const refresh = () => { cached.current = null; setAllRows(null); setSearchError(false); setResultPage(1); setSelectCapNotice(""); onRefresh(); };
  const orderedSelected = sortSelectedProviderTracks(selected);
  const backText = video
    ? container
      ? id === "bilibili"
        ? "返回收藏夹"
        : "返回歌单"
      : "返回"
    : id === "netease"
      ? "返回歌单列表"
      : "返回收藏夹列表";
  const removeButtonLabel = id === "netease" ? "从当前歌单移出选中" : "从当前收藏夹移出选中";
  const itemUnit = video ? "个分 P" : id === "netease" ? "首" : "项";
  return <RhinePlaylistDocument title={video?.title ?? container!.title} description={video ? `UP：${video.uploader}` : container!.description || "音乐档案"}
    eyebrow={`${video ? "VIDEO" : "PLAYLIST"} / ${video?.bvid ?? container!.id}`} count={<>{data?.total ?? container?.itemCount ?? "—"} {video ? "个分 P" : id === "netease" ? "首歌曲" : "个视频"}</>}
    onBack={onBack} backLabel={backText}
    onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); onBack(); } }}
    actions={video ? <><button disabled={busy || loading || failed || !hasBrowsableProviderItems(data)} onClick={() => onEnqueueAll(true)}>播放全部分 P</button>
        <button className="rhine-playlist-icon-button" title="全部分 P 加入队列" aria-label="全部分 P 加入队列" disabled={busy || loading || failed || !hasBrowsableProviderItems(data)} onClick={() => onEnqueueAll(false)}><PlaylistActionIcon kind="queueAdd" /></button></>
      : (id === "netease" || id === "bilibili") ? <><button disabled={busy || loading || failed || !hasBrowsableProviderItems(data)} onClick={() => onEnqueueAll(true)}>播放全部</button>
        <button className="rhine-playlist-icon-button" title={id === "bilibili" ? "全部加入队列" : "全部歌曲加入队列"} aria-label={id === "bilibili" ? "全部加入队列" : "全部歌曲加入队列"} disabled={busy || loading || failed || !hasBrowsableProviderItems(data)} onClick={() => onEnqueueAll(false)}><PlaylistActionIcon kind="queueAdd" /></button></> : undefined}>
    <RhinePlaylistSearch value={input} disabled={busy} searching={searching}
      placeholder={video ? "在此视频搜索分 P 标题" : id === "bilibili" ? "在此收藏夹搜索视频、UP 主或 BV 号" : undefined}
      onChange={value => { setInput(value); if (!value.trim()) { setQuery(""); setResultPage(1); setSelectCapNotice(""); } }}
      onSubmit={() => { setQuery(input.trim()); setResultPage(1); setSelectCapNotice(""); }} onClear={() => { setInput(""); setQuery(""); setResultPage(1); setSelectCapNotice(""); }} onRefresh={refresh} />
    {(selectable.length > 0 || selected.size > 0 || verification) && <RhinePlaylistSelection>
      <label><input ref={selectAllRef} type="checkbox" checked={allChecked} disabled={busy || !selectable.length} onChange={() => {
        setSelectCapNotice("");
        let count = selected.size;
        let capped = false;
        for (const { track, position } of selectable) {
          if (allChecked) onCheck(track, position, false);
          else if (!selected.has(track.id)) {
            if (count < MAX_SEARCH_SELECT_ALL) { onCheck(track, position, true); count++; }
            else { capped = true; }
          }
        }
        if (capped) setSelectCapNotice(`最多同时选择 ${MAX_SEARCH_SELECT_ALL} 项`);
      }} />{searching ? "全选搜索结果" : "全选本页"}</label><span>已选 {selected.size} {itemUnit}</span>
      <button disabled={busy || !selected.size} onClick={() => { setSelectCapNotice(""); onClear(); }}>清空选择</button>
      <button className="rhine-playlist-icon-button" title="播放选中" aria-label="播放选中" disabled={busy || !selected.size} onClick={() => onEnqueue(orderedSelected, true)}><PlaylistActionIcon kind="play" /></button>
      <button className="rhine-playlist-icon-button" title={`选中加入队列（${selected.size}/${MAX_SEARCH_SELECT_ALL}）`} aria-label={`选中加入队列（${selected.size}/${MAX_SEARCH_SELECT_ALL}）`} disabled={busy || !selected.size} onClick={() => onEnqueue(orderedSelected, false)}><PlaylistActionIcon kind="queueAdd" /></button>
      {container && !video && <button disabled={busy || !selected.size || !canRemove} onClick={onRemove}>{removeButtonLabel}</button>}
      {verification && <button disabled={busy || verification.disabled} onClick={verification.onVerify}>只读核对结果</button>}
    </RhinePlaylistSelection>}
    {subscriptions}
    {searching && !rowsLoading && !rowsError && <p className="rhine-search-count" role="status">“{query}” · {matches.length} {itemUnit}匹配</p>}
    {(selectCapNotice || notice) && <p className="rhine-notice" role="status">{selectCapNotice || notice}</p>}
    {rowsLoading ? <p role="status">{searching ? "正在读取完整列表以搜索…" : "正在读取列表…"}</p>
      : rowsError ? <p role="alert">{searching ? "未能读取完整列表，搜索尚未完成" : "列表读取失败"} <button onClick={searching ? retry : refresh}>重试</button></p>
      : !rows.length ? <p>{searching ? "当前筛选下没有匹配项，换个关键词试试。" : video ? "这个视频还没有可浏览的分 P" : id === "bilibili" ? "这个收藏夹还没有视频" : "这个歌单还没有歌曲"}</p>
      : <ol className="rhine-songs" start={(shownPage - 1) * (searching ? 20 : pageSize) + 1}>
        {rows.map(({ item, index }) => <RhinePlaylistRow key={key(item)} title={item.title} coverCacheKey={item.coverCacheKey} number={index + 1}
          playing={isTrack(item) && item.id === playingTrackId} badge={isTrack(item) ? <SourceBadge track={item} /> : undefined}
          subtitle={isTrack(item) ? <>{item.artist} · {item.album}</> : <>UP：{item.uploader}</>}
          checkbox={isTrack(item) ? <input type="checkbox" aria-label={item.title} checked={selected.has(item.id)}
            disabled={busy || !playable(item) || (selected.size >= MAX_SEARCH_SELECT_ALL && !selected.has(item.id))} onChange={e => onCheck(item, index, e.target.checked)} /> : undefined}
          actions={<>
            <button className="play-next-button" title="下一首播放" aria-label={`下一首播放 ${item.title}`}
              disabled={busy || (isTrack(item) ? !playable(item) : !isProviderVideoPlayable(item))} onClick={() => isTrack(item) ? onEnqueue([item], false, true) : onVideo(item, false, true)}><Icon name="play-next" size={20} /></button>
            <button className="rhine-playlist-icon-button" title="播放" aria-label="播放"
              disabled={busy || (isTrack(item) ? !playable(item) : !isProviderVideoPlayable(item))} onClick={() => isTrack(item) ? onEnqueue([item], true) : onVideo(item, true)}><PlaylistActionIcon kind="play" /></button>
            <button className="rhine-playlist-icon-button" title="加入队列" aria-label="加入队列"
              disabled={busy || (isTrack(item) ? !playable(item) : !isProviderVideoPlayable(item))} onClick={() => isTrack(item) ? onEnqueue([item], false) : onVideo(item, false)}><PlaylistActionIcon kind="queueAdd" /></button>
            {isTrack(item) && <ProviderLibraryActions track={item} variant="rhine" iconOnly initialContainer={container ?? undefined} />}
          </>} />)}
      </ol>}
    <RhinePlaylistPagination page={shownPage} hasMore={searching ? resultPage * 20 < matches.length : !!data?.hasMore && page < (video ? 100 : 1000)}
      disabled={busy || rowsLoading || rowsError} onPrevious={() => searching ? setResultPage(p => p - 1) : onPage(page - 1)}
      onNext={() => searching ? setResultPage(p => p + 1) : onPage(page + 1)} />
  </RhinePlaylistDocument>;
}
