import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon, type IconName } from "./Icon";

afterEach(cleanup);

const NEW_ICONS: readonly IconName[] = [
  "cassette-add",
  "cassette-heart",
  "sequence",
  "playlist-add",
  "mini-window",
  "grip",
  "refresh",
  "pin",
  "eye",
  "edit",
  "rotate",
  "copy",
  "check",
  "eject",
  "cloud",
  "video",
];

const ADJACENT_ICONS: readonly IconName[] = [
  "play",
  "play-next",
  "queue",
  "repeat",
  "shuffle",
  "folder-music",
  "restore",
];

function renderSvgMarkup(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const svg = container.querySelector("svg");
  expect(svg, `Icon "${name}" should render an svg`).not.toBeNull();
  expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
  expect(svg).toHaveAttribute("aria-hidden", "true");
  expect(svg).toHaveClass("icon");
  const markup = svg!.outerHTML;
  unmount();
  return markup;
}

describe("Icon", () => {
  it.each([...NEW_ICONS, ...ADJACENT_ICONS])("正确渲染 %s 的 24x24 SVG 图标", (name) => {
    const markup = renderSvgMarkup(name);
    expect(markup).toContain('viewBox="0 0 24 24"');
  });

  it("sequence / repeat / shuffle 的 SVG markup 互不相同", () => {
    const markups = (["sequence", "repeat", "shuffle"] as const).map(renderSvgMarkup);
    expect(new Set(markups).size).toBe(3);
  });

  it("playlist-add / queue / folder-music 的 SVG markup 互不相同", () => {
    const markups = (["playlist-add", "queue", "folder-music"] as const).map(renderSvgMarkup);
    expect(new Set(markups).size).toBe(3);
  });

  it("cassette-add / cassette-heart / playlist-add / heart 的 SVG markup 互不相同", () => {
    const markups = (["cassette-add", "cassette-heart", "playlist-add", "heart"] as const).map(renderSvgMarkup);
    expect(new Set(markups).size).toBe(4);
  });
});
