import { describe, expect, it } from "vitest";
import {
  encodeQrMatrix,
  MAX_QR_PAYLOAD_BYTES,
  qrMatrixToPathData,
  renderQrSvgString,
  type QrMatrix,
} from "./qrSvg";

const GOLDEN_V1_HELLO = [
  "#######.##.#..#######",
  "#.....#..##.#.#.....#",
  "#.###.#..####.#.###.#",
  "#.###.#.#..#..#.###.#",
  "#.###.#.#...#.#.###.#",
  "#.....#.#.##..#.....#",
  "#######.#.#.#.#######",
  "........#####........",
  "#...#.######.#####..#",
  "...###..#.###..#.####",
  "#.##..#.#.##..###..#.",
  "###..#...#...##.#....",
  "..#.###..#..###...##.",
  "........###.###..#.##",
  "#######.##..##...#.#.",
  "#.....#....##..#...#.",
  "#.###.#.#..#..###.#.#",
  "#.###.#....##....#.##",
  "#.###.#..###..####...",
  "#.....#..#...##......",
  "#######.#...#####.#.#",
] as const;

const GOLDEN_V5_REMOTE_URL = [
  "#######...#.##.##....#......#.#######",
  "#.....#..#.####...#.#..##..##.#.....#",
  "#.###.#.#.###..##....###..##..#.###.#",
  "#.###.#.#...#.#..##.#..#.#..#.#.###.#",
  "#.###.#.#.#.##.###.#.#.##.....#.###.#",
  "#.....#.##....#..#...#.....#..#.....#",
  "#######.#.#.#.#.#.#.#.#.#.#.#.#######",
  "........#..##.#.###..##...#.#........",
  "#.#####..####...#....#...##.#.#####..",
  ".##.#...###...##..#.#.#.##...#...#.#.",
  "###.#.###...##.#####..#..###....#.###",
  "#....#.#.#####.#..#####.#..#.##.....#",
  "#..##.###......######....#....#######",
  "...#...##.##..#....#...##.#..#.......",
  "###.#.#.#.###.##..#.#.#.##.#..##.#.##",
  "####.....##.#.##....#..#...#.#.......",
  "....#.#...##......#####.###.#.###.#.#",
  "#####..##..#..###....#.......#.....#.",
  "###...#.##..#....##.#..###.##.##.#.##",
  "...###.#.###.#..#....###....#.......#",
  "#...#.######.##.###.#.##.#.##.#####..",
  "#.##.......####..#.#.#.##.#......#...",
  ".#######.#..######..##...#.#.#####.##",
  ".#.###...#.#..#.###.###.#.#.#.####.##",
  ".#...##.##..#.###....#.######.###.#.#",
  "##.#.#.##.....##..#.###.#....#.......",
  "#.###.##.#.##..##..#....##.#.#.....##",
  "#......#..#.#..#..######..#.#.......#",
  "#.#.###.#.#....#####..#..#.########.#",
  "........#.##.......##..##.#.#...###..",
  "#######......#.#..#...#...#.#.#.#####",
  "#.....#.#####...#...#...#..##...##.##",
  "#.###.#.##...###..#.###.###########..",
  "#.###.#.###.#####......#.#....#.#...#",
  "#.###.#.#..##.#.....#.#..#.#.#...####",
  "#.....#..#.#.##.#....##.....######..#",
  "#######.#.##.##.###...#..#.#.####.###",
] as const;

function matrixToLines(matrix: QrMatrix): string[] {
  return matrix.modules.map((row) => row.map((cell) => (cell ? "#" : ".")).join(""));
}

function assertFinderPattern(matrix: QrMatrix, rowOffset: number, colOffset: number) {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const isOuterRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const isCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      expect(matrix.modules[rowOffset + dr]?.[colOffset + dc]).toBe(isOuterRing || isCore);
    }
  }
}

describe("qrSvg", () => {
  it("exposes V7 EC-M byte capacity as MAX_QR_PAYLOAD_BYTES", () => {
    expect(MAX_QR_PAYLOAD_BYTES).toBe(122);
  });

  it("matches golden V1 matrix module-by-module for HELLO", () => {
    const matrix = encodeQrMatrix("HELLO");
    expect(matrix).not.toBeNull();
    expect(matrix!.version).toBe(1);
    expect(matrix!.size).toBe(21);
    expect(matrixToLines(matrix!)).toEqual([...GOLDEN_V1_HELLO]);
  });

  it("matches golden V5 matrix module-by-module for remote pairing URL", () => {
    const payload = "http://192.168.1.23:19653/#code=0123456789abcdef0123456789abcdef";
    expect(new TextEncoder().encode(payload).length).toBe(64);
    const matrix = encodeQrMatrix(payload);
    expect(matrix).not.toBeNull();
    expect(matrix!.version).toBe(5);
    expect(matrix!.size).toBe(37);
    expect(matrixToLines(matrix!)).toEqual([...GOLDEN_V5_REMOTE_URL]);
  });

  it("supports V7 max capacity (122 bytes) and returns null for empty or >122 byte payloads", () => {
    expect(encodeQrMatrix("")).toBeNull();

    const maxPayload = "a".repeat(122);
    const v7 = encodeQrMatrix(maxPayload);
    expect(v7).not.toBeNull();
    expect(v7!.version).toBe(7);
    expect(v7!.size).toBe(45);

    expect(encodeQrMatrix("a".repeat(123))).toBeNull();

    // Multi-byte UTF-8 check: 40 CJK chars = 120 bytes (fits V7); 41 CJK chars = 123 bytes (overflow)
    expect(encodeQrMatrix("乐".repeat(40))?.version).toBe(7);
    expect(encodeQrMatrix("乐".repeat(41))).toBeNull();
  });

  it("renders valid finder patterns and timing lines across versions", () => {
    for (const sample of ["HELLO", "http://192.168.1.23:19653/#code=0123456789abcdef0123456789abcdef", "x".repeat(122)]) {
      const matrix = encodeQrMatrix(sample)!;
      expect(matrix).not.toBeNull();

      assertFinderPattern(matrix, 0, 0);
      assertFinderPattern(matrix, 0, matrix.size - 7);
      assertFinderPattern(matrix, matrix.size - 7, 0);

      for (let i = 8; i < matrix.size - 8; i += 1) {
        const expected = i % 2 === 0;
        expect(matrix.modules[6]?.[i]).toBe(expected);
        expect(matrix.modules[i]?.[6]).toBe(expected);
      }
    }
  });

  it("builds merged horizontal SVG path data and complete crisp SVG markup", () => {
    const matrix = encodeQrMatrix("HELLO")!;
    const path = qrMatrixToPathData(matrix);
    expect(path.startsWith("M0,0h7v1h-7z")).toBe(true);

    const svg = renderQrSvgString("HELLO");
    expect(svg).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path transform="translate(4,4)" d="${path}" fill="#000"/></svg>`,
    );

    expect(renderQrSvgString("")).toBeNull();
    expect(renderQrSvgString("a".repeat(123))).toBeNull();
  });
});
