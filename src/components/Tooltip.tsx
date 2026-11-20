import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

type ChildElement = ReactElement<{ "aria-describedby"?: string; disabled?: boolean }>;

export interface TooltipProps {
  content: string | null | undefined;
  side?: "top" | "bottom";
  delayMs?: number;
  children: ChildElement;
}

let keyboardInteractionInitialized = false;
let lastInteractionWasKeyboard = false;

function ensureKeyboardTracker() {
  if (keyboardInteractionInitialized || typeof window === "undefined") return;
  keyboardInteractionInitialized = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") {
        lastInteractionWasKeyboard = true;
      }
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      lastInteractionWasKeyboard = false;
    },
    true,
  );
}

function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function Tooltip({ content, side = "top", delayMs = 400, children }: TooltipProps) {
  ensureKeyboardTracker();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; side: "top" | "bottom" }>({
    left: 0,
    top: 0,
    side,
  });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipId = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const resolvedSide: "top" | "bottom" =
      side === "top" && rect.top < 44
        ? "bottom"
        : side === "bottom" && rect.bottom > window.innerHeight - 44
          ? "top"
          : side;
    const top = resolvedSide === "top" ? rect.top - 8 : rect.bottom + 8;
    const centerX = rect.left + rect.width / 2;
    const tooltipWidth = tooltipRef.current?.getBoundingClientRect().width ?? 0;
    const halfWidth = tooltipWidth > 0 ? tooltipWidth / 2 : 0;
    const minLeft = halfWidth + 8;
    const maxLeft = Math.max(minLeft, window.innerWidth - halfWidth - 8);
    const left = Math.max(minLeft, Math.min(centerX, maxLeft));
    setCoords({ left, top, side: resolvedSide });
  }, [side]);

  const showNow = useCallback(() => {
    clearTimer();
    updatePosition();
    setOpen(true);
  }, [clearTimer, updatePosition]);

  const hideNow = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [content, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideNow();
    };
    const onViewportChange = () => updatePosition();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [hideNow, open, updatePosition]);

  if (!content) return children;

  const prevDescribedBy = isValidElement(children) ? children.props["aria-describedby"] : undefined;
  const nextDescribedBy = open
    ? [prevDescribedBy, tooltipId].filter(Boolean).join(" ")
    : prevDescribedBy;

  const enhancedChild = isValidElement(children)
    ? cloneElement(children, { "aria-describedby": nextDescribedBy })
    : children;

  function onPointerEnter(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.pointerType === "touch") return;
    clearTimer();
    if (delayMs <= 0) {
      showNow();
      return;
    }
    timerRef.current = window.setTimeout(showNow, delayMs);
  }

  return (
    <span
      className="app-tooltip-anchor"
      onBlurCapture={hideNow}
      onFocusCapture={(event) => {
        if (lastInteractionWasKeyboard || matchesFocusVisible(event.target)) {
          showNow();
        }
      }}
      onPointerDown={hideNow}
      onPointerEnter={onPointerEnter}
      onPointerLeave={hideNow}
      ref={anchorRef}
    >
      {enhancedChild}
      {open && typeof document !== "undefined"
        ? createPortal(
          <span
            className="app-tooltip"
            data-side={coords.side}
            id={tooltipId}
            ref={tooltipRef}
            role="tooltip"
            style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
          >
            {content}
          </span>,
          document.body,
        )
        : null}
    </span>
  );
}
