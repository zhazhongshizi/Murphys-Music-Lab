import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

export interface WindowSnapshot {
  size: {
    width: number;
    height: number;
  };
  position: {
    x: number;
    y: number;
  };
  maximized: boolean;
}

export interface MiniWindowTransition {
  snapshot: WindowSnapshot | null;
  applied: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const MINI_MIN_SIZE = new LogicalSize(320, 640);
const MINI_SIZE = new LogicalSize(360, 700);
const NORMAL_MIN_SIZE = new LogicalSize(960, 640);
const WINDOW_MINIMIZED_EVENT = "qqmusic:window-minimized";
const MAIN_WINDOW_VISIBLE_EVENT = "qqmusic:main-window-visible";

function publishWindowMinimized(minimized: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(WINDOW_MINIMIZED_EVENT, { detail: minimized }));
}

export async function windowMinimize(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
    publishWindowMinimized(true);
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowToggleMaximize(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowClose(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowIsMaximized(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

export async function windowEnterMiniMode(): Promise<MiniWindowTransition> {
  if (!isTauriRuntime()) return { snapshot: null, applied: false };

  let snapshot: WindowSnapshot | null = null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    const [size, position, maximized] = await Promise.all([
      currentWin.outerSize(),
      currentWin.outerPosition(),
      currentWin.isMaximized(),
    ]);

    snapshot = {
      size: { width: size.width, height: size.height },
      position: { x: position.x, y: position.y },
      maximized,
    };

    await currentWin.setMinSize(MINI_MIN_SIZE);
    if (maximized) await currentWin.unmaximize();
    await currentWin.setSize(MINI_SIZE);
    await currentWin.center();

    return { snapshot, applied: true };
  } catch {
    return { snapshot, applied: false };
  }
}

export async function windowRestoreNormal(snapshot: WindowSnapshot | null): Promise<boolean> {
  if (!snapshot || !isTauriRuntime()) return false;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();

    if (snapshot.maximized) {
      await currentWin.setMinSize(NORMAL_MIN_SIZE);
      await currentWin.maximize();
    } else {
      await currentWin.setSize(new PhysicalSize(snapshot.size.width, snapshot.size.height));
      await currentWin.setPosition(new PhysicalPosition(snapshot.position.x, snapshot.position.y));
      await currentWin.setMinSize(NORMAL_MIN_SIZE);
    }

    return true;
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setMinSize(NORMAL_MIN_SIZE);
    } catch {
      // Best effort only: the original failure still determines the result.
    }
    return false;
  }
}

export async function listenWindowResize(
  onResize: (maximized: boolean) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    return await currentWin.onResized(async () => {
      try {
        const maximized = await currentWin.isMaximized();
        onResize(maximized);
      } catch {
        // Ignore resize query errors.
      }
    });
  } catch {
    return () => undefined;
  }
}

export async function listenWindowMinimized(
  onMinimized: (minimized: boolean) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await subscribeWindowMinimized(getCurrentWindow(), onMinimized);
  } catch {
    return () => undefined;
  }
}

async function subscribeWindowMinimized(
  currentWin: TauriWindow,
  onMinimized: (minimized: boolean) => void,
): Promise<() => void> {
  let disposed = false;
  const publish = (minimized: boolean) => {
    if (!disposed) onMinimized(minimized);
  };
  const onExplicitState = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === "boolean") {
      publish(event.detail);
    }
  };
  const read = async () => {
    try {
      publish(await currentWin.isMinimized());
    } catch {
      // Keep observing native changes and document visibility.
    }
  };
  window.addEventListener(WINDOW_MINIMIZED_EVENT, onExplicitState);
  const listeners = await Promise.allSettled([
    currentWin.onResized(read),
    currentWin.onFocusChanged(({ payload: focused }) => {
      if (focused) publish(false);
      else void read();
    }),
  ]);
  const cleanup = () => {
    disposed = true;
    window.removeEventListener(WINDOW_MINIMIZED_EVENT, onExplicitState);
    for (const listener of listeners) {
      if (listener.status === "fulfilled") listener.value();
    }
  };
  for (const listener of listeners) {
    if (listener.status === "rejected") {
      cleanup();
      throw listener.reason;
    }
  }
  await read();
  return cleanup;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export type WindowRenderability = boolean | null;

export async function listenWindowRenderable(
  onRenderable: (renderable: WindowRenderability) => void,
): Promise<() => void> {
  const native = isTauriRuntime();
  let disposed = false;
  let windowVisible: boolean | null = native ? null : true;
  let minimized: boolean | null = native ? null : false;
  let lastPublished: WindowRenderability | undefined;
  let unlistenVisible: () => void = () => undefined;
  let unlistenMinimized: () => void = () => undefined;

  const publish = () => {
    if (disposed) return;
    const renderable = !documentIsVisible() || windowVisible === false || minimized === true
      ? false
      : windowVisible === true && minimized === false ? true : null;
    if (renderable === lastPublished) return;
    lastPublished = renderable;
    onRenderable(renderable);
  };
  const onDocumentVisibility = () => publish();
  document.addEventListener("visibilitychange", onDocumentVisibility);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onDocumentVisibility);
    unlistenVisible();
    unlistenMinimized();
  };

  publish();
  if (!native) return cleanup;

  try {
    const [{ listen }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/window"),
    ]);
    const currentWin = getCurrentWindow();
    unlistenVisible = await listen<unknown>(MAIN_WINDOW_VISIBLE_EVENT, ({ payload }) => {
      if (typeof payload !== "boolean") return;
      windowVisible = payload;
      publish();
    });
    unlistenMinimized = await subscribeWindowMinimized(currentWin, (nextMinimized) => {
      minimized = nextMinimized;
      publish();
    });
    windowVisible = await currentWin.isVisible();
    publish();
  } catch {
    windowVisible = null;
    minimized = null;
    publish();
    unlistenVisible();
    unlistenVisible = () => undefined;
    unlistenMinimized();
    unlistenMinimized = () => undefined;
  }

  return cleanup;
}

export async function listenWindowFocused(
  onFocused: (focused: boolean) => void,
): Promise<() => void> {
  let disposed = false;
  let lastPublished: boolean | undefined;
  let unlistenFocus: () => void = () => undefined;
  const publish = (focused: boolean) => {
    if (disposed || focused === lastPublished) return;
    lastPublished = focused;
    onFocused(focused);
  };
  const onFocus = () => publish(true);
  const onBlur = () => publish(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    unlistenFocus();
  };

  if (!isTauriRuntime()) {
    publish(true);
    return cleanup;
  }

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    unlistenFocus = await currentWin.onFocusChanged(({ payload: focused }) => {
      publish(focused);
    });
    let initialFocused = true;
    if (typeof currentWin.isFocused === "function") {
      try {
        initialFocused = await currentWin.isFocused();
      } catch {
        initialFocused = true;
      }
    }
    publish(initialFocused);
  } catch {
    publish(true);
    unlistenFocus();
    unlistenFocus = () => undefined;
  }

  return cleanup;
}
