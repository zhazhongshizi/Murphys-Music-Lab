import { SourceBadge } from "../providers/SourceBadge";
import { APP_NAME, APP_SHORT_NAME } from "../../app/branding";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlaybackMode,
  type PlayerSnapshot,
} from "../player/playerStore";
import type { Track } from "../player/fixtures";
import { lyricIndexAt } from "../stage/ListeningStage";
import {
  deriveTerminalUpNext,
  type TerminalUpNext,
} from "./nextTrackPreview";
import { TerminalUpNextRunway } from "./TerminalUpNextRunway";
import { TerminalVinyl } from "./TerminalVinyl";

type TerminalPanel = "now-playing" | "lyrics" | "queue";

const MANUAL_LYRIC_SCROLL_RESUME_MS = 4_000;
const PROGRAMMATIC_LYRIC_SCROLL_SETTLE_MS = 600;

const selectQueue = (snapshot: PlayerSnapshot) => snapshot.queue;
const selectIsPlaying = (snapshot: PlayerSnapshot) => snapshot.isPlaying;
const selectVolume = (snapshot: PlayerSnapshot) => snapshot.volume;
const selectMuted = (snapshot: PlayerSnapshot) => snapshot.muted;
const selectMode = (snapshot: PlayerSnapshot) => snapshot.mode;
const selectLikedIds = (snapshot: PlayerSnapshot) => snapshot.likedIds;
const selectPlaybackError = (snapshot: PlayerSnapshot) => snapshot.playbackError;
const selectPosition = (snapshot: PlayerSnapshot) => snapshot.positionMs;

const MODE_LABELS: Record<PlaybackMode, string> = {
  sequence: "SEQUENCE",
  "repeat-all": "REPEAT ALL",
  "repeat-one": "REPEAT ONE",
  shuffle: "SHUFFLE",
};

function formatTime(milliseconds: number | null | undefined) {
  const totalSeconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stateLabel(isPlaying: boolean, hasTrack: boolean, hasError: boolean) {
  if (hasError) return "ERROR";
  if (!hasTrack) return "IDLE";
  return isPlaying ? "PLAYING" : "PAUSED";
}

interface TerminalKeyButtonProps {
  disabled?: boolean;
  shortcut: string;
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  active?: boolean;
  emphasis?: boolean;
}

function TerminalKeyButton({
  shortcut,
  label,
  onClick,
  active = false,
  emphasis = false,
  disabled = false,
}: TerminalKeyButtonProps) {
  const className = [
    "terminal-key",
    active ? "terminal-key--active" : "",
    emphasis ? "terminal-key--emphasis" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      aria-label={`${shortcut} ${label}`}
      aria-pressed={active}
      className={className}
      disabled={disabled}
      data-tauri-drag-region="false"
      onClick={onClick}
      type="button"
    >
      <strong>{shortcut}</strong>
      <span>{label}</span>
    </button>
  );
}

function pointerFraction(clientX: number, target: HTMLElement): number | null {
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function useHorizontalSliderDrag(
  enabled: boolean,
  onCommit: (fraction: number) => void,
) {
  const [draftFraction, setDraftFraction] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const lastReleaseRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const releaseClearTimerRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    draggingRef.current = false;
    pointerIdRef.current = null;
    draftRef.current = null;
    setDraftFraction(null);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(() => () => {
    if (releaseClearTimerRef.current !== null) {
      window.clearTimeout(releaseClearTimerRef.current);
    }
  }, []);

  const markReleased = useCallback((clientX: number, clientY: number) => {
    lastReleaseRef.current = { clientX, clientY };
    if (releaseClearTimerRef.current !== null) {
      window.clearTimeout(releaseClearTimerRef.current);
    }
    releaseClearTimerRef.current = window.setTimeout(() => {
      lastReleaseRef.current = null;
      releaseClearTimerRef.current = null;
    }, 0);
  }, []);

  const isMatchingPointer = (event: ReactPointerEvent<HTMLElement>) =>
    draggingRef.current
    && (pointerIdRef.current === null || event.pointerId === undefined || event.pointerId === pointerIdRef.current);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.button !== 0 && event.button !== undefined)) return;
    const fraction = pointerFraction(event.clientX, event.currentTarget);
    if (fraction === null) return;
    event.preventDefault();
    lastReleaseRef.current = null;
    draggingRef.current = true;
    pointerIdRef.current = typeof event.pointerId === "number" ? event.pointerId : null;
    draftRef.current = fraction;
    setDraftFraction(fraction);
    if (typeof event.pointerId === "number") {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }, [enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || !isMatchingPointer(event)) return;
    const fraction = pointerFraction(event.clientX, event.currentTarget);
    if (fraction === null) return;
    draftRef.current = fraction;
    setDraftFraction(fraction);
  }, [enabled]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isMatchingPointer(event)) return;
    const fraction = pointerFraction(event.clientX, event.currentTarget) ?? draftRef.current;
    markReleased(event.clientX, event.clientY);
    reset();
    if (typeof event.pointerId === "number" && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (enabled && fraction !== null) {
      onCommit(fraction);
    }
  }, [enabled, markReleased, onCommit, reset]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isMatchingPointer(event)) return;
    reset();
  }, [reset]);

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isMatchingPointer(event)) return;
    const fraction = draftRef.current;
    markReleased(event.clientX, event.clientY);
    reset();
    if (enabled && fraction !== null) {
      onCommit(fraction);
    }
  }, [enabled, markReleased, onCommit, reset]);

  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const released = lastReleaseRef.current;
    if (released && released.clientX === event.clientX && released.clientY === event.clientY) {
      lastReleaseRef.current = null;
      return;
    }
    if (!enabled) return;
    const fraction = pointerFraction(event.clientX, event.currentTarget);
    if (fraction !== null) {
      onCommit(fraction);
    }
  }, [enabled, onCommit]);

  return {
    draftFraction,
    isDragging: draftFraction !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onClick,
    },
  };
}

