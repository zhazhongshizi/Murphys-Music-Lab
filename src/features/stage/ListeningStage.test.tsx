import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playerActions, resetPlayerFixture } from "../player/playerStore";
import { ListeningStage } from "./ListeningStage";
import { ScrollingLyrics } from "./ScrollingLyrics";

describe("ListeningStage 播放音质选择", () => {
  beforeEach(() => resetPlayerFixture());
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("fixture 模式提供三档键盘可访问选择并更新当前期望音质", async () => {
    const user = userEvent.setup();
    render(<ListeningStage />);

    const trigger = screen.getByRole("button", { name: "期望音质：无损优先" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "选择播放音质" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(menu).getByRole("menuitemradio", { name: "标准 128k" })).not.toBeDisabled();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByRole("button", { name: "期望音质：标准 128k" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "选择播放音质" })).not.toBeInTheDocument();
  });

  it("同步舞台播放状态属性并在 scrollend 时提前释放自动滚屏锁", async () => {
    const view = render(<ListeningStage />);
    const main = view.container.querySelector("main.stage");
    expect(main).toHaveAttribute("data-playing", "false");
    await act(async () => {
      await playerActions.toggle();
    });
    expect(main).toHaveAttribute("data-playing", "true");
    cleanup();

    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const lyrics = [
      { atMs: 0, original: "第一行" },
      { atMs: 1000, original: "第二行" },
    ];
    const lyricView = render(<ScrollingLyrics activeIndex={0} lyrics={lyrics} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    const container = lyricView.container.querySelector(".lyrics-scroll__container")!;
    fireEvent(container, new Event("scrollend"));
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "回到当前" })).toBeInTheDocument();
  });

  it("手动滚屏显示回到当前时点击歌词仍可跳转并立即恢复跟随", () => {
    const seekSpy = vi.spyOn(playerActions, "seek");
    render(<ListeningStage />);

    const listbox = screen.getByRole("listbox", { name: "歌词列表" });
    fireEvent(listbox, new Event("scrollend"));
    fireEvent.scroll(listbox);
    expect(screen.getByRole("button", { name: "回到当前" })).toBeInTheDocument();

    const targetOption = screen.getByRole("option", { name: /当灯火转身，我们仍听见微光/ });
    expect(targetOption.querySelector(".lyrics-scroll__timestamp")).toHaveTextContent("02:41");
    expect(targetOption.querySelector(".lyrics-scroll__original")).toHaveTextContent("当灯火转身，我们仍听见微光");

    fireEvent.click(targetOption);
    expect(seekSpy).toHaveBeenCalledWith(161_000);
    expect(screen.queryByRole("button", { name: "回到当前" })).not.toBeInTheDocument();
  });

  it("拖拽超过 5px 或存在文本选区时不触发点击跳转", () => {
    const seekSpy = vi.spyOn(playerActions, "seek");
    render(<ListeningStage />);

    const option = screen.getByRole("option", { name: /下一圈年轮，会记得今晚/ });
    fireEvent.pointerDown(option, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(option, { clientX: 108, clientY: 100 });
    fireEvent.pointerUp(option, { button: 0, clientX: 108, clientY: 100 });
    fireEvent.click(option);
    expect(seekSpy).not.toHaveBeenCalled();

    fireEvent.click(option);
    expect(seekSpy).toHaveBeenCalledWith(216_000);
    seekSpy.mockClear();

    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "替黄昏调低了音量",
    } as Selection);
    fireEvent.click(screen.getByRole("option", { name: /玻璃上的雨，替黄昏调低了音量/ }));
    expect(seekSpy).not.toHaveBeenCalled();
  });

  it("歌词列表为单 Tab 停靠点的 listbox，支持 ArrowDown/Enter 跳转与 Escape 清除键盘焦点", () => {
    const seekSpy = vi.spyOn(playerActions, "seek");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<ListeningStage />);

    const listbox = screen.getByRole("listbox", { name: "歌词列表" });
    expect(listbox).toHaveAttribute("tabindex", "0");
    expect(within(listbox).queryAllByRole("button")).toHaveLength(0);

    const options = within(listbox).getAllByRole("option");
    for (const option of options) {
      expect(option).not.toHaveAttribute("tabindex");
    }
    expect(listbox).toHaveAttribute("aria-activedescendant", options[2]!.id);

    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(options[3]).toHaveClass("lyrics-scroll__line--keyboard-active");
    expect(options[3]).toHaveAttribute("aria-selected", "true");
    expect(listbox).toHaveAttribute("aria-activedescendant", options[3]!.id);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(options[3]).not.toHaveClass("lyrics-scroll__line--keyboard-active");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(listbox).toHaveAttribute("aria-activedescendant", options[2]!.id);
    expect(seekSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(seekSpy).toHaveBeenCalledWith(161_000);
    expect(options[3]).not.toHaveClass("lyrics-scroll__line--keyboard-active");
  });
});
