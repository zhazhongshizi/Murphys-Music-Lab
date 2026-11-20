import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import { defaultShortcuts, type ShortcutSettingsValue } from "../../contracts/shortcuts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

let saved: ShortcutSettingsValue;

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  saved = defaultShortcuts();
  invoke.mockReset().mockImplementation(async (_command, { request }) => {
    if (request.action === "save") saved = structuredClone(request.settings);
    return { settings: structuredClone(saved), errors: [] };
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "保存快捷键" })).toBeEnabled());
}

it("normal settings expand on demand and include the new play/pause shortcut", async () => {
  render(<ShortcutSettings />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("快捷键设置"));
  await ready();
  const playButton = screen.getByRole("button", { name: "录制播放／暂停快捷键，当前为 Ctrl + Alt + 空格" });
  expect(playButton).toHaveTextContent("Ctrl + Alt + 空格");
  expect(playButton).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "恢复播放／暂停默认快捷键" })).toBeDisabled();
  expect(screen.getAllByRole("checkbox")).toHaveLength(6);
});

it("master switch saves disabled state while retaining each configured combination", async () => {
  render(<ShortcutSettings presentation="rhine" />);
  await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用全局快捷键" }));
  expect(screen.getByRole("checkbox", { name: "启用下一首快捷键" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.enabled).toBe(false);
  expect(saved.bindings).toEqual(defaultShortcuts().bindings);
});

it("records a new combination via Press-to-Record while ignoring repeat and modifier-only keys", async () => {
  render(<ShortcutSettings presentation="rhine" />);
  await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用上一首快捷键" }));

  const nextButton = screen.getByRole("button", {
    name: "录制下一首快捷键，当前为 Ctrl + Alt + → 右方向键",
  });
  fireEvent.click(nextButton);
  expect(nextButton).toHaveAttribute("aria-pressed", "true");
  expect(nextButton).toHaveTextContent("请按下组合键… · Esc 取消");

  fireEvent.keyDown(nextButton, { code: "ControlLeft", ctrlKey: true });
  expect(nextButton).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(nextButton, { code: "KeyK", ctrlKey: true, shiftKey: true, repeat: true });
  expect(nextButton).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(nextButton, { code: "KeyK", ctrlKey: true, shiftKey: true });
  expect(nextButton).toHaveAttribute("aria-pressed", "false");
  expect(nextButton).toHaveTextContent("Ctrl + Shift + K");
  expect(screen.getByRole("button", { name: "恢复下一首默认快捷键" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings.find((item) => item.action === "next")?.shortcut).toBe("Control+Shift+KeyK");
  expect(saved.bindings.find((item) => item.action === "previous")?.enabled).toBe(false);
  expect(saved.bindings.find((item) => item.action === "volumeUp")).toEqual(defaultShortcuts().bindings[3]);
});

it("detects missing modifiers, unsupported keys, and conflicts inline during recording", async () => {
  render(<ShortcutSettings presentation="rhine" />);
  await ready();

  const playButton = screen.getByRole("button", {
    name: "录制播放／暂停快捷键，当前为 Ctrl + Alt + 空格",
  });
  fireEvent.click(playButton);

  fireEvent.keyDown(playButton, { code: "KeyA" });
  expect(screen.getByRole("status")).toHaveTextContent("请至少包含一个修饰键（Ctrl / Alt / Shift / Win）");
  expect(playButton).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(playButton, { code: "Backquote", ctrlKey: true });
  expect(screen.getByRole("status")).toHaveTextContent("该键不支持");
  expect(playButton).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(playButton, { code: "ArrowRight", ctrlKey: true, altKey: true });
  expect(screen.getByRole("status")).toHaveTextContent("与《下一首》冲突");
  expect(playButton).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(playButton, { code: "KeyP", ctrlKey: true, shiftKey: true });
  expect(playButton).toHaveAttribute("aria-pressed", "false");
  expect(playButton).toHaveTextContent("Ctrl + Shift + P");
  expect(screen.queryByText("与《下一首》冲突")).not.toBeInTheDocument();
});

it("cancels recording on Escape without closing parent while allowing Escape to bubble when idle", async () => {
  const parentKey = vi.fn();
  render(
    <div onKeyDown={parentKey}>
      <ShortcutSettings presentation="rhine" />
    </div>,
  );
  await ready();

  const playButton = screen.getByRole("button", {
    name: "录制播放／暂停快捷键，当前为 Ctrl + Alt + 空格",
  });
  fireEvent.click(playButton);
  fireEvent.keyDown(playButton, { code: "KeyA" });
  expect(screen.getByRole("status")).toHaveTextContent("请至少包含一个修饰键（Ctrl / Alt / Shift / Win）");

  fireEvent.keyDown(playButton, { key: "Escape", code: "Escape" });
  expect(parentKey).not.toHaveBeenCalled();
  expect(playButton).toHaveAttribute("aria-pressed", "false");
  expect(playButton).toHaveTextContent("Ctrl + Alt + 空格");
  expect(screen.queryByText("请至少包含一个修饰键（Ctrl / Alt / Shift / Win）")).not.toBeInTheDocument();

  fireEvent.keyDown(playButton, { key: "Escape", code: "Escape" });
  expect(parentKey).toHaveBeenCalledOnce();
});

it("resets a single binding row via its reset icon button without affecting other rows", async () => {
  saved.bindings[0]!.shortcut = "Control+KeyP";
  saved.bindings[1]!.shortcut = "Control+Shift+KeyK";
  render(<ShortcutSettings presentation="rhine" />);
  await ready();

  const playReset = screen.getByRole("button", { name: "恢复播放／暂停默认快捷键" });
  const volumeUpReset = screen.getByRole("button", { name: "恢复音量增加 10%默认快捷键" });
  expect(playReset).toBeEnabled();
  expect(volumeUpReset).toBeDisabled();

  fireEvent.click(playReset);
  expect(playReset).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "录制播放／暂停快捷键，当前为 Ctrl + Alt + 空格" }),
  ).toHaveTextContent("Ctrl + Alt + 空格");
  expect(
    screen.getByRole("button", { name: "录制下一首快捷键，当前为 Ctrl + Shift + K" }),
  ).toHaveTextContent("Ctrl + Shift + K");
  expect(saved.bindings[0]!.shortcut).toBe("Control+KeyP");

  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings[0]!.shortcut).toBe("Control+Alt+Space");
  expect(saved.bindings[1]!.shortcut).toBe("Control+Shift+KeyK");
});

