import { useEffect, useRef, useState } from "react";
import { GLOW_INTENSITY_VALUES, type GlowIntensityLevel } from "./coverPalette";

export const FIELD_WIDTH = 192;
export const FIELD_HEIGHT = 108;
export const CORE_SIZE = 128;

const FRAME_INTERVAL_MS = 67;
const COLOR_TRANSITION_MS = 1000;

// 512-entry lookup table for exp(-x) over x in [0, 6.0], avoiding Math.exp inside the pixel loop.
const EXP_LUT_SIZE = 512;
const EXP_LUT_MAX_X = 6.0;
const EXP_LUT_SCALE = (EXP_LUT_SIZE - 1) / EXP_LUT_MAX_X;
const EXP_LUT = new Float32Array(EXP_LUT_SIZE);
for (let i = 0; i < EXP_LUT_SIZE; i += 1) {
  EXP_LUT[i] = Math.exp(-(i / EXP_LUT_SCALE));
}

// 4x4 ordered Bayer dithering matrix normalized to [-0.5, +0.5] to eliminate 8-bit Mach banding.
const BAYER_4X4 = new Float32Array([
  0 / 16 - 0.5, 8 / 16 - 0.5, 2 / 16 - 0.5, 10 / 16 - 0.5,
  12 / 16 - 0.5, 4 / 16 - 0.5, 14 / 16 - 0.5, 6 / 16 - 0.5,
  3 / 16 - 0.5, 11 / 16 - 0.5, 1 / 16 - 0.5, 9 / 16 - 0.5,
  15 / 16 - 0.5, 7 / 16 - 0.5, 13 / 16 - 0.5, 5 / 16 - 0.5,
]);

type Rgb = readonly [number, number, number];

interface PaletteRgb {
  readonly primary: Rgb;
  readonly vibrant: Rgb;
  readonly ambient: Rgb;
  readonly top: Rgb;
}

interface GlowAlphas {
  readonly primary: number;
  readonly vibrant: number;
  readonly ambient: number;
  readonly top: number;
  readonly core: number;
}

interface GaussianOrb {
  readonly cx: number;
  readonly cy: number;
  readonly invRx2: number;
  readonly invRy2: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

export interface CachedGlowProps {
  readonly kind: "field" | "artwork-core";
  readonly paletteKey: string;
  readonly animate?: boolean;
  readonly intensity?: GlowIntensityLevel;
  readonly primaryColor?: string;
  readonly vibrantColor?: string;
  readonly ambientColor?: string;
  readonly topColor?: string;
}

const DEFAULT_PALETTE_RGB: PaletteRgb = {
  primary: [120, 149, 117],
  vibrant: [184, 199, 122],
  ambient: [25, 54, 43],
  top: [33, 62, 51],
};

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function parseColor(color?: string): Rgb | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      if ([r, g, b].every(Number.isFinite)) return [r, g, b];
      return null;
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every(Number.isFinite)) return [r, g, b];
      return null;
    }
    return null;
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if ([r, g, b].every(Number.isFinite)) {
      return [clampByte(r), clampByte(g), clampByte(b)];
    }
  }

  return null;
}

function rgbEqual(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function palettesEqual(a: PaletteRgb, b: PaletteRgb): boolean {
  return (
    rgbEqual(a.primary, b.primary) &&
    rgbEqual(a.vibrant, b.vibrant) &&
    rgbEqual(a.ambient, b.ambient) &&
    rgbEqual(a.top, b.top)
  );
}

function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    clampByte(from[0] + (to[0] - from[0]) * t),
    clampByte(from[1] + (to[1] - from[1]) * t),
    clampByte(from[2] + (to[2] - from[2]) * t),
  ];
}

function lerpPalette(from: PaletteRgb, to: PaletteRgb, t: number): PaletteRgb {
  return {
    primary: lerpRgb(from.primary, to.primary, t),
    vibrant: lerpRgb(from.vibrant, to.vibrant, t),
    ambient: lerpRgb(from.ambient, to.ambient, t),
    top: lerpRgb(from.top, to.top, t),
  };
}