interface TerminalProgressProps {
  durationMs: number | null;
}

function TerminalProgress({ durationMs }: TerminalProgressProps) {
  const positionMs = usePlayerSelector(selectPosition);
  const duration = Math.max(0, durationMs ?? 0);
  const commitSeek = useCallback((fraction: number) => {
    if (duration <= 0) return;
    playerActions.seek(Math.round(fraction * duration));
  }, [duration]);

  const { draftFraction, isDragging, handlers } = useHorizontalSliderDrag(duration > 0, commitSeek);
  const rawDisplayMs = draftFraction !== null ? Math.round(draftFraction * duration) : positionMs;
  const displayMs = duration === 0 ? 0 : Math.min(duration, Math.max(0, rawDisplayMs));
  const progress = duration === 0 ? 0 : Math.min(1, Math.max(0, displayMs / duration));
  const draggingClass = duration > 0 && isDragging ? " is-dragging" : "";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    let nextMs: number | null = null;
    if (event.key === "ArrowLeft") {
      nextMs = Math.max(0, displayMs - 5_000);
    } else if (event.key === "ArrowRight") {
      nextMs = Math.min(duration, displayMs + 5_000);
    } else if (event.key === "PageUp") {
      nextMs = Math.min(duration, displayMs + 15_000);
    } else if (event.key === "PageDown") {
      nextMs = Math.max(0, displayMs - 15_000);
    } else if (event.key === "Home") {
      nextMs = 0;
    } else if (event.key === "End") {
      nextMs = duration;
    }
    if (nextMs === null) return;
    event.preventDefault();
    event.stopPropagation();
    playerActions.seek(nextMs);
  };

  return (
    <div className="terminal-progress" data-testid="terminal-progress">
      <span className="terminal-progress__time">{formatTime(displayMs)}</span>
      <div
        aria-label="播放进度"
        aria-valuemax={duration}
        aria-valuemin={0}
        aria-valuenow={displayMs}
        aria-valuetext={`${formatTime(displayMs)} / ${formatTime(duration)}`}
        className={`terminal-progress__track${draggingClass}`}
        data-tauri-drag-region="false"
        onKeyDown={handleKeyDown}
        role="slider"
        tabIndex={duration > 0 ? 0 : -1}
        {...handlers}
      >
        <span className="terminal-progress__fill" style={{ width: `${progress * 100}%` }} />
        <i className="terminal-progress__cursor" style={{ left: `${progress * 100}%` }} />
      </div>
      <span className="terminal-progress__time">{formatTime(duration)}</span>
    </div>
  );
}

interface TerminalVolumeProps {
  volume: number;
  muted: boolean;
}

