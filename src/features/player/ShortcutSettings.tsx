import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { shortcutsControl } from "../../backend/shortcutAdapter";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import {
  canonicalShortcut,
  defaultShortcutForAction,
  defaultShortcuts,
  findShortcutConflict,
  formatRecordedShortcut,
  SHORTCUT_ACTIONS,
  SHORTCUT_KEYS,
  SHORTCUT_MODIFIERS,
  shortcutLabel,
  shortcutParts,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutSettingsValue,
  type ShortcutSnapshot,
} from "../../contracts/shortcuts";
import "./shortcut-settings.css";

function ShortcutEditor() {
  const native = "__TAURI_INTERNALS__" in window;
  const [snapshot, setSnapshot] = useState<ShortcutSnapshot | null>(null);
  const [draft, setDraft] = useState<ShortcutSettingsValue>(defaultShortcuts);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [rowNotices, setRowNotices] = useState<Partial<Record<ShortcutAction, string>>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const saving = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!native) return;
    let active = true;
    setBusy(true);
    setError("");
    void shortcutsControl()
      .then(
        (value) => {
          if (active) {
            setSnapshot(value);
            setDraft(value.settings);
          }
        },
        () => {
          if (active) setError("快捷键配置读取失败，请重试");
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [native, reload]);

  function clearRowNotice(action: ShortcutAction) {
    setRowNotices((current) => {
      if (!(action in current)) return current;
      const next = { ...current };
      delete next[action];
      return next;
    });
  }

  function setRowNotice(action: ShortcutAction, notice: string) {
    setRowNotices((current) => ({ ...current, [action]: notice }));
  }

  function patch(action: ShortcutAction, value: Partial<ShortcutBinding>) {
    setMessage("");
    setError("");
    clearRowNotice(action);
    setDraft((current) => ({
      ...current,
      bindings: current.bindings.map((binding) =>
        binding.action === action ? { ...binding, ...value } : binding,
      ),
    }));
  }

  function toggleRecording(action: ShortcutAction) {
    setMessage("");
    setError("");
    if (recordingAction && recordingAction !== action) {
      clearRowNotice(recordingAction);
    }
    clearRowNotice(action);
    setRecordingAction((current) => (current === action ? null : action));
  }

  function resetRow(action: ShortcutAction) {
    patch(action, { shortcut: defaultShortcutForAction(action) });
    if (recordingAction === action) {
      setRecordingAction(null);
    }
  }

  function handleRecordKeyDown(action: ShortcutAction, event: ReactKeyboardEvent) {
    if (event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const isPlainEscape =
      (event.key === "Escape" || event.code === "Escape") &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey;

    if (isPlainEscape) {
      event.preventDefault();
      event.stopPropagation();
      clearRowNotice(action);
      setRecordingAction(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const result = formatRecordedShortcut({
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });

    if (result.status === "modifier-only") {
      return;
    }
    if (result.status === "unsupported") {
      setRowNotice(action, "该键不支持");
      return;
    }
    if (result.status === "missing-modifier") {
      setRowNotice(action, "请至少包含一个修饰键（Ctrl / Alt / Shift / Win）");
      return;
    }

    const conflict = findShortcutConflict(draft.bindings, action, result.shortcut);
    if (conflict) {
      setRowNotice(action, `与《${conflict.label}》冲突`);
      return;
    }

    patch(action, { shortcut: result.shortcut });
    setRecordingAction(null);
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (recordingAction) {
      handleRecordKeyDown(recordingAction, event);
      return;
    }
    if (event.key !== "Escape") {
      event.stopPropagation();
    }
  }

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setRecordingAction(null);
    setRowNotices({});
    try {
      const value = await shortcutsControl(draft);
      if (mounted.current) {
        setSnapshot(value);
        setDraft(value.settings);
        setMessage("快捷键已保存并生效");
      }
    } catch (reason) {
      if (mounted.current) {
        setError(typeof reason === "string" ? reason : "快捷键保存失败，请重试");
      }
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const dirty = snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const disabled = !native || busy || !snapshot;

  return (
    <section
      className="shortcut-editor"
      aria-label="快捷键配置"
      aria-busy={busy}
      onKeyDown={handleEditorKeyDown}
    >
      <p className="shortcut-settings__note">
        设置全局组合键，软件在后台或隐藏到托盘时也能控制播放。点击按键胶囊即可直接按下新组合键，修改后点击保存。
      </p>
      {!native && <p className="shortcut-settings__note">请在 Windows 桌面版中设置快捷键。</p>}
      <label className="shortcut-settings__master">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(event) => {
            setDraft((current) => ({ ...current, enabled: event.target.checked }));
            setMessage("");
            setError("");
            setRecordingAction(null);
            setRowNotices({});
          }}
        />
        启用全局快捷键
      </label>
      <div className="shortcut-settings__bindings">
        {SHORTCUT_ACTIONS.map(({ action, label }) => {
          const binding = draft.bindings.find((item) => item.action === action)!;
          const blocked = disabled || !draft.enabled;
          const isRecording = recordingAction === action;
          const currentLabel = shortcutLabel(binding.shortcut);
          const defaultLabel = shortcutLabel(defaultShortcutForAction(action));
          const isDefault =
            canonicalShortcut(binding.shortcut) ===
            canonicalShortcut(defaultShortcutForAction(action));
          const rowNotice = rowNotices[action];

          return (
            <div className="shortcut-settings__binding" key={action}>
              <div className="shortcut-settings__row">
                <label className="shortcut-settings__label">
                  <input
                    type="checkbox"
                    aria-label={`启用${label}快捷键`}
                    checked={binding.enabled}
                    disabled={blocked}
                    onChange={(event) => {
                      patch(action, { enabled: event.target.checked });
                      if (!event.target.checked && recordingAction === action) {
                        setRecordingAction(null);
                      }
                    }}
                  />
                  <span>{label}</span>
                </label>
                <div className="shortcut-settings__controls">
                  <button
                    type="button"
                    className={`shortcut-settings__key-button${isRecording ? " is-recording" : ""}`}
                    disabled={blocked || !binding.enabled}
                    aria-label={
                      isRecording
                        ? `正在录制${label}快捷键，请按下组合键… · Esc 取消`
                        : `录制${label}快捷键，当前为 ${currentLabel}`
                    }
                    aria-pressed={isRecording}
                    onClick={() => toggleRecording(action)}
                    onKeyDown={isRecording ? (event) => handleRecordKeyDown(action, event) : undefined}
                  >
                    {isRecording ? "请按下组合键… · Esc 取消" : currentLabel}
                  </button>
                  <Tooltip content={`恢复默认（${defaultLabel}）`}>
                    <button
                      type="button"
                      className="shortcut-settings__reset"
                      aria-label={`恢复${label}默认快捷键`}
                      disabled={blocked || isDefault}
                      onClick={() => resetRow(action)}
                    >
                      <Icon name="rotate" size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
              {rowNotice && (
                <p className="shortcut-settings__row-notice" role="status">
                  {rowNotice}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <details
        className="shortcut-settings__manual"
        open={manualOpen}
        onToggle={(event) => setManualOpen(event.currentTarget.open)}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            setManualOpen((open) => !open);
          }}
        >
          手动选键
        </summary>
        {manualOpen && (
          <div className="shortcut-settings__manual-list">
            {SHORTCUT_ACTIONS.map(({ action, label }) => {
              const binding = draft.bindings.find((item) => item.action === action)!;
              const parts = shortcutParts(binding.shortcut);
              const blocked = disabled || !draft.enabled;

              return (
                <fieldset
                  className="shortcut-settings__edit"
                  disabled={blocked || !binding.enabled}
                  key={action}
                >
                  <legend>{label}组合键</legend>
                  <div className="shortcut-settings__modifiers">
                    {SHORTCUT_MODIFIERS.map((modifier) => (
                      <label key={modifier.value}>
                        <input
                          type="checkbox"
                          checked={parts.modifiers.includes(modifier.value)}
                          onChange={(event) => {
                            const modifiers = event.target.checked
                              ? [...parts.modifiers, modifier.value]
                              : parts.modifiers.filter((value) => value !== modifier.value);
                            patch(action, {
                              shortcut: [
                                ...SHORTCUT_MODIFIERS.filter((item) =>
                                  modifiers.includes(item.value),
                                ).map((item) => item.value),
                                parts.key,
                              ].join("+"),
                            });
                          }}
                        />
                        {modifier.label}
                      </label>
                    ))}
                  </div>
                  <label className="shortcut-settings__main-key">
                    主键
                    <select
                      aria-label={`${label}主键`}
                      value={parts.key}
                      onChange={(event) =>
                        patch(action, {
                          shortcut: [...parts.modifiers, event.target.value].join("+"),
                        })
                      }
                    >
                      {!SHORTCUT_KEYS.some((item) => item.value === parts.key) && (
                        <option value={parts.key}>{parts.key}</option>
                      )}
                      {SHORTCUT_KEYS.map((key) => (
                        <option value={key.value} key={key.value}>
                          {key.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
              );
            })}
          </div>
        )}
      </details>
      <div className="shortcut-settings__actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setDraft(defaultShortcuts());
            setMessage("");
            setError("");
            setRecordingAction(null);
            setRowNotices({});
          }}
        >
          恢复默认快捷键
        </button>
        <button type="button" disabled={disabled} onClick={() => void save()}>
          {busy ? "正在读取或保存…" : "保存快捷键"}
        </button>
      </div>
      {dirty && <p className="shortcut-settings__note">有未保存的修改。</p>}
      {message && <p role="status">{message}</p>}
      {error || snapshot?.errors.length ? (
        <div className="shortcut-settings__error" role="alert">
          {error && <p>{error}</p>}
          {snapshot?.errors.map((value) => (
            <p key={value}>{value}</p>
          ))}
          {!snapshot && native && !busy && (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              重新读取快捷键配置
            </button>
          )}
        </div>
      ) : null}
      <p className="shortcut-settings__note">
        关闭单项会保留组合。音量每次增减 10 个百分点，范围为 0%～100%。
      </p>
    </section>
  );
}

export function ShortcutSettings({ presentation = "normal" }: { presentation?: "normal" | "rhine" }) {
  const [open, setOpen] = useState(false);
  if (presentation === "rhine") {
    return (
      <div className="shortcut-settings shortcut-settings--rhine">
        <ShortcutEditor />
      </div>
    );
  }
  return (
    <details
      className="shortcut-settings"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>快捷键设置</summary>
      {open && <ShortcutEditor />}
    </details>
  );
}
