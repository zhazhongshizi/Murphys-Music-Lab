import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackRowActions } from "./TrackRowActions";

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
  const eventName =
    type === "pointerenter" ? "pointerover" : type === "pointerleave" ? "pointerout" : type;
  const event = new Event(eventName, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}

describe("TrackRowActions", () => {
  it("传入全部 4 个回调时按固定顺序渲染按钮并各自触发一次回调", () => {
    const onPlay = vi.fn();
    const onNext = vi.fn();
    const onEnqueue = vi.fn();
    const onRemove = vi.fn();

    render(
      <TrackRowActions
        onEnqueue={onEnqueue}
        onNext={onNext}
        onPlay={onPlay}
        onRemove={onRemove}
        title="稻香"
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "播放 稻香",
      "下一首播放 稻香",
      "加入队列 稻香",
      "移除 稻香",
    ]);

    fireEvent.click(buttons[0]!);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    expect(onEnqueue).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(buttons[1]!);
    expect(onNext).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[2]!);
    expect(onEnqueue).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[3]!);
    expect(onRemove).toHaveBeenCalledTimes(1);

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("仅传入部分回调时只渲染对应的按钮", () => {
    const { rerender } = render(<TrackRowActions onPlay={vi.fn()} title="月光" />);
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["播放 月光"]);

    rerender(<TrackRowActions onEnqueue={vi.fn()} onPlay={vi.fn()} title="月光" />);
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["播放 月光", "加入队列 月光"]);

    rerender(<TrackRowActions onNext={vi.fn()} onRemove={vi.fn()} title="月光" />);
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["下一首播放 月光", "移除 月光"]);

    rerender(<TrackRowActions title="月光" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("支持自定义 label 与 tooltip 文案覆盖", () => {
    vi.useFakeTimers();

    render(
      <TrackRowActions
        enqueueLabel="排队 月光"
        enqueueTooltip="排队"
        nextLabel="插播 月光"
        nextTooltip="插播"
        onEnqueue={vi.fn()}
        onNext={vi.fn()}
        onPlay={vi.fn()}
        onRemove={vi.fn()}
        playLabel="回放 月光"
        playTooltip="回放"
        removeLabel="删除 月光"
        removeTooltip="删除"
        title="月光"
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "回放 月光",
      "插播 月光",
      "排队 月光",
      "删除 月光",
    ]);

    const expectedTooltips = ["回放", "插播", "排队", "删除"];
    buttons.forEach((button, index) => {
      const anchor = button.closest(".app-tooltip-anchor");
      expect(anchor).not.toBeNull();
      firePointer(anchor!, "pointerenter", "mouse");
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole("tooltip")).toHaveTextContent(expectedTooltips[index]!);
      firePointer(anchor!, "pointerleave", "mouse");
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });

  it("所有按钮均不含原生 title 属性，且 pointerEnter 与键盘聚焦均能弹出对应 Tooltip", () => {
    vi.useFakeTimers();

    render(
      <TrackRowActions
        onEnqueue={vi.fn()}
        onNext={vi.fn()}
        onPlay={vi.fn()}
        onRemove={vi.fn()}
        title="夜曲"
      />,
    );

    const expected = [
      { label: "播放 夜曲", tooltip: "播放" },
      { label: "下一首播放 夜曲", tooltip: "下一首播放" },
      { label: "加入队列 夜曲", tooltip: "加入队列" },
      { label: "移除 夜曲", tooltip: "移出" },
    ];

    for (const item of expected) {
      const button = screen.getByRole("button", { name: item.label });
      expect(button).not.toHaveAttribute("title");

      const anchor = button.closest(".app-tooltip-anchor");
      expect(anchor).not.toBeNull();

      firePointer(anchor!, "pointerenter", "mouse");
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole("tooltip")).toHaveTextContent(item.tooltip);

      firePointer(anchor!, "pointerleave", "mouse");
      expect(screen.queryByRole("tooltip")).toBeNull();

      fireEvent.keyDown(window, { key: "Tab" });
      fireEvent.focus(button);
      expect(screen.getByRole("tooltip")).toHaveTextContent(item.tooltip);

      fireEvent.blur(button);
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });

  it("全局 disabled 与各单按钮禁用标志均正确生效", () => {
    const onPlay = vi.fn();
    const onNext = vi.fn();
    const onEnqueue = vi.fn();
    const onRemove = vi.fn();

    const { rerender } = render(
      <TrackRowActions
        disabled
        onEnqueue={onEnqueue}
        onNext={onNext}
        onPlay={onPlay}
        onRemove={onRemove}
        title="晴天"
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onPlay).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(onEnqueue).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    const singleFlags = [
      { prop: "playDisabled", disabledLabel: "播放 晴天", fn: onPlay },
      { prop: "nextDisabled", disabledLabel: "下一首播放 晴天", fn: onNext },
      { prop: "enqueueDisabled", disabledLabel: "加入队列 晴天", fn: onEnqueue },
      { prop: "removeDisabled", disabledLabel: "移除 晴天", fn: onRemove },
    ] as const;

    for (const target of singleFlags) {
      vi.clearAllMocks();
      rerender(
        <TrackRowActions
          enqueueDisabled={target.prop === "enqueueDisabled"}
          nextDisabled={target.prop === "nextDisabled"}
          onEnqueue={onEnqueue}
          onNext={onNext}
          onPlay={onPlay}
          onRemove={onRemove}
          playDisabled={target.prop === "playDisabled"}
          removeDisabled={target.prop === "removeDisabled"}
          title="晴天"
        />,
      );

      for (const button of screen.getAllByRole("button")) {
        const label = button.getAttribute("aria-label");
        if (label === target.disabledLabel) {
          expect(button).toBeDisabled();
        } else {
          expect(button).toBeEnabled();
        }
        fireEvent.click(button);
      }

      expect(target.fn).not.toHaveBeenCalled();
      for (const other of singleFlags) {
        if (other.prop !== target.prop) {
          expect(other.fn).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it("stopPropagation、危险移除样式与 variant / className 类名均符合契约", () => {
    const outerClick = vi.fn();
    const outerDoubleClick = vi.fn();
    const onPlay = vi.fn();
    const onRemove = vi.fn();

    const { container, rerender } = render(
      <div onClick={outerClick} onDoubleClick={outerDoubleClick}>
        <TrackRowActions
          onEnqueue={vi.fn()}
          onNext={vi.fn()}
          onPlay={onPlay}
          onRemove={onRemove}
          stopPropagation
          title="七里香"
        />
      </div>,
    );

    const actionsRoot = container.querySelector(".track-row-actions");
    expect(actionsRoot).toHaveClass("track-row-actions", "track-row-actions--default");

    const playButton = screen.getByRole("button", { name: "播放 七里香" });
    const nextButton = screen.getByRole("button", { name: "下一首播放 七里香" });
    const enqueueButton = screen.getByRole("button", { name: "加入队列 七里香" });
    const removeButton = screen.getByRole("button", { name: "移除 七里香" });

    expect(playButton).not.toHaveClass("icon-button--danger");
    expect(nextButton).not.toHaveClass("icon-button--danger");
    expect(enqueueButton).not.toHaveClass("icon-button--danger");
    expect(removeButton).toHaveClass("icon-button", "icon-button--quiet", "icon-button--danger");

    fireEvent.click(playButton);
    fireEvent.click(removeButton);
    fireEvent.click(actionsRoot!);
    fireEvent.doubleClick(actionsRoot!);

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(outerClick).not.toHaveBeenCalled();
    expect(outerDoubleClick).not.toHaveBeenCalled();

    rerender(
      <div onClick={outerClick} onDoubleClick={outerDoubleClick}>
        <TrackRowActions
          className="custom-actions"
          onPlay={onPlay}
          title="七里香"
          variant="rhine"
        />
      </div>,
    );
    expect(container.querySelector(".track-row-actions")).toHaveClass(
      "track-row-actions",
      "track-row-actions--rhine",
      "custom-actions",
    );
    expect(screen.getByRole("button", { name: "播放 七里香" }).querySelector("svg")).toHaveAttribute(
      "width",
      "16",
    );

    fireEvent.click(screen.getByRole("button", { name: "播放 七里香" }));
    expect(outerClick).toHaveBeenCalledTimes(1);

    rerender(
      <TrackRowActions onPlay={onPlay} title="七里香" variant="compact" />,
    );
    expect(container.querySelector(".track-row-actions")).toHaveClass(
      "track-row-actions",
      "track-row-actions--compact",
    );
    expect(screen.getByRole("button", { name: "播放 七里香" }).querySelector("svg")).toHaveAttribute(
      "width",
      "15",
    );
  });
});
