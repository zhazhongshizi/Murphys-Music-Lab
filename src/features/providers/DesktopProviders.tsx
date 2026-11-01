import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isRemotePlayback } from "../../backend/playbackTransport";
import { nativeProviderStatus, ProviderAdapterError } from "../../backend/providersAdapter";
import { subscribeProviderSessions } from "../../backend/providerSessions";
import type { NewProviderId, ProviderId, ProviderSnapshot } from "../../contracts/providers";
import "./providers.css";

export const SOURCE_LABELS: Record<ProviderId, string> = { qqmusic: "QQ 音乐", netease: "网易云", bilibili: "Bilibili", local: "本地音乐" };
type Context = {
  source: ProviderId;
  selectSource: (id: ProviderId) => void;
  snapshots: Partial<Record<NewProviderId, ProviderSnapshot>>;
  refresh: (id: NewProviderId) => Promise<void>;
};
const ProviderContext = createContext<Context>({ source: "qqmusic", selectSource() {}, snapshots: {}, async refresh() {} });
export const useDesktopProviders = () => useContext(ProviderContext);
export function DesktopProviders({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<ProviderId>(() => {
    try { const saved = localStorage.getItem("qqmusic_browse_source_v1"); return saved && Object.hasOwn(SOURCE_LABELS, saved) ? saved as ProviderId : "qqmusic"; } catch { return "qqmusic"; }
  });
  const [snapshots, setSnapshots] = useState<Context["snapshots"]>({});
  const requests = useRef({ netease: 0, bilibili: 0 });
  const live = useRef(false);
  useEffect(() => { try { localStorage.setItem("qqmusic_browse_source_v1", source); } catch { /* Optional UI preference. */ } }, [source]);
  function refresh(id: NewProviderId): Promise<void> {
    if (!live.current || isRemotePlayback() || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
    const request = ++requests.current[id];
    const job = (async () => {
      // Only a cancelled local snapshot is read once more. No upstream request,
      // provider startup, authentication attempt or write is retried here.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const status = await nativeProviderStatus(id);
          if (live.current && request === requests.current[id]) setSnapshots(prev => ({ ...prev, [id]: status }));
          return;
        } catch (error) {
          if (!live.current || request !== requests.current[id] || !(error instanceof ProviderAdapterError) || error.upstreamCode !== "cancelled") return;
        }
      }
    })();
    return job;
  }
  useEffect(() => {
    live.current = true;
    const unsubscribe = subscribeProviderSessions(id => {
      // Gate cached pages immediately; a new local status read establishes Ready.
      setSnapshots(prev => { const next = { ...prev }; delete next[id]; return next; });
    });
    void refresh("netease"); void refresh("bilibili");
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") { void refresh("netease"); void refresh("bilibili"); }
    }, 15000);
    return () => { live.current = false; requests.current.netease++; requests.current.bilibili++; clearInterval(timer); unsubscribe(); };
  }, []);
  return <ProviderContext.Provider value={{ source, selectSource: setSource, snapshots, refresh }}>{children}</ProviderContext.Provider>;
}
export function SourceNavigation({ variant = "default", onSelect, onAccount }: { variant?: "default" | "rhine"; onSelect?: (source: ProviderId) => void; onAccount?: () => void }) {
  const { source, selectSource, snapshots } = useDesktopProviders();
  if (isRemotePlayback()) return null;
  return <nav className="provider-sources" data-variant={variant} aria-label="音乐来源">
    {(["qqmusic", "netease", "bilibili"] as const).map(id => <button type="button" key={id} aria-pressed={source === id} onClick={() => { selectSource(id); onSelect?.(id); }}>{SOURCE_LABELS[id]}</button>)}
    {onAccount && <button type="button" onClick={onAccount}>{SOURCE_LABELS[source]}账号{(source === "netease" || source === "bilibili") && snapshots[source]?.state === "ready" ? " · 已登录" : ""}</button>}
  </nav>;
}
