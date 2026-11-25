import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasPlaybackTransport, invokePlayback, isRemotePlayback } from "../../backend/playbackTransport";
import "./update-settings.css";

interface CacheStatus {
  enabled: boolean;
  preloadEnabled: boolean;
  available: boolean;
  usedBytes: number;
  limitMib: number;
  gameModeEnabled: boolean;
  gameModeLimitKbPerSec: number;
}

type CacheRequest =
  | { action: "status" | "clear" }
  | { action: "configure"; enabled: boolean; limitMib: number; preloadEnabled?: boolean }
  | { action: "configureGameMode"; enabled: boolean; limitKbPerSec: number };

const MIN_GAME_MODE_LIMIT = 16;
const MAX_GAME_MODE_LIMIT = 16384;

function validGameModeLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_GAME_MODE_LIMIT && value <= MAX_GAME_MODE_LIMIT;
}

async function readStatus(request: CacheRequest): Promise<CacheStatus> {
  const value = await invokePlayback("media_cache_control", { request }) as Partial<CacheStatus> | null;
  if (!value || typeof value.enabled !== "boolean" || typeof value.preloadEnabled !== "boolean" || typeof value.available !== "boolean"
    || typeof value.limitMib !== "number" || !Number.isSafeInteger(value.limitMib)
    || typeof value.usedBytes !== "number" || !Number.isSafeInteger(value.usedBytes) || value.usedBytes < 0
    || typeof value.gameModeEnabled !== "boolean" || !validGameModeLimit(value.gameModeLimitKbPerSec)) {
    throw new Error("media_cache_invalid_response");
  }
  const { enabled, preloadEnabled, available, usedBytes, limitMib, gameModeEnabled, gameModeLimitKbPerSec } = value;
  return { enabled, preloadEnabled, available, usedBytes, limitMib, gameModeEnabled, gameModeLimitKbPerSec };
}

export default function MediaCacheSettings({ presentation = "normal" }: { presentation?: "normal" | "rhine" }) {
  const [open, setOpen] = useState(false);
  const title = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  if (!hasPlaybackTransport() || isRemotePlayback()) return null;
  return <>
    <button ref={trigger} type="button" className={presentation === "rhine" ? "rhine-update-trigger" : undefined}
      role={presentation === "normal" ? "menuitem" : undefined} onClick={() => setOpen(true)}>平滑播放与缓存</button>
    {open && createPortal(<CacheDialog title={title} close={() => { setOpen(false); trigger.current?.focus(); }} />, document.body)}
  </>;
}

function CacheDialog({ title, close }: { title: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    readStatus({ action: "status" }).then(value => {
      if (active) setStatus(value);
    }).catch(() => { if (active) setError("暂时无法读取播放缓存设置。"); });
    return () => { active = false; };
  }, []);

  async function run(request: CacheRequest, afterSaved?: () => void) {
    setBusy(true);
    setError("");
    try {
      const next = await readStatus(request);
      setStatus(next);
      afterSaved?.();
    } catch {
      const messages = {
        status: "暂时无法读取播放缓存设置。",
        clear: "暂时无法清理播放缓存。",
        configure: "暂时无法保存播放缓存设置。",
        configureGameMode: "暂时无法保存游戏模式设置。",
      };
      setError(messages[request.action]);
    } finally {
      setBusy(false);
    }
  }

  const limit = limitDraft ?? String(status?.limitMib ?? "");
  const rate = rateDraft ?? String(status?.gameModeLimitKbPerSec ?? "");
  const gameModeLimit = Number(rate);
  const size = Number(limit);
  const validLimit = Number.isInteger(size) && size >= 16 && size <= 16384;
  return <dialog ref={dialog} className="update-dialog" aria-labelledby={title}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id={title}>平滑播放与缓存</h2><button type="button" onClick={close}>关闭</button></header>
    {status ? <>
      <label className="update-auto">
        <input type="checkbox" checked={status.enabled} disabled={busy}
          onChange={event => void run({ action: "configure", enabled: event.target.checked, limitMib: status.limitMib })} />
        启用平滑播放与在线歌曲缓存
      </label>
      <p className="update-muted">切换后请重新点播。重播时仍需联网确认当前账号可播放该音质。</p>
      <label>
        <input type="checkbox" checked={status.preloadEnabled && status.enabled} disabled={busy || !status.enabled}
          onChange={event => void run({ action: "configure", enabled: status.enabled, limitMib: status.limitMib, preloadEnabled: event.target.checked })} />
        预加载下一首歌曲和封面
      </label>
      <p role="status">{status.available
        ? `程序旁 media-cache 已占用 ${(status.usedBytes / 1048576).toFixed(1)} MiB`
        : "磁盘缓存不可用，仍可在线播放。"}</p>
      <form onSubmit={event => {
        event.preventDefault();
        if (validLimit && !busy && status.available && size !== status.limitMib) {
          void run({ action: "configure", enabled: status.enabled, limitMib: size }, () => setLimitDraft(null));
        }
      }}>
        <label>容量上限（MiB） <input type="number" min={16} max={16384} value={limit}
          disabled={busy || !status.available} onChange={event => setLimitDraft(event.target.value)} required /></label>
        <div className="update-actions">
          <button type="submit" disabled={busy || !status.available || !validLimit || size === status.limitMib}>保存上限</button>
          <button type="button" disabled={busy || status.usedBytes === 0} onClick={() => void run({ action: "clear" })}>清理媒体缓存</button>
        </div>
      </form>
      <fieldset className="update-card media-cache-game-mode" disabled={busy}>
        <legend>游戏模式</legend>
        <label className="update-auto">
          <input type="checkbox" checked={status.gameModeEnabled}
            onChange={event => void run({ action: "configureGameMode", enabled: event.target.checked, limitKbPerSec: status.gameModeLimitKbPerSec })} />
          启用游戏模式
        </label>
        <p>开启后，在线音频、封面和预加载共用此上限。调整会在播放中生效。正在直连的 QQ 歌曲需重新点播。</p>
        <form onSubmit={event => {
          event.preventDefault();
          if (!busy && validGameModeLimit(gameModeLimit) && gameModeLimit !== status.gameModeLimitKbPerSec) {
            void run({ action: "configureGameMode", enabled: status.gameModeEnabled, limitKbPerSec: gameModeLimit }, () => setRateDraft(null));
          }
        }}>
          <label>总限速（KB/s） <input type="number" min={MIN_GAME_MODE_LIMIT} max={MAX_GAME_MODE_LIMIT} value={rate}
            onChange={event => setRateDraft(event.target.value)} required /></label>
          <button type="submit" disabled={!validGameModeLimit(gameModeLimit) || gameModeLimit === status.gameModeLimitKbPerSec}>保存限速</button>
        </form>
      </fieldset>
    </> : !error && <p role="status">正在读取播放缓存设置…</p>}
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
