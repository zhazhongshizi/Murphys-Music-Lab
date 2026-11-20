import { useEffect, useState } from "react";
import { nativeSetMvFallbackEnabled, nativeSettingsSnapshot } from "../../backend/settingsAdapter";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { getCurrentTrack, playerActions, usePlayerSelector } from "./playerStore";

export function MvFallbackSetting() {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let alive = true;
    void nativeSettingsSnapshot().then(settings => { if (alive) setEnabled(settings.mvFallbackEnabled ?? true); })
      .catch(() => { if (alive) setError("未能读取 MV 补播设置"); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [native]);

  function toggle() {
    const next = !enabled;
    if (!native) { setEnabled(next); return; }
    setBusy(true);
    void nativeSetMvFallbackEnabled(next).then(settings => { setEnabled(settings.mvFallbackEnabled ?? next); setError(""); })
      .catch(() => setError("保存失败，请重新打开设置后重试"))
      .finally(() => setBusy(false));
  }

  return <div className="mv-fallback-setting">
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className="settings-switch"
      disabled={busy || !!error}
      onClick={toggle}
    >
      <span>原曲不可用时使用 QQ MV 音轨</span>
      <span className="settings-switch__track" aria-hidden="true">
        <span className="settings-switch__thumb" />
      </span>
    </button>
    <p>仅在原曲无法播放时尝试关联 MV；修改后从下次加载歌曲生效。</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function MvLyricOffsetControl() {
  const track = usePlayerSelector(getCurrentTrack);
  const offset = usePlayerSelector(s => s.lyricOffsetMs ?? 0);
  const native = usePlayerSelector(s => s.nativeMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); }, [track?.id]);
  if (!native || track?.actualQuality !== "QQ MV 音轨") return null;
  function change(value: number) {
    setBusy(true); setError("");
    void playerActions.setMvLyricOffset(value).catch(() => setError("歌词偏移保存失败，请重试"))
      .finally(() => setBusy(false));
  }
  const valueLabel = offset === 0 ? "无偏移" : `${offset > 0 ? "+" : ""}${(offset / 1000).toFixed(1)}s`;
  return <div className="mv-lyric-offset" aria-label="MV 歌词同步">
    <div className="mv-offset-stepper">
      <button
        type="button"
        className="mv-offset-stepper__step"
        aria-label="MV 歌词提前 0.5 秒"
        disabled={busy || offset <= -60000}
        onClick={() => change(offset - 500)}
      >
        −0.5s
      </button>
      <span className="mv-offset-stepper__value" aria-live="polite">{valueLabel}</span>
      <button
        type="button"
        className="mv-offset-stepper__step"
        aria-label="MV 歌词延后 0.5 秒"
        disabled={busy || offset >= 60000}
        onClick={() => change(offset + 500)}
      >
        +0.5s
      </button>
      <Tooltip content="重置 MV 歌词偏移">
        <button
          type="button"
          className="mv-offset-stepper__reset"
          aria-label="重置 MV 歌词偏移"
          disabled={busy || offset === 0}
          onClick={() => change(0)}
        >
          <Icon name="rotate" size={13} />
        </button>
      </Tooltip>
    </div>
    {error && <span className="mv-lyric-offset__error" role="alert">{error}</span>}
  </div>;
}
