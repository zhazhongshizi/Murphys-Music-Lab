import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function firePointer(
  target: Element | Window,
  type: "pointerenter" | "pointerleave" | "pointerdown",
  pointerType: "mouse" | "touch" = "mouse",
) {
  const eventName = type === "pointerenter" ? "pointerover" : type === "pointerleave" ? "pointerout" : type;
  const event = new Event(eventName, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}

describe("Tooltip", () => {
  it("悬停 400ms 后在 document.body Portal 显示，pointerLeave 立即隐藏，touch 不触发", () => {
    vi.useFakeTimers();
    const { container } = render(
      <Tooltip content="播放控制">
        <button type="button">播放</button>
      </Tooltip>,
    );

    const anchor = container.querySelector(".app-tooltip-anchor");
    const button = screen.getByRole("button", { name: "播放" });
    expect(anchor).not.toBeNull();

    firePointer(anchor!, "pointerenter", "mouse");
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("播放控制");
    expect(tooltip.parentElement).toBe(document.body);
    expect(anchor!.querySelector('[role="tooltip"]')).toBeNull();
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);

    firePointer(anchor!, "pointerleave", "mouse");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");

    firePointer(anchor!, "pointerenter", "touch");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("键盘 Tab 聚焦立即显示，Escape 隐藏且继续向外层冒泡，blur 隐藏，纯鼠标聚焦不弹出", () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <Tooltip content="快捷键提示">
          <button type="button">设置</button>
        </Tooltip>
      </div>,
    );

    const button = screen.getByRole("button", { name: "设置" });

    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("快捷键提示");

    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
    expect(outerKeyDown.mock.calls[0]?.[0].key).toBe("Escape");
    expect(outerKeyDown.mock.calls[0]?.[0].defaultPrevented).toBe(false);

    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("快捷键提示");

    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    firePointer(window, "pointerdown", "mouse");
    fireEvent.focus(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("子按钮 disabled 时悬停 .app-tooltip-anchor 仍可弹出禁用原因 Tooltip", () => {
    vi.useFakeTimers();
    const { container } = render(
      <Tooltip content="登录后可添加到歌单">
        <button disabled type="button">加入歌单</button>
      </Tooltip>,
    );

    const anchor = container.querySelector(".app-tooltip-anchor");
    const button = screen.getByRole("button", { name: "加入歌单" });
    expect(button).toBeDisabled();
    expect(anchor).not.toBeNull();

    firePointer(anchor!, "pointerenter", "mouse");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent("登录后可添加到歌单");
  });

  it.each(["", null])("content 为 %s 时直接透传子元素且不渲染 .app-tooltip-anchor", (emptyContent) => {
    vi.useFakeTimers();
    const { container } = render(
      <Tooltip content={emptyContent}>
        <button type="button">操作</button>
      </Tooltip>,
    );

    const button = screen.getByRole("button", { name: "操作" });
    expect(container.querySelector(".app-tooltip-anchor")).toBeNull();

    firePointer(button, "pointerenter", "mouse");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