function readCssNumber(styles: CSSStyleDeclaration | null, key: string, fallback: number): number {
  if (!styles) return fallback;
  const parsed = Number.parseFloat(styles.getPropertyValue(key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function gaussianFalloff(x: number): number {
  if (x >= EXP_LUT_MAX_X) return 0;
  return EXP_LUT[(x * EXP_LUT_SCALE) | 0]!;
}

/**
 * Renders smooth analytic Gaussian orbs with 4x4 ordered Bayer dithering directly
 * into a reusable ImageData buffer (eliminates 8-bit Mach bands and radial stop rings).
 */
function rasterizeOrbs(
  image: ImageData,
  width: number,
  height: number,
  orbs: readonly GaussianOrb[],
  edgeFade: boolean,
): void {
  const data = image.data;
  const invW = 1 / width;
  const invH = 1 / height;
  const orbCount = orbs.length;

  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const ny = (y + 0.5) * invH;
    const bayerRow = (y & 3) << 2;
    const edy = ny - 0.5;
    const edy2 = edy * edy;

    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) * invW;
      let premulR = 0;
      let premulG = 0;
      let premulB = 0;
      let outA = 0;

      for (let i = 0; i < orbCount; i += 1) {
        const orb = orbs[i]!;
        const dx = nx - orb.cx;
        const dy = ny - orb.cy;
        const dist = dx * dx * orb.invRx2 + dy * dy * orb.invRy2;
        if (dist >= EXP_LUT_MAX_X) continue;
        const a = orb.alpha * gaussianFalloff(dist);
        if (a <= 0.0002) continue;
        const inv = 1 - a;
        premulR = orb.r * a + premulR * inv;
        premulG = orb.g * a + premulG * inv;
        premulB = orb.b * a + premulB * inv;
        outA = a + outA * inv;
      }

      if (edgeFade && outA > 0) {
        const edx = nx - 0.5;
        const r2 = edx * edx + edy2;
        if (r2 >= 0.24) {
          outA = 0;
        } else if (r2 > 0.06) {
          const t = (0.24 - r2) / 0.18;
          const taper = t * t * (3 - 2 * t);
          premulR *= taper;
          premulG *= taper;
          premulB *= taper;
          outA *= taper;
        }
      }

      if (outA <= 0.0005) {
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 0;
      } else {
        const dither = BAYER_4X4[bayerRow + (x & 3)]! * 0.85;
        const invA = 1 / outA;
        data[offset] = Math.max(0, Math.min(255, Math.round(premulR * invA + dither)));
        data[offset + 1] = Math.max(0, Math.min(255, Math.round(premulG * invA + dither)));
        data[offset + 2] = Math.max(0, Math.min(255, Math.round(premulB * invA + dither)));
        data[offset + 3] = Math.max(0, Math.min(255, Math.round(outA * 255 + dither)));
      }
      offset += 4;
    }
  }
}

