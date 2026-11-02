import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../../backend/providersAdapter";
import { providerSessionRevision } from "../../backend/providerSessions";
import type { NewProviderId, ProviderContainer, ProviderPage, ProviderTrack, ProviderVideo } from "../../contracts/providers";
import { ProviderLibraryActions } from "../library/ProviderLibraryActions";
import { PlaylistActionIcon } from "../rhine/PlaylistActionIcon";
import { RhinePlaylistDocument, RhinePlaylistSearch, RhinePlaylistSelection, RhinePlaylistRow, RhinePlaylistPagination } from "../rhine/RhinePlaylistView";
import { SourceBadge } from "./SourceBadge";

type Item = ProviderTrack | ProviderVideo;
const isTrack = (item: Item): item is ProviderTrack => "id" in item;
const playable = (item: ProviderTrack) => item.availability === "unknown";
const key = (item: Item) => isTrack(item) ? item.id : item.bvid;

export function ProviderPlaylistDetail({ id, container, video, data, loading, failed, page, pageSize, reload, busy, notice, selected, activeTrackId,
  onBack, onPage, onRefresh, onCheck, onClear, onEnqueue, onVideo, onEnqueueAll, canRemove, onRemove, verification, subscriptions,
}: {
  id: NewProviderId; container: ProviderContainer | null; video: ProviderVideo | null; data: ProviderPage<Item> | null;
  loading: boolean; failed: boolean; page: number; pageSize: number; reload: number; busy: boolean; notice: string;
  selected: Map<string, ProviderTrack>; activeTrackId: string; onBack: () => void; onPage: (page: number) => void;
  onRefresh: () => void; onCheck: (track: ProviderTrack, checked: boolean) => void; onClear: () => void;
  onEnqueue: (tracks: readonly ProviderTrack[], play: boolean) => void; onVideo: (video: ProviderVideo, play: boolean) => void;
  onEnqueueAll: (play?: boolean) => void; canRemove: boolean; onRemove: () => void;
  verification?: { disabled: boolean; onVerify: () => void }; subscriptions?: ReactNode;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [allRows, setAllRows] = useState<readonly Item[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const cached = useRef<{ reload: number; rows: readonly Item[] } | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const searching = !!normalized;
  const readPage = useCallback((n: number): Promise<ProviderPage<Item>> => video
    ? api.nativeProviderVideoParts(video.bvid, n, 100)
    : id === "netease"
      ? api.nativeProviderLibraryTracks(id, container!.id, n, 50)
      : api.nativeProviderLibraryVideos(container!.id, n, 20), [id, container?.id, video?.bvid]);
  useEffect(() => {
    if (!searching) return;
    if (cached.current?.reload === reload) { setAllRows(cached.current.rows); return; }
    let alive = true;
    const revision = providerSessionRevision(id);
    const current = () => alive && revision === providerSessionRevision(id);
    setAllRows(null); setSearchError(false);
    void (async () => {
      const items: Item[] = [];
      for (let n = 1; n <= 100; n++) {
        const response = await readPage(n);
        if (!current()) return;
        if (response.page !== n) throw new Error("playlist_page");
        items.push(...response.items);
        if (!response.hasMore) {
          cached.current = { reload, rows: items }; setAllRows(items); return;
        }
      }
      throw new Error("playlist_page_limit");
    })().catch(() => { if (current()) setSearchError(true); });
    return () => { alive = false; };
  }, [id, searching, reload, readPage, searchRetry]);
  const matches = (allRows ?? []).map((item, index) => ({ item, index })).filter(({ item }) =>
    (isTrack(item) ? `${item.title}\n${item.artist}\n${item.album}` : `${item.title}\n${item.uploader}\n${item.bvid}`).toLocaleLowerCase().includes(normalized));
  const rows = searching ? matches.slice((resultPage - 1) * 20, resultPage * 20)
    : (data?.items ?? []).map((item, index) => ({ item, index: (page - 1) * pageSize + index }));
  const shownPage = searching ? resultPage : page;
  const rowsLoading = searching ? !allRows && !searchError : loading;
  const rowsError = searching ? searchError : failed;
  const selectable = rowsLoading || rowsError ? [] : rows.flatMap(({ item }) => isTrack(item) && playable(item) ? [item] : []);
  const allChecked = selectable.length > 0 && selectable.every(item => selected.has(item.id));
  const retry = () => { cached.current = null; setSearchRetry(n => n + 1); };
  const refresh = () => { cached.current = null; setAllRows(null); setSearchError(false); setResultPage(1); onRefresh(); };
  return <RhinePlaylistDocument title={video?.title ?? container!.title} description={video ? `UP：${video.uploader}` : container!.description || "音乐档案"}
    eyebrow={`${video ? "VIDEO" : "PLAYLIST"} / ${video?.bvid ?? container!.id}`} count={<>{data?.total ?? container?.itemCount ?? "—"} {video ? "个分 P" : id === "netease" ? "首歌曲" : "个视频"}</>}
    onBack={onBack} backLabel={video ? "← 返回档案" : "← 返回档案阵列"} backName={video ? undefined : "返回容器列表"}
    onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); onBack(); } }}
    actions={video ? <button disabled={busy || loading || failed} onClick={() => onEnqueueAll()}>全部分 P 加入队列</button>
      : id === "netease" ? <><button disabled={busy || loading || failed || !data?.items.length} onClick={() => onEnqueueAll(true)}>播放全部</button>
        <button className="rhine-playlist-icon-button" title="全部歌曲加入队列" aria-label="全部歌曲加入队列" disabled={busy || loading || failed || !data?.items.length} onClick={() => onEnqueueAll(false)}><PlaylistActionIcon kind="queueAdd" /></button></> : undefined}>
    <RhinePlaylistSearch value={input} disabled={busy} searching={searching}
      placeholder={id === "bilibili" ? "在此歌单搜索视频、UP 主或 BV 号" : undefined}
      onChange={value => { setInput(value); if (!value.trim()) { setQuery(""); setResultPage(1); } }}
      onSubmit={() => { setQuery(input.trim()); setResultPage(1); }} onClear={() => { setInput(""); setQuery(""); setResultPage(1); }} onRefresh={refresh} />
    {(selectable.length > 0 || selected.size > 0 || verification) && <RhinePlaylistSelection>
      <label><input type="checkbox" checked={allChecked} disabled={busy || !selectable.length} onChange={() => {
        let count = selected.size;
        for (const item of selectable) {
          if (allChecked) onCheck(item, false);
          else if (!selected.has(item.id) && count < 100) { onCheck(item, true); count++; }
        }
      }} />全选本页</label><span>已选 {selected.size} {id === "netease" ? "首" : "项"}</span>
      <button disabled={busy || !selected.size} onClick={onClear}>清空选择</button>
      <button className="rhine-playlist-icon-button" title="播放选中" aria-label="播放选中" disabled={busy || !selected.size} onClick={() => onEnqueue([...selected.values()], true)}><PlaylistActionIcon kind="play" /></button>
      <button className="rhine-playlist-icon-button" title={`选中加入队列（${selected.size}/100）`} aria-label={`选中加入队列（${selected.size}/100）`} disabled={busy || !selected.size} onClick={() => onEnqueue([...selected.values()], false)}><PlaylistActionIcon kind="queueAdd" /></button>
      {container && <button disabled={busy || !selected.size || !canRemove} onClick={onRemove}>从当前容器移出选中</button>}
      {verification && <button disabled={busy || verification.disabled} onClick={verification.onVerify}>只读核对结果</button>}
    </RhinePlaylistSelection>}
    {subscriptions}
    {searching && !rowsLoading && !rowsError && <p className="rhine-search-count" role="status">“{query}” · {matches.length} {id === "netease" ? "首" : "项"}匹配</p>}
    <p className="rhine-notice" role="status">{notice}</p>
    {rowsLoading ? <p role="status">{searching ? "正在读取整张歌单以搜索…" : "正在读取歌曲…"}</p>
      : rowsError ? <p role="alert">{searching ? "未能读取完整歌单，搜索尚未完成" : "歌曲读取失败"} <button onClick={searching ? retry : refresh}>重试</button></p>
      : !rows.length ? <p>{searching ? "歌单内没有匹配的歌曲，换个关键词试试。" : "这个歌单还没有歌曲"}</p>
      : <ol className="rhine-songs" start={(shownPage - 1) * (searching ? 20 : pageSize) + 1}>
        {rows.map(({ item, index }) => <RhinePlaylistRow key={key(item)} title={item.title} coverCacheKey={item.coverCacheKey} number={index + 1}
          playing={isTrack(item) && item.id === activeTrackId} badge={isTrack(item) ? <SourceBadge track={item} /> : undefined}
          subtitle={isTrack(item) ? <>{item.artist} · {item.album}</> : <>UP：{item.uploader}</>}
          checkbox={isTrack(item) ? <input type="checkbox" aria-label={item.title} checked={selected.has(item.id)}
            disabled={busy || !playable(item) || (selected.size >= 100 && !selected.has(item.id))} onChange={e => onCheck(item, e.target.checked)} /> : undefined}
          actions={<>
            <button className="rhine-playlist-icon-button" title="播放" aria-label={isTrack(item) ? "播放此项" : "播放视频"}
              disabled={busy || (isTrack(item) && !playable(item))} onClick={() => isTrack(item) ? onEnqueue([item], true) : onVideo(item, true)}><PlaylistActionIcon kind="play" /></button>
            <button className="rhine-playlist-icon-button" title="加入队列" aria-label="加入队列"
              disabled={busy || (isTrack(item) && !playable(item))} onClick={() => isTrack(item) ? onEnqueue([item], false) : onVideo(item, false)}><PlaylistActionIcon kind="queueAdd" /></button>
            {isTrack(item) && <ProviderLibraryActions track={item} variant="rhine" iconOnly initialContainer={container ?? undefined} />}
          </>} />)}
      </ol>}
    <RhinePlaylistPagination page={shownPage} hasMore={searching ? resultPage * 20 < matches.length : !!data?.hasMore && page < (video ? 100 : 1000)}
      disabled={busy || rowsLoading || rowsError} onPrevious={() => searching ? setResultPage(p => p - 1) : onPage(page - 1)}
      onNext={() => searching ? setResultPage(p => p + 1) : onPage(page + 1)} />
  </RhinePlaylistDocument>;
}
