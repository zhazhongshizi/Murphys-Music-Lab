import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type { LyricLine } from "../player/fixtures";
import type { LyricsStatus } from "../player/playerStore";
import "./scrolling-lyrics.css";

interface ScrollingLyricsProps {
  readonly lyrics: readonly LyricLine[];
  readonly activeIndex: number;
  readonly pastCount?: number;
  readonly positionMs?: number;
  readonly sourceLabel?: string;
  readonly lyricsStatus?: LyricsStatus;
  readonly emptyMessage?: string;
  readonly onSeek?: (atMs: number) => void;
}

const MANUAL_SCROLL_RESUME_MS = 4_000;
const DRAG_THRESHOLD_PX = 5;

function formatMmSs(atMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(atMs) ? atMs : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(index, length - 1));
}

export function ScrollingLyrics({
  lyrics,
  activeIndex,
  pastCount,
  positionMs,
  sourceLabel,
  lyricsStatus,
  emptyMessage,
  onSeek,
}: ScrollingLyricsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const manualScrollTimer = useRef<number | null>(null);
  const [userScrolling, setUserScrolling] = useState(false);
  const programmaticScroll = useRef(false);
  const programmaticScrollTimer = useRef<number | null>(null);
  const lastActiveIndex = useRef(-1);
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const listId = useId();
  const seekable = Boolean(onSeek) && lyrics.length > 0;
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(() => clampIndex(activeIndex, lyrics.length));
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressResetTimerRef = useRef<number | null>(null);

  const effectiveFocusedIndex = keyboardActive
    ? clampIndex(focusedIndex, lyrics.length)
    : clampIndex(activeIndex, lyrics.length);

  const clearManualScroll = useCallback(() => {
    if (manualScrollTimer.current !== null) {
      window.clearTimeout(manualScrollTimer.current);
      manualScrollTimer.current = null;
    }
    setUserScrolling(false);
  }, []);

  const clearSuppressResetTimer = useCallback(() => {
    if (suppressResetTimerRef.current !== null) {
      window.clearTimeout(suppressResetTimerRef.current);
      suppressResetTimerRef.current = null;
    }
  }, []);

  const releaseProgrammaticScrollSoon = useCallback((container: HTMLDivElement | null) => {
    if (programmaticScrollTimer.current !== null) {
      window.clearTimeout(programmaticScrollTimer.current);
      programmaticScrollTimer.current = null;
    }
    if (!container) {
      programmaticScroll.current = false;
      return;
    }
    const release = () => {
      programmaticScroll.current = false;
      if (programmaticScrollTimer.current !== null) {
        window.clearTimeout(programmaticScrollTimer.current);
        programmaticScrollTimer.current = null;
      }
    };
    container.addEventListener("scrollend", release, { once: true });
    programmaticScrollTimer.current = window.setTimeout(release, 600);
    return () => {
      container.removeEventListener("scrollend", release);
      if (programmaticScrollTimer.current !== null) {
        window.clearTimeout(programmaticScrollTimer.current);
        programmaticScrollTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setKeyboardActive(false);
    setFocusedIndex(clampIndex(activeIndexRef.current, lyrics.length));
    lineRefs.current.length = lyrics.length;
  }, [lyrics]);

  // Recenter after a tablet rotation or panel resize, without resetting outro state.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined" || userScrolling) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const current = activeIndexRef.current;
      const active = current >= 0 ? lineRefs.current[current] : null;
      if (!active) return;
      programmaticScroll.current = true;
      container.scrollTo({ top: active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2, behavior: "instant" });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { programmaticScroll.current = false; }, 600);
    });
    observer.observe(container);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [userScrolling, lyrics]);

  useEffect(() => {
    if (activeIndex < 0) {
      lastActiveIndex.current = -1;
      return;
    }
    if (userScrolling || keyboardActive) return;
    const active = lineRefs.current[activeIndex];
    const container = containerRef.current;
    if (!active || !container) return;
    if (activeIndex === lastActiveIndex.current) return;
    lastActiveIndex.current = activeIndex;

    const reducedMotion = typeof window !== "undefined"
      && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    programmaticScroll.current = true;
    if (typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "center" });
    }

    return releaseProgrammaticScrollSoon(container);
  }, [activeIndex, userScrolling, keyboardActive, releaseProgrammaticScrollSoon]);

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
    }, MANUAL_SCROLL_RESUME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (manualScrollTimer.current !== null) {
        window.clearTimeout(manualScrollTimer.current);
      }
      if (programmaticScrollTimer.current !== null) {
        window.clearTimeout(programmaticScrollTimer.current);
      }
      clearSuppressResetTimer();
    };
  }, [clearSuppressResetTimer]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!seekable || event.button !== 0) return;
    clearSuppressResetTimer();
    suppressNextClickRef.current = false;
    pointerOriginRef.current = { x: event.clientX, y: event.clientY };
  }, [seekable, clearSuppressResetTimer]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const origin = pointerOriginRef.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > DRAG_THRESHOLD_PX) {
      suppressNextClickRef.current = true;
    }
  }, []);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const origin = pointerOriginRef.current;
    if (origin) {
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > DRAG_THRESHOLD_PX) {
        suppressNextClickRef.current = true;
      }
      pointerOriginRef.current = null;
    }
    if (suppressNextClickRef.current) {
      clearSuppressResetTimer();
      suppressResetTimerRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = false;
        suppressResetTimerRef.current = null;
      }, 0);
    }
  }, [clearSuppressResetTimer]);

  const handlePointerCancel = useCallback(() => {
    pointerOriginRef.current = null;
    clearSuppressResetTimer();
    suppressNextClickRef.current = false;
  }, [clearSuppressResetTimer]);

  const handleLineClick = useCallback((line: LyricLine, index: number) => {
    if (!onSeek) return;
    const suppressed = suppressNextClickRef.current;
    suppressNextClickRef.current = false;
    clearSuppressResetTimer();
    if (suppressed) return;
    if ((window.getSelection?.()?.toString().trim().length ?? 0) > 0) return;

    clearManualScroll();
    setKeyboardActive(false);
    setFocusedIndex(index);
    lastActiveIndex.current = -1;
    onSeek(line.atMs);
  }, [onSeek, clearSuppressResetTimer, clearManualScroll]);

  const handleContainerKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!seekable || !onSeek) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const base = keyboardActive ? focusedIndex : activeIndex;
      const next = event.key === "ArrowDown"
        ? clampIndex(base + 1, lyrics.length)
        : clampIndex((base < 0 ? 0 : base) - 1, lyrics.length);
      setKeyboardActive(true);
      setFocusedIndex(next);

      const target = lineRefs.current[next];
      if (target && typeof target.scrollIntoView === "function") {
        programmaticScroll.current = true;
        target.scrollIntoView({ block: "nearest" });
        releaseProgrammaticScrollSoon(containerRef.current);
      }
      return;
    }

    if (event.key === "Enter") {
      const targetIndex = clampIndex(keyboardActive ? focusedIndex : activeIndex, lyrics.length);
      const targetLine = lyrics[targetIndex];
      if (!targetLine) return;
      event.preventDefault();
      clearManualScroll();
      setKeyboardActive(false);
      setFocusedIndex(targetIndex);
      lastActiveIndex.current = -1;
      onSeek(targetLine.atMs);
      return;
    }

    if (event.key === "Escape") {
      if (!keyboardActive && !userScrolling) return;
      event.preventDefault();
      if (keyboardActive) {
        event.stopPropagation();
      }
      setKeyboardActive(false);
      setFocusedIndex(clampIndex(activeIndex, lyrics.length));
      clearManualScroll();
      lastActiveIndex.current = -1;
    }
  }, [seekable, onSeek, keyboardActive, focusedIndex, activeIndex, lyrics, userScrolling, clearManualScroll, releaseProgrammaticScrollSoon]);

  const handleContainerBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!seekable) return;
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setKeyboardActive(false);
    }
  }, [seekable]);

  if (lyrics.length === 0) {
    const emptyStatus = lyricsStatus === "error"
      ? "error"
      : lyricsStatus === "pending"
        ? "pending"
        : "empty";
    return (
      <section aria-label="同步歌词" className="lyrics-scroll" data-lyrics-status={emptyStatus}>
        <p className="lyrics-scroll__eyebrow">正在播放 · 歌词</p>
        <div className="lyrics-scroll__empty">
          <p className="lyrics-scroll__line lyrics-scroll__line--active">{emptyMessage ?? "暂无歌词"}</p>
        </div>
      </section>
    );
  }

  const eyebrowLabel = sourceLabel ? `正在播放 · 歌词 · ${sourceLabel}` : "正在播放 · 歌词";

  return (
    <section aria-label="同步歌词" className="lyrics-scroll" data-lyrics-status={lyricsStatus ?? "ready"}>
      <p className="lyrics-scroll__eyebrow">{eyebrowLabel}</p>
      <div
        ref={containerRef}
        className="lyrics-scroll__container"
        role={seekable ? "listbox" : undefined}
        aria-label={seekable ? "歌词列表" : undefined}
        tabIndex={seekable ? 0 : undefined}
        aria-activedescendant={seekable && effectiveFocusedIndex >= 0 ? `${listId}-line-${effectiveFocusedIndex}` : undefined}
        onScroll={handleScroll}
        onKeyDown={seekable ? handleContainerKeyDown : undefined}
        onBlur={seekable ? handleContainerBlur : undefined}
        onPointerDown={seekable ? handlePointerDown : undefined}
        onPointerMove={seekable ? handlePointerMove : undefined}
        onPointerUp={seekable ? handlePointerUp : undefined}
        onPointerCancel={seekable ? handlePointerCancel : undefined}
      >
        <div className="lyrics-scroll__spacer" />

        {lyrics.map((line, index) => {
          const isActive = index === activeIndex;
          const isPast = !isActive && (
            pastCount !== undefined
              ? index < pastCount
              : positionMs !== undefined
                ? line.atMs <= positionMs
                : activeIndex >= 0 && index < activeIndex
          );
          const isKeyboardFocused = seekable && keyboardActive && index === effectiveFocusedIndex;
          const lineId = seekable ? `${listId}-line-${index}` : undefined;
          const cls = [
            "lyrics-scroll__line",
            isActive && "lyrics-scroll__line--active",
            isPast && "lyrics-scroll__line--past",
            !isActive && !isPast && "lyrics-scroll__line--upcoming",
            seekable && "lyrics-scroll__line--seekable",
            isKeyboardFocused && "lyrics-scroll__line--keyboard-active",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={line.atMs + "-" + index}
              id={lineId}
              ref={(el) => {
                lineRefs.current[index] = el;
              }}
              className={cls}
              role={seekable ? "option" : undefined}
              aria-selected={seekable ? (keyboardActive ? isKeyboardFocused : isActive) : undefined}
              aria-current={isActive ? "true" : undefined}
              onClick={seekable ? () => handleLineClick(line, index) : undefined}
            >
              <p
                className="lyrics-scroll__original"
                aria-live={isActive ? "polite" : undefined}
                aria-atomic={isActive ? "true" : undefined}
              >
                {line.original}
              </p>
              {seekable ? (
                <span className="lyrics-scroll__timestamp" aria-hidden="true">
                  {formatMmSs(line.atMs)}
                </span>
              ) : null}
              {line.translation ? (
                <p className="lyrics-scroll__translation">{line.translation}</p>
              ) : null}
              {line.romanized ? (
                <p className="lyrics-scroll__romanized">{line.romanized}</p>
              ) : null}
            </div>
          );
        })}

        <div className="lyrics-scroll__spacer" />
      </div>

      {userScrolling ? (
        <button
          type="button"
          className="lyrics-scroll__back-button"
          onClick={() => {
            clearManualScroll();
            lastActiveIndex.current = -1;
          }}
        >
          回到当前
        </button>
      ) : null}
    </section>
  );
}