function drawFieldFrame(
  ctx: CanvasRenderingContext2D,
  image: ImageData,
  palette: PaletteRgb,
  alphas: GlowAlphas,
  elapsedSec: number,
): void {
  const tau = Math.PI * 2;
  // Wide overlapping Gaussian sigma values create seamless silk-like transitions with zero hard edges.
  const pX = 0.22 + 0.08 * Math.sin((tau * elapsedSec) / 18.0 + 0.4);
  const pY = 0.34 + 0.07 * Math.cos((tau * elapsedSec) / 22.0 + 0.9);
  const pScale = 1 + 0.05 * Math.sin((tau * elapsedSec) / 17.0);

  const vX = 0.78 + 0.08 * Math.cos((tau * elapsedSec) / 16.0 + 1.3);
  const vY = 0.62 + 0.07 * Math.sin((tau * elapsedSec) / 20.0 + 2.1);
  const vScale = 1 + 0.06 * Math.cos((tau * elapsedSec) / 19.0 + 0.7);

  const aX = 0.5 + 0.09 * Math.sin((tau * elapsedSec) / 21.0 + 2.8);
  const aY = 0.86 + 0.05 * Math.cos((tau * elapsedSec) / 24.0 + 0.3);

  const tX = 0.52 + 0.09 * Math.cos((tau * elapsedSec) / 19.0 + 3.6);
  const tY = 0.12 + 0.05 * Math.sin((tau * elapsedSec) / 23.0 + 1.1);

  const orbs: GaussianOrb[] = [
    {
      cx: aX, cy: aY, invRx2: 3.2, invRy2: 2.6,
      r: palette.ambient[0], g: palette.ambient[1], b: palette.ambient[2], alpha: alphas.ambient,
    },
    {
      cx: tX, cy: tY, invRx2: 3.4, invRy2: 2.8,
      r: palette.top[0], g: palette.top[1], b: palette.top[2], alpha: alphas.top,
    },
    {
      cx: pX, cy: pY, invRx2: 3.8 / (pScale * pScale), invRy2: 3.0 / (pScale * pScale),
      r: palette.primary[0], g: palette.primary[1], b: palette.primary[2], alpha: alphas.primary,
    },
    {
      cx: vX, cy: vY, invRx2: 4.2 / (vScale * vScale), invRy2: 3.2 / (vScale * vScale),
      r: palette.vibrant[0], g: palette.vibrant[1], b: palette.vibrant[2], alpha: alphas.vibrant,
    },
  ];

  rasterizeOrbs(image, FIELD_WIDTH, FIELD_HEIGHT, orbs, false);
  ctx.putImageData(image, 0, 0);
}