it("supports collapsible manual fallback editing for browser-intercepted combinations", async () => {
  render(<ShortcutSettings presentation="rhine" />);
  await ready();

  expect(screen.queryByRole("group", { name: "下一首组合键" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("手动选键"));

  const group = within(screen.getByRole("group", { name: "下一首组合键" }));
  fireEvent.click(group.getByRole("checkbox", { name: "Alt" }));
  fireEvent.click(group.getByRole("checkbox", { name: "Shift" }));
  fireEvent.change(group.getByRole("combobox", { name: "下一首主键" }), {
    target: { value: "KeyK" },
  });

  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings.find((item) => item.action === "next")?.shortcut).toBe("Control+Shift+KeyK");
});

it("keeps drafts after a conflict, reports failure, and allows retry", async () => {
  render(<ShortcutSettings presentation="rhine" />);
  await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用下一首快捷键" }));
  invoke.mockRejectedValueOnce("播放／暂停的快捷键注册失败，可能已被其他程序占用。配置未保存");
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("配置未保存");
  expect(screen.queryByText("快捷键已保存并生效")).not.toBeInTheDocument();
  expect(saved.bindings.find((item) => item.action === "next")?.enabled).toBe(true);
  expect(screen.getByRole("checkbox", { name: "启用下一首快捷键" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings.find((item) => item.action === "next")?.enabled).toBe(false);
});

it("shares persisted configuration across normal and Rhine editors and resets only on save", async () => {
  saved.enabled = false;
  saved.bindings[0]!.shortcut = "Control+KeyP";
  const view = render(<ShortcutSettings presentation="rhine" />);
  await ready();
  expect(screen.getByRole("checkbox", { name: "启用全局快捷键" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "恢复默认快捷键" }));
  expect(saved.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  view.unmount();
  render(<ShortcutSettings />);
  fireEvent.click(screen.getByText("快捷键设置"));
  await ready();
  expect(screen.getByRole("checkbox", { name: "启用全局快捷键" })).toBeChecked();
  expect(saved).toEqual(defaultShortcuts());
});

it("shows startup registration errors and allows reading to be retried", async () => {
  invoke.mockRejectedValueOnce(new Error("private path"));
  render(<ShortcutSettings presentation="rhine" />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取快捷键配置" }));
  await ready();
  expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
  cleanup();
  invoke.mockResolvedValueOnce({ settings: saved, errors: ["下一首的快捷键无法启用"] });
  render(<ShortcutSettings presentation="rhine" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("下一首的快捷键无法启用");
});

it("does not intercept select navigation or send desktop commands in browser preview", () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  const parentKey = vi.fn();
  render(
    <div onKeyDown={parentKey}>
      <ShortcutSettings presentation="rhine" />
    </div>,
  );
  const master = screen.getByRole("checkbox", { name: "启用全局快捷键" });
  fireEvent.keyDown(master, { key: "ArrowDown" });
  expect(parentKey).not.toHaveBeenCalled();
  fireEvent.keyDown(master, { key: "Escape" });
  expect(parentKey).toHaveBeenCalledOnce();
  expect(master).toBeDisabled();
  expect(invoke).not.toHaveBeenCalled();
});