function TerminalVolume({ volume, muted }: TerminalVolumeProps) {
  const commitVolume = useCallback((fraction: number) => {
    playerActions.setVolume(fraction);
  }, []);

  const { draftFraction, isDragging, handlers } = useHorizontalSliderDrag(true, commitVolume);
  const displayVol = draftFraction ?? volume;
  const percent = Math.round(displayVol * 100);
  const litBlocks = Math.round(displayVol * 12);
  const showMuted = muted && !isDragging;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextVol: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextVol = Math.max(0, Math.round((displayVol - 0.05) * 100) / 100);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextVol = Math.min(1, Math.round((displayVol + 0.05) * 100) / 100);
    } else if (event.key === "Home") {
      nextVol = 0;
    } else if (event.key === "End") {
      nextVol = 1;
    }
    if (nextVol === null) return;
    event.preventDefault();
    event.stopPropagation();
    playerActions.setVolume(nextVol);
  };

  return (
    <div className="terminal-volume" aria-label="音量">
      <span>VOL</span>
      <div
        aria-label="音量"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        aria-valuetext={showMuted ? "已静音" : `${percent}%`}
        className={`terminal-volume__blocks${isDragging ? " is-dragging" : ""}`}
        data-tauri-drag-region="false"
        onKeyDown={handleKeyDown}
        role="slider"
        tabIndex={0}
        {...handlers}
      >
        {Array.from({ length: 12 }, (_, index) => (
          <i aria-hidden="true" className={index < litBlocks && !showMuted ? "is-on" : ""} key={index} />
        ))}
      </div>
      <strong>{showMuted ? "MUTED" : `${percent}%`}</strong>
    </div>
  );
}

interface TerminalLyricPreviewProps {
  track: Track | null;
}

function TerminalLyricPreview({ track }: TerminalLyricPreviewProps) {
  const positionMs = usePlayerSelector(selectPosition);
  if (!track || track.lyrics.length === 0) {
    return <p className="terminal-lyric-preview terminal-lyric-preview--empty">NO LYRICS AVAILABLE</p>;
  }
  const activeIndex = lyricIndexAt(positionMs, track.lyrics);
  const current = track.lyrics[activeIndex];
  const next = track.lyrics[activeIndex + 1];
  return (
    <div className="terminal-lyric-preview">
      <p>{current?.original ?? "等待歌词"}</p>
      <span>{next?.original ?? "—"}</span>
    </div>
  );
}

interface TerminalLyricsPanelProps {
  track: Track | null;
}

function TerminalLyricsPanel({ track }: TerminalLyricsPanelProps) {
  const positionMs = usePlayerSelector(selectPosition);
  const activeIndex = track && track.lyrics.length > 0 ? lyricIndexAt(positionMs, track.lyrics) : -1;
  const containerRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const manualScrollTimer = useRef<number | null>(null);
  const programmaticScroll = useRef(false);
  const lastActiveIndex = useRef(-1);
  const [userScrolling, setUserScrolling] = useState(false);

  useEffect(() => {
    if (userScrolling || activeIndex < 0) return;
    if (!activeRef.current || !containerRef.current) return;
    if (activeIndex === lastActiveIndex.current) return;
    lastActiveIndex.current = activeIndex;

    programmaticScroll.current = true;
    if (typeof activeRef.current.scrollIntoView === "function") {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const timer = window.setTimeout(() => {
      programmaticScroll.current = false;
    }, PROGRAMMATIC_LYRIC_SCROLL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, userScrolling]);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) return;

    setUserScrolling(true);
    if (manualScrollTimer.current !== null) {
      window.clearTimeout(manualScrollTimer.current);
    }
    manualScrollTimer.current = window.setTimeout(() => {
      setUserScrolling(false);
      manualScrollTimer.current = null;
      lastActiveIndex.current = -1;
    }, MANUAL_LYRIC_SCROLL_RESUME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (manualScrollTimer.current !== null) {
        window.clearTimeout(manualScrollTimer.current);
      }
    };
  }, []);

  return (
    <section
      aria-label="歌词"
      className="terminal-panel terminal-panel--lyrics"
      onScroll={handleScroll}
      ref={containerRef}
    >
      <div className="terminal-panel__heading">
        <span>LYRICS</span>
        <small>{track?.title ?? "NO TRACK"}</small>
      </div>
      {track?.lyrics.length ? (
        <div className="terminal-lyrics-list">
          {track.lyrics.map((line, index) => (
            <p
              aria-current={index === activeIndex ? "true" : undefined}
              className={index === activeIndex ? "is-active" : index < activeIndex ? "is-past" : ""}
              key={`${line.atMs}-${index}`}
              ref={index === activeIndex ? activeRef : undefined}
            >
              <span>{line.original}</span>
              {line.translation ? <small>{line.translation}</small> : null}
            </p>
          ))}
        </div>
      ) : (
        <p className="terminal-panel__empty">NO LYRICS AVAILABLE</p>
      )}
    </section>
  );
}

