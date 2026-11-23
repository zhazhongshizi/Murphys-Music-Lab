import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedGlow, CORE_SIZE, FIELD_HEIGHT, FIELD_WIDTH, parseColor } from "./CachedGlow";

function mockCanvas2d() {
  const clearRect = vi.fn();
  const snapshots: Uint8ClampedArray[] = [];
  const createImageData = vi.fn((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }));
  const putImageData = vi.fn((image: ImageData) => {
    snapshots.push(new Uint8ClampedArray(image.data));
  });
  const context = {
    clearRect,
    createImageData,
    putImageData,
  };
  const createElementSpy = vi.spyOn(document, "createElement");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  return { clearRect, createImageData, putImageData, snapshots, createElementSpy, context };
}

describe("CachedGlow 192x108 高斯抖动轻量化流体引擎", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("解析 #hex 与 rgb/rgba 颜色并在非法输入时返回 null", () => {
    expect(parseColor("#789575")).toEqual([120, 149, 117]);
    expect(parseColor("#abc")).toEqual([170, 187, 204]);
    expect(parseColor("rgb(184 199 122)")).toEqual([184, 199, 122]);
    expect(parseColor("rgba(25, 54, 43, 0.8)")).toEqual([25, 54, 43]);
    expect(parseColor("not-a-color")).toBeNull();
  });

  it("field 画布使用 192x108 比例且无离屏 blur，animate={false} 仅绘 1 帧且零定时器", () => {
    vi.useFakeTimers();
    const { createImageData, putImageData, createElementSpy, context } = mockCanvas2d();

    const view = render(
      <CachedGlow
        kind="field"
        paletteKey="warm"
        animate={false}
        intensity="standard"
        primaryColor="#789575"
        vibrantColor="#b8c77a"
        ambientColor="#19362b"
        topColor="#213e33"
      />,
    );

    const root = view.container.firstElementChild as HTMLElement;
    const canvas = view.container.querySelector("canvas")!;
    expect(root).toHaveAttribute("data-cached", "true");
    expect(root).toHaveAttribute("data-animating", "false");
    expect(canvas.width).toBe(FIELD_WIDTH);
    expect(canvas.height).toBe(FIELD_HEIGHT);
    expect("filter" in context).toBe(false);
    expect(createElementSpy.mock.calls.filter(([tag]) => tag === "canvas")).toHaveLength(1);
    expect(createImageData).toHaveBeenCalledTimes(1);
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(putImageData).toHaveBeenCalledTimes(1);
  });

  it("animate={true} 时按 67ms (~15 FPS) 推进帧并复用缓冲区，切回静止或卸载均立即停止", () => {
    vi.useFakeTimers();
    const { createImageData, putImageData } = mockCanvas2d();

    const view = render(
      <CachedGlow
        kind="field"
        paletteKey="warm"
        animate={true}
        intensity="standard"
        primaryColor="#789575"
        vibrantColor="#b8c77a"
        ambientColor="#19362b"
        topColor="#213e33"
      />,
    );

    const root = view.container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-animating", "true");
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(createImageData).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(67);
    });
    expect(putImageData).toHaveBeenCalledTimes(2);
    expect(createImageData).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(134);
    });
    expect(putImageData).toHaveBeenCalledTimes(4);

    view.rerender(
      <CachedGlow
        kind="field"
        paletteKey="warm"
        animate={false}
        intensity="standard"
        primaryColor="#789575"
        vibrantColor="#b8c77a"
        ambientColor="#19362b"
        topColor="#213e33"
      />,
    );
    expect(root).toHaveAttribute("data-animating", "false");
    expect(putImageData).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(putImageData).toHaveBeenCalledTimes(5);

    view.rerender(
      <CachedGlow
        kind="field"
        paletteKey="warm"
        animate={true}
        intensity="standard"
        primaryColor="#789575"
        vibrantColor="#b8c77a"
        ambientColor="#19362b"
        topColor="#213e33"
      />,
    );
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paletteKey 变更平滑插值，intensity='off' 清空且跳过绘制", () => {
    vi.useFakeTimers();
    const { clearRect, putImageData, snapshots } = mockCanvas2d();

    const view = render(
      <CachedGlow
        kind="field"
        paletteKey="track-1"
        animate={true}
        intensity="standard"
        primaryColor="rgb(0 0 0)"
        vibrantColor="rgb(0 0 0)"
        ambientColor="rgb(0 0 0)"
        topColor="rgb(0 0 0)"
      />,
    );
    expect(putImageData).toHaveBeenCalledTimes(1);

    view.rerender(
      <CachedGlow
        kind="field"
        paletteKey="track-2"
        animate={true}
        intensity="standard"
        primaryColor="rgb(200 100 50)"
        vibrantColor="rgb(200 100 50)"
        ambientColor="rgb(200 100 50)"
        topColor="rgb(200 100 50)"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const midFrame = snapshots[snapshots.length - 1]!;
    // Find a bright pixel and confirm its red channel is interpolated strictly between 0 and 200
    let maxRed = 0;
    for (let i = 0; i < midFrame.length; i += 4) {
      if (midFrame[i + 3]! > 20 && midFrame[i]! > maxRed) {
        maxRed = midFrame[i]!;
      }
    }
    expect(maxRed).toBeGreaterThan(20);
    expect(maxRed).toBeLessThan(195);

    const putsBeforeOff = putImageData.mock.calls.length;
    view.rerender(
      <CachedGlow
        kind="field"
        paletteKey="track-2"
        animate={true}
        intensity="off"
        primaryColor="rgb(200 100 50)"
        vibrantColor="rgb(200 100 50)"
        ambientColor="rgb(200 100 50)"
        topColor="rgb(200 100 50)"
      />,
    );
    expect(clearRect).toHaveBeenCalledWith(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
    expect(putImageData).toHaveBeenCalledTimes(putsBeforeOff);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("artwork-core 使用 128x128 并在边界平滑衰减到 0 透明、不启动定时器", () => {
    vi.useFakeTimers();
    const { putImageData, snapshots } = mockCanvas2d();

    const view = render(
      <CachedGlow
        kind="artwork-core"
        paletteKey="warm"
        animate={true}
        intensity="enhanced"
        primaryColor="#789575"
        vibrantColor="#b8c77a"
      />,
    );

    const root = view.container.firstElementChild as HTMLElement;
    const canvas = view.container.querySelector("canvas")!;
    expect(canvas.width).toBe(CORE_SIZE);
    expect(canvas.height).toBe(CORE_SIZE);
    expect(root).toHaveAttribute("data-animating", "false");
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const frame = snapshots[0]!;
    // Corner pixel must be completely transparent (zero hard circular/box border)
    expect(frame[3]).toBe(0);
    // Center pixel must have visible glow alpha
    const centerOffset = ((CORE_SIZE / 2) * CORE_SIZE + CORE_SIZE / 2) * 4;
    expect(frame[centerOffset + 3]).toBeGreaterThan(10);
  });

  it("prefers-reduced-motion 开启时禁止动态循环，仅渲染 1 帧静态画面", () => {
    vi.useFakeTimers();
    const { putImageData } = mockCanvas2d();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    const view = render(
      <CachedGlow
        kind="field"
        paletteKey="warm"
        animate={true}
        intensity="standard"
      />,
    );

    const root = view.container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-animating", "false");
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
