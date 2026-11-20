export const SHORTCUT_ACTIONS = [
  { action: "togglePlayback", label: "播放／暂停", key: "Space" },
  { action: "next", label: "下一首", key: "ArrowRight" },
  { action: "previous", label: "上一首", key: "ArrowLeft" },
  { action: "volumeUp", label: "音量增加 10%", key: "ArrowUp" },
  { action: "volumeDown", label: "音量降低 10%", key: "ArrowDown" },
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]["action"];
export interface ShortcutBinding { action: ShortcutAction; enabled: boolean; shortcut: string }
export interface ShortcutSettingsValue { enabled: boolean; bindings: ShortcutBinding[] }
export interface ShortcutSnapshot { settings: ShortcutSettingsValue; errors: string[] }

export function defaultShortcuts(): ShortcutSettingsValue {
  return { enabled: true, bindings: SHORTCUT_ACTIONS.map(({ action, key }) => ({ action, enabled: true, shortcut: `Control+Alt+${key}` })) };
}

export const SHORTCUT_MODIFIERS = [
  { value: "Control", label: "Ctrl" }, { value: "Alt", label: "Alt" },
  { value: "Shift", label: "Shift" }, { value: "Super", label: "Win" },
] as const;

export const SHORTCUT_KEYS = [
  { value: "Space", label: "空格" },
  { value: "ArrowRight", label: "→ 右方向键" }, { value: "ArrowLeft", label: "← 左方向键" },
  { value: "ArrowUp", label: "↑ 上方向键" }, { value: "ArrowDown", label: "↓ 下方向键" },
  ...Array.from({ length: 26 }, (_, i) => ({ value: `Key${String.fromCharCode(65 + i)}`, label: String.fromCharCode(65 + i) })),
  ...Array.from({ length: 10 }, (_, i) => ({ value: `Digit${i}`, label: String(i) })),
  ...Array.from({ length: 24 }, (_, i) => ({ value: `F${i + 1}`, label: `F${i + 1}` })),
  ...["Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown"].map(value => ({ value, label: value })),
];

export function shortcutParts(shortcut: string) {
  const tokens = shortcut.split("+");
  const key = tokens.pop() ?? "Space";
  const aliases: Record<string, string> = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", super: "Super", cmd: "Super" };
  return { key, modifiers: tokens.map(token => aliases[token.trim().toLowerCase()] ?? token) };
}

export function shortcutLabel(shortcut: string) {
  const { key, modifiers } = shortcutParts(shortcut);
  return [...SHORTCUT_MODIFIERS.filter(item => modifiers.includes(item.value)).map(item => item.label),
    SHORTCUT_KEYS.find(item => item.value === key)?.label ?? key].join(" + ");
}

export const SHORTCUT_KEY_CODES: ReadonlySet<string> = new Set(SHORTCUT_KEYS.map(item => item.value));

const MODIFIER_ORDER = SHORTCUT_MODIFIERS.map(item => item.value);

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "Super",
]);

export function defaultShortcutForAction(action: ShortcutAction): string {
  const found = SHORTCUT_ACTIONS.find(item => item.action === action);
  return `Control+Alt+${found?.key ?? "Space"}`;
}

export function isModifierKeyCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export function canonicalShortcut(shortcut: string): string {
  const { key, modifiers } = shortcutParts(shortcut);
  const ordered = MODIFIER_ORDER.filter(mod => modifiers.includes(mod));
  return [...ordered, key].join("+");
}

export type ShortcutRecordResult =
  | { status: "ok"; shortcut: string }
  | { status: "modifier-only" }
  | { status: "missing-modifier" }
  | { status: "unsupported"; code: string };

export interface RecordedKeyInput {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function formatRecordedShortcut(input: RecordedKeyInput): ShortcutRecordResult {
  const code = input.code.trim();
  if (!code || isModifierKeyCode(code)) {
    return { status: "modifier-only" };
  }
  if (!SHORTCUT_KEY_CODES.has(code)) {
    return { status: "unsupported", code };
  }
  const modifiers: string[] = [];
  if (input.ctrlKey) modifiers.push("Control");
  if (input.altKey) modifiers.push("Alt");
  if (input.shiftKey) modifiers.push("Shift");
  if (input.metaKey) modifiers.push("Super");
  if (modifiers.length === 0) {
    return { status: "missing-modifier" };
  }
  return { status: "ok", shortcut: [...modifiers, code].join("+") };
}

export interface ShortcutConflict {
  action: ShortcutAction;
  label: string;
  shortcut: string;
}

export function findShortcutConflict(
  bindings: readonly ShortcutBinding[],
  targetAction: ShortcutAction,
  candidateShortcut: string,
): ShortcutConflict | null {
  const normalized = canonicalShortcut(candidateShortcut);
  for (const binding of bindings) {
    if (binding.action === targetAction) continue;
    if (canonicalShortcut(binding.shortcut) === normalized) {
      const actionMeta = SHORTCUT_ACTIONS.find(item => item.action === binding.action);
      return {
        action: binding.action,
        label: actionMeta?.label ?? binding.action,
        shortcut: binding.shortcut,
      };
    }
  }
  return null;
}