function drawArtworkCoreFrame(
  ctx: CanvasRenderingContext2D,
  image: ImageData,
  palette: PaletteRgb,
  alphas: GlowAlphas,
): void {
  const mid = lerpRgb(palette.vibrant, palette.primary, 0.55);
  const orbs: GaussianOrb[] = [
    {
      cx: 0.5, cy: 0.5, invRx2: 14.0, invRy2: 14.0,
      r: mid[0], g: mid[1], b: mid[2], alpha: alphas.core * 0.72,
    },
    {
      cx: 0.48, cy: 0.48, invRx2: 24.0, invRy2: 24.0,
      r: palette.vibrant[0], g: palette.vibrant[1], b: palette.vibrant[2], alpha: alphas.core * 0.55,
    },
  ];
  rasterizeOrbs(image, CORE_SIZE, CORE_SIZE, orbs, true);
  ctx.putImageData(image, 0, 0);
}

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Smooth analytic-Gaussian + Bayer-dithered low-res cover glow (15 FPS when animating, 0 FPS static). */
export function CachedGlow({
  kind,
  paletteKey,
  animate = false,
  intensity,
  primaryColor,
  vibrantColor,
  ambientColor,
  topColor,
}: CachedGlowProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageBufferRef = useRef<ImageData | null>(null);
  const displayedColorsRef = useRef<PaletteRgb | null>(null);
  const transitionRef = useRef<{
    from: PaletteRgb;
    to: PaletteRgb;
    startMs: number;
  } | null>(null);
  const motionStartMsRef = useRef<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState<boolean>(readReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    return undefined;
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const styles = typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
    const intensityValue =
      intensity !== undefined
        ? GLOW_INTENSITY_VALUES[intensity]
        : Math.max(0, readCssNumber(styles, "--cover-glow-intensity", 1));

    const targetPalette: PaletteRgb = {
      primary:
        parseColor(primaryColor) ??
        parseColor(styles?.getPropertyValue("--cover-primary")) ??
        DEFAULT_PALETTE_RGB.primary,
      vibrant:
        parseColor(vibrantColor) ??
        parseColor(styles?.getPropertyValue("--cover-vibrant")) ??
        DEFAULT_PALETTE_RGB.vibrant,
      ambient:
        parseColor(ambientColor) ??
        parseColor(styles?.getPropertyValue("--cover-ambient")) ??
        DEFAULT_PALETTE_RGB.ambient,
      top:
        parseColor(topColor) ??
        parseColor(styles?.getPropertyValue("--cover-top")) ??
        DEFAULT_PALETTE_RGB.top,
    };

    const blendCap = Math.max(0, readCssNumber(styles, "--cover-blend-cap", 0.28));
    const coreBase = readCssNumber(styles, "--cover-glow-core-alpha", 0.22);
    const sideBase = readCssNumber(styles, "--cover-glow-side-alpha", 0.14);
    const skyBase = readCssNumber(styles, "--cover-glow-sky-alpha", 0.16);
    const bottomBase = readCssNumber(styles, "--cover-glow-bottom-alpha", 0.16);

    const alphas: GlowAlphas = {
      primary: Math.min(blendCap, intensityValue * coreBase),
      vibrant: Math.min(blendCap, intensityValue * sideBase * 1.15),
      ambient: Math.min(blendCap, intensityValue * bottomBase),
      top: Math.min(blendCap, intensityValue * skyBase),
      core: Math.min(blendCap, intensityValue * coreBase),
    };

    const running = kind === "field" && Boolean(animate) && !reducedMotion && intensityValue > 0;
    root.dataset.cached = "true";
    root.dataset.animating = running ? "true" : "false";

    const targetWidth = kind === "field" ? FIELD_WIDTH : CORE_SIZE;
    const targetHeight = kind === "field" ? FIELD_HEIGHT : CORE_SIZE;
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (intensityValue <= 0) {
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      displayedColorsRef.current = targetPalette;
      transitionRef.current = null;
      return;
    }

    if (typeof ctx.createImageData !== "function" || typeof ctx.putImageData !== "function") {
      return;
    }

    let image = imageBufferRef.current;
    if (!image || image.width !== targetWidth || image.height !== targetHeight) {
      image = ctx.createImageData(targetWidth, targetHeight);
      imageBufferRef.current = image;
    }

    if (motionStartMsRef.current === null) {
      motionStartMsRef.current = Date.now();
    }

    if (kind === "artwork-core") {
      displayedColorsRef.current = targetPalette;
      transitionRef.current = null;
      drawArtworkCoreFrame(ctx, image, targetPalette, alphas);
      return;
    }

    if (!running) {
      displayedColorsRef.current = targetPalette;
      transitionRef.current = null;
      const elapsedSec = (Date.now() - motionStartMsRef.current) / 1000;
      drawFieldFrame(ctx, image, targetPalette, alphas, elapsedSec);
      return;
    }

    const previousPalette = displayedColorsRef.current;
    if (!previousPalette) {
      displayedColorsRef.current = targetPalette;
      transitionRef.current = null;
    } else if (!palettesEqual(previousPalette, targetPalette)) {
      transitionRef.current = {
        from: previousPalette,
        to: targetPalette,
        startMs: Date.now(),
      };
    }

    let disposed = false;
    let timerId: number | undefined;
    const activeImage = image;

    const renderFrame = (nowMs: number) => {
      let activePalette = targetPalette;
      const transition = transitionRef.current;
      if (transition) {
        const rawProgress = Math.max(0, Math.min(1, (nowMs - transition.startMs) / COLOR_TRANSITION_MS));
        const eased = 1 - Math.pow(1 - rawProgress, 3);
        activePalette = lerpPalette(transition.from, transition.to, eased);
        if (rawProgress >= 1) {
          transitionRef.current = null;
        }
      }
      displayedColorsRef.current = activePalette;
      const elapsedSec = (nowMs - (motionStartMsRef.current ?? nowMs)) / 1000;
      drawFieldFrame(ctx, activeImage, activePalette, alphas, elapsedSec);
    };

    const tick = () => {
      if (disposed) return;
      renderFrame(Date.now());
      timerId = window.setTimeout(tick, FRAME_INTERVAL_MS);
    };

    renderFrame(Date.now());
    timerId = window.setTimeout(tick, FRAME_INTERVAL_MS);

    return () => {
      disposed = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    kind,
    paletteKey,
    animate,
    intensity,
    primaryColor,
    vibrantColor,
    ambientColor,
    topColor,
    reducedMotion,
  ]);

  return (
    <span
      aria-hidden="true"
      className={`stage__glow stage__glow--${kind} stage__glow--cached`}
      ref={rootRef}
    >
      <canvas aria-hidden="true" ref={canvasRef} />
    </span>
  );
}
