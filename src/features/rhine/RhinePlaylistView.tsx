import type { KeyboardEventHandler, ReactNode } from "react";
import { SongCover } from "./SongCover";

export function RhinePlaylistDocument({ title, description, eyebrow, count, actions, onBack, backLabel = "← 返回档案阵列", backName, onKeyDown, children }: {
  title: string; description: string; eyebrow: string; count: ReactNode; actions?: ReactNode;
  onBack: () => void; backLabel?: string; backName?: string; onKeyDown?: KeyboardEventHandler<HTMLElement>; children: ReactNode;
}) {
  return <section className="rhine-document rhine-playlist-document" aria-label="歌单详情" onKeyDown={onKeyDown}>
    <button className="rhine-back" aria-label={backName} onClick={onBack}>{backLabel}</button>
    <p className="rhine-eyebrow">{eyebrow}</p>
    <h2>{title}</h2><p>{description || "音乐档案"}</p>
    <div className="rhine-document-actions"><span>{count}</span>{actions && <span className="rhine-playlist-heading-actions">{actions}</span>}</div>
    {children}
  </section>;
}

export function RhinePlaylistSearch({ value, onChange, onSubmit, onRefresh, onClear, disabled, searching, placeholder = "在此歌单搜索歌曲、歌手或专辑" }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onRefresh: () => void;
  onClear: () => void; disabled: boolean; searching: boolean; placeholder?: string;
}) {
  return <form className="rhine-playlist-search rhine-search-form" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
    <input type="search" aria-label="在歌单内搜索" placeholder={placeholder} maxLength={100} value={value} onChange={e => onChange(e.target.value)} />
    <button type="submit" disabled={!value.trim()}>搜索</button>
    <button type="button" disabled={disabled} onClick={onRefresh}>刷新歌单</button>
    {searching && <button type="button" onClick={onClear}>清除</button>}
  </form>;
}

export function RhinePlaylistSelection({ children }: { children: ReactNode }) {
  return <div className="rhine-playlist-selection" role="group" aria-label="批量选择歌曲">{children}</div>;
}

export function RhinePlaylistRow({ title, coverCacheKey, subtitle, badge, checkbox, actions, playing, number }: {
  title: string; coverCacheKey?: string; subtitle: ReactNode; badge?: ReactNode; checkbox?: ReactNode;
  actions: ReactNode; playing: boolean; number: number;
}) {
  return <li value={number} data-playing={playing}>
    <div className={`rhine-song-info${checkbox ? " rhine-song-info--editable" : ""}`}>
      {checkbox}<SongCover cacheKey={coverCacheKey} title={title} />
      <span className="rhine-song-text"><strong>{title}{badge}</strong><small>{subtitle}</small></span>
    </div>
    <span className="rhine-song-actions">{actions}</span>
  </li>;
}

export function RhinePlaylistPagination({ page, hasMore, disabled, onPrevious, onNext }: {
  page: number; hasMore: boolean; disabled: boolean; onPrevious: () => void; onNext: () => void;
}) {
  return <nav className="rhine-pages" aria-label="歌曲分页">
    <button disabled={disabled || page === 1} onClick={onPrevious}>上一页</button><span>第 {page} 页</span>
    <button disabled={disabled || !hasMore} onClick={onNext}>下一页</button>
  </nav>;
}