interface TerminalQueuePanelProps {
  currentTrack: Track | null;
  queue: readonly Track[];
}

function TerminalQueuePanel({ currentTrack, queue }: TerminalQueuePanelProps) {
  return (
    <section aria-label="播放队列" className="terminal-panel terminal-panel--queue">
      <div className="terminal-panel__heading">
        <span>QUEUE</span>
        <small>{queue.length} TRACKS</small>
      </div>
      {queue.length === 0 ? (
        <p className="terminal-panel__empty">QUEUE IS EMPTY</p>
      ) : (
        <ol className="terminal-queue-list">
          {queue.map((track, index) => {
            const active = track.id === currentTrack?.id;
            return (
              <li className={active ? "is-active" : ""} key={track.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <button onClick={() => playerActions.playTrack(track.id)} type="button">
                  <strong>{track.title}</strong>
                  <SourceBadge track={track} />
                  <small>{track.artist}</small>
                </button>
                {active ? <i aria-label="正在播放">●</i> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

interface TerminalNowPlayingProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  mode: PlaybackMode;
  volume: number;
  muted: boolean;
  liked: boolean;
  playbackError: string | null;
  upNext: TerminalUpNext;
  onPanelChange: (panel: TerminalPanel) => void;
}

function TerminalNowPlaying({
  currentTrack,
  isPlaying,
  mode,
  volume,
  muted,
  liked,
  playbackError,
  upNext,
  onPanelChange,
}: TerminalNowPlayingProps) {
  const status = stateLabel(isPlaying, Boolean(currentTrack), Boolean(playbackError));
  return (
    <main className="terminal-mini__body" id="main-content">
      <section className="terminal-now-playing">
        <div className="terminal-mini__vinyl-wrap">
          <TerminalVinyl hasTrack={Boolean(currentTrack)} isPlaying={isPlaying} />
          <span className="terminal-vinyl-caption">↻ 33⅓ RPM · {status}</span>
        </div>

        <section aria-label="当前歌曲" className="terminal-track-info">
          <span className="terminal-eyebrow">NOW PLAYING</span>
          <h1>{currentTrack?.title ?? "Nothing playing"}</h1>
          {currentTrack && <SourceBadge track={currentTrack} />}
          <p>{currentTrack?.artist ?? "从曲库选择一首歌"}</p>
          <small>{currentTrack?.album ?? "VINYL GREENHOUSE"}</small>
        </section>

        <TerminalLyricPreview track={currentTrack} />

        <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />

        {playbackError ? <p className="terminal-error" role="status">{playbackError}</p> : null}

        <nav aria-label="主要播放控制" className="terminal-controls terminal-controls--primary">
          <TerminalKeyButton label="PREV" onClick={() => playerActions.previous()} shortcut="P" />
          <TerminalKeyButton
            emphasis
            label={isPlaying ? "PAUSE" : "PLAY"}
            onClick={() => playerActions.toggle()}
            shortcut="SPACE"
          />
          <TerminalKeyButton label="NEXT" onClick={() => playerActions.next()} shortcut="N" />
        </nav>

        <section aria-label="播放信息" className="terminal-track-meta">
          <TerminalVolume muted={muted} volume={volume} />
          <span className="terminal-track-meta__mode">
            <i>SESSION //</i>
            <strong>{MODE_LABELS[mode]}</strong>
            <strong className={liked ? "is-active" : ""}>{liked ? "LIKED" : "NOT LIKED"}</strong>
          </span>
        </section>

        <nav aria-label="次要播放控制" className="terminal-controls terminal-controls--secondary">
          <TerminalKeyButton label="LYRICS" onClick={() => onPanelChange("lyrics")} shortcut="L" />
          <TerminalKeyButton label="QUEUE" onClick={() => onPanelChange("queue")} shortcut="Q" />
          <TerminalKeyButton label="LIKE" disabled={!currentTrack || currentTrack.id.startsWith("bilibili:") || currentTrack.id.startsWith("local_")} onClick={() => currentTrack && playerActions.toggleLike(currentTrack.id)} shortcut="F" active={liked} />
          <TerminalKeyButton label="MUTE" onClick={() => playerActions.toggleMute()} shortcut="M" active={muted} />
          <TerminalKeyButton label="MODE" onClick={() => playerActions.cycleMode()} shortcut="O" />
        </nav>

        <TerminalUpNextRunway model={upNext} />
      </section>
    </main>
  );
}

export interface TerminalMiniModeProps {
  onExit: () => void;
}

export function TerminalMiniMode({ onExit }: TerminalMiniModeProps) {
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const queue = usePlayerSelector(selectQueue);
  const isPlaying = usePlayerSelector(selectIsPlaying);
  const volume = usePlayerSelector(selectVolume);
  const muted = usePlayerSelector(selectMuted);
  const mode = usePlayerSelector(selectMode);
  const likedIds = usePlayerSelector(selectLikedIds);
  const playbackError = usePlayerSelector(selectPlaybackError);
  const [panel, setPanel] = useState<TerminalPanel>("now-playing");
  const liked = currentTrack ? likedIds.includes(currentTrack.id) : false;
  const upNext = deriveTerminalUpNext(currentTrack, queue, mode, 5);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || Boolean(target.closest("button, input, textarea, select, a[href]")))
      ) return;

      const key = event.key.toLowerCase();
      if (event.key === " ") {
        event.preventDefault();
        playerActions.toggle();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        playerActions.seekBy(-5_000);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        playerActions.seekBy(5_000);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        playerActions.setVolume(Math.min(1, volume + 0.05));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        playerActions.setVolume(Math.max(0, volume - 0.05));
      } else if (key === "p") {
        event.preventDefault();
        playerActions.previous();
      } else if (key === "n") {
        event.preventDefault();
        playerActions.next();
      } else if (key === "m") {
        event.preventDefault();
        playerActions.toggleMute();
      } else if (key === "o") {
        event.preventDefault();
        playerActions.cycleMode();
      } else if (key === "f") {
        event.preventDefault();
        if (currentTrack) playerActions.toggleLike(currentTrack.id);
      } else if (key === "l") {
        event.preventDefault();
        setPanel("lyrics");
      } else if (key === "q") {
        event.preventDefault();
        setPanel("queue");
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPanel("now-playing");
      } else if (key === "g") {
        event.preventDefault();
        onExit();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTrack, onExit, volume]);

  return (
    <div className="terminal-mini" data-testid="terminal-mini">
      <header className="terminal-mini__header" data-tauri-drag-region>
        <div className="terminal-mini__brand" data-tauri-drag-region>
          <span aria-hidden="true" className="terminal-mini__mark">◇</span>
          <div>
            <strong title={APP_NAME}>{APP_SHORT_NAME}</strong>
            <span>{stateLabel(isPlaying, Boolean(currentTrack), Boolean(playbackError))} · VINYL GREENHOUSE</span>
          </div>
        </div>
        <Tooltip content="返回标准界面 (G)" side="bottom">
          <button className="terminal-mini__exit" data-tauri-drag-region="false" onClick={onExit} type="button">
            <Icon name="restore" size={14} />
            <span>G GUI</span>
          </button>
        </Tooltip>
      </header>

      {panel === "now-playing" ? (
        <TerminalNowPlaying
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          liked={liked}
          mode={mode}
          muted={muted}
          onPanelChange={setPanel}
          playbackError={playbackError?.message ?? null}
          upNext={upNext}
          volume={volume}
        />
      ) : panel === "lyrics" ? (
        <main className="terminal-mini__body terminal-mini__body--panel" id="main-content">
          <TerminalLyricsPanel track={currentTrack} />
          <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />
          <nav aria-label="终端面板控制" className="terminal-controls terminal-controls--panel">
            <TerminalKeyButton label="NOW PLAYING" onClick={() => setPanel("now-playing")} shortcut="ESC" />
            <TerminalKeyButton label="QUEUE" onClick={() => setPanel("queue")} shortcut="Q" />
          </nav>
        </main>
      ) : (
        <main className="terminal-mini__body terminal-mini__body--panel" id="main-content">
          <TerminalQueuePanel currentTrack={currentTrack} queue={queue} />
          <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />
          <nav aria-label="终端面板控制" className="terminal-controls terminal-controls--panel">
            <TerminalKeyButton label="NOW PLAYING" onClick={() => setPanel("now-playing")} shortcut="ESC" />
            <TerminalKeyButton label="LYRICS" onClick={() => setPanel("lyrics")} shortcut="L" />
          </nav>
        </main>
      )}
    </div>
  );
}
