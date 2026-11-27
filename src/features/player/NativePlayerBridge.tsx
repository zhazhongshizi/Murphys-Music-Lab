import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeProviderSessions } from "../../backend/providerSessions";
import { hasPlaybackTransport, playbackConnectionRevision, subscribePlaybackConnection } from "../../backend/playbackTransport";
import type { WindowRenderability } from "../../backend/windowAdapter";

import { getTimedLyrics } from "../../backend/lyricsAdapter";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import type { LyricTimeline } from "../../contracts/lyrics";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
} from "./playerStore";

const POLL_INTERVAL_MS = 500;
const UNFOCUSED_POLL_INTERVAL_MS = 2000;
const PROVIDER_LIKES_INTERVAL_MS = 15_000;
let refreshRequest: Promise<void> | null = null;
const lyricRequests = new Map<string, Promise<LyricTimeline>>();

const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;
const selectNativeLoaded = (snapshot: PlayerSnapshot) => snapshot.nativeLoaded;
const selectGeneration = (snapshot: PlayerSnapshot) => snapshot.generation;

function isTauriRuntime() {
  return hasPlaybackTransport();
}

function refreshNativeSnapshot() {
  if (!refreshRequest) {
    refreshRequest = playerActions.hydrateNativeSession().finally(() => {
      refreshRequest = null;
    });
  }
  return refreshRequest;
}

function readLyrics(
  trackId: string,
  generation: number,
  offset: number,
  connectionRevision: number,
  sessionRevision: number,
) {
  const key = `${trackId}:${generation}:${offset}:${connectionRevision}:${sessionRevision}`;
  const existing = lyricRequests.get(key);
  if (existing) return existing;
  lyricRequests.clear();
  const request = getTimedLyrics(trackId, generation).finally(() => {
    lyricRequests.delete(key);
  });
  lyricRequests.set(key, request);
  return request;
}

export function NativePlayerBridge({
  renderable = true,
  focused = true,
}: {
  readonly renderable?: WindowRenderability;
  readonly focused?: boolean;
} = {}) {
  const lifecycleRef = useRef({ renderable, focused });
  lifecycleRef.current = { renderable, focused };
  const syncPollingRef = useRef<(() => void) | null>(null);
  const [sessionRevisions, setSessionRevisions] = useState({ bilibili: 0, netease: 0 });

  useEffect(() => {
    return subscribeProviderSessions((id) => {
      if (id === "netease") playerActions.invalidateProviderLikes();
      if (id === "bilibili" || id === "netease") {
        setSessionRevisions((prev) => ({ ...prev, [id]: prev[id] + 1 }));
      }
    });
  }, []);

  useEffect(() => {
    if (!renderable) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      void playerActions.refreshProviderLikes();
    };
    refreshIfVisible();
    const interval = window.setInterval(refreshIfVisible, PROVIDER_LIKES_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [renderable]);
  const connectionRevision = useSyncExternalStore(subscribePlaybackConnection, playbackConnectionRevision, playbackConnectionRevision);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const nativeLoaded = usePlayerSelector(selectNativeLoaded);
  const generation = usePlayerSelector(selectGeneration);
  const lyricOffset = usePlayerSelector(s => s.lyricOffsetMs ?? 0);
  const trackId = usePlayerSelector((snapshot) => getCurrentTrack(snapshot)?.id ?? null);
  const providerSessionRevision = trackId?.startsWith("bilibili:")
    ? sessionRevisions.bilibili
    : trackId?.startsWith("netease:")
      ? sessionRevisions.netease
      : 0;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let timer: number | null = null;
    let activeIntervalMs: number | null = null;
    const stopPolling = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      activeIntervalMs = null;
    };
    const syncPolling = () => {
      const { renderable: nextRenderable, focused: nextFocused } = lifecycleRef.current;
      if (nextRenderable === false || document.visibilityState !== "visible") {
        stopPolling();
        return;
      }
      const nextIntervalMs = nextRenderable === true && nextFocused
        ? POLL_INTERVAL_MS
        : UNFOCUSED_POLL_INTERVAL_MS;
      if (timer !== null && activeIntervalMs === nextIntervalMs) return;
      const wasStopped = timer === null;
      stopPolling();
      if (wasStopped) {
        void refreshNativeSnapshot().catch(() => undefined);
      }
      activeIntervalMs = nextIntervalMs;
      timer = window.setInterval(() => {
        void refreshNativeSnapshot().catch(() => undefined);
      }, nextIntervalMs);
    };

    syncPollingRef.current = syncPolling;
    document.addEventListener("visibilitychange", syncPolling);
    syncPolling();
    return () => {
      syncPollingRef.current = null;
      stopPolling();
      document.removeEventListener("visibilitychange", syncPolling);
    };
  }, []);

  useEffect(() => {
    syncPollingRef.current?.();
  }, [renderable, focused]);

  useEffect(() => {
    if (!nativeMode || !nativeLoaded || !trackId) return;
    if (localMusicFormatFromId(trackId)) {
      lyricRequests.clear();
      playerActions.applyTimedLyrics(trackId, generation, []);
      return;
    }
    let active = true;
    void readLyrics(trackId, generation, lyricOffset, connectionRevision, providerSessionRevision).then(
      (timeline) => {
        if (active) {
          playerActions.applyTimedLyrics(
            timeline.trackId,
            timeline.generation,
            timeline.lines,
            timeline.source,
            timeline.timelineEndMs,
          );
        }
      },
      () => { if (active) playerActions.failTimedLyrics(trackId, generation); },
    );
    return () => {
      active = false;
    };
  }, [generation, nativeLoaded, nativeMode, trackId, connectionRevision, lyricOffset, providerSessionRevision]);

  return null;
}
