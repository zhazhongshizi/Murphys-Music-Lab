import type { ReactNode } from "react";

export function ArchiveSearchHeading({ onClose }: { onClose: () => void }) {
  return <header className="rhine-search-heading"><button type="button" onClick={onClose}>← 返回档案</button><span className="rhine-eyebrow">ARCHIVE / 音乐检索</span></header>;
}

export function ArchiveSearchBody({ history, children }: { history?: ReactNode; children: ReactNode }) {
  if (history === undefined) return <>{children}</>;
  return <div className="rhine-search-body"><aside className="rhine-search-history">{history}</aside><div className="rhine-search-results rhine-playlist-document">{children}</div></div>;
}
