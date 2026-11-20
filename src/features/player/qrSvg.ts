export interface QrMatrix {
  version: number;
  size: number;
  modules: readonly (readonly boolean[])[];
}

interface VersionSpec {
  version: number;
  totalCodewords: number;
  dataCodewords: number;
  blocks: number;
  ecPerBlock: number;
  maxBytePayload: number;
  alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Error Correction Level M (Byte mode, Versions 1..7)
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, dataCodewords: 16, blocks: 1, ecPerBlock: 10, maxBytePayload: 14, alignmentCenters: [] },
  { version: 2, totalCodewords: 44, dataCodewords: 28, blocks: 1, ecPerBlock: 16, maxBytePayload: 26, alignmentCenters: [6, 18] },
  { version: 3, totalCodewords: 70, dataCodewords: 44, blocks: 1, ecPerBlock: 26, maxBytePayload: 42, alignmentCenters: [6, 22] },
  { version: 4, totalCodewords: 100, dataCodewords: 64, blocks: 2, ecPerBlock: 18, maxBytePayload: 62, alignmentCenters: [6, 26] },
  { version: 5, totalCodewords: 134, dataCodewords: 86, blocks: 2, ecPerBlock: 24, maxBytePayload: 84, alignmentCenters: [6, 30] },
  { version: 6, totalCodewords: 172, dataCodewords: 108, blocks: 4, ecPerBlock: 16, maxBytePayload: 106, alignmentCenters: [6, 34] },
  { version: 7, totalCodewords: 196, dataCodewords: 124, blocks: 4, ecPerBlock: 18, maxBytePayload: 122, alignmentCenters: [6, 22, 38] },
];

export const MAX_QR_PAYLOAD_BYTES = VERSION_SPECS[VERSION_SPECS.length - 1]?.maxBytePayload ?? 122;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
})();

function atNum(arr: ArrayLike<number>, index: number): number {
  return arr[index] ?? 0;
}

function setCell(grid: boolean[][], r: number, c: number, value: boolean): void {
  const row = grid[r];
  if (row && c >= 0 && c < row.length) {
    row[c] = value;
  }
}

function getCell(grid: readonly (readonly boolean[])[], r: number, c: number): boolean {
  return grid[r]?.[c] ?? false;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return atNum(GF_EXP, atNum(GF_LOG, a) + atNum(GF_LOG, b));
}

function buildRsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const factor = [1, atNum(GF_EXP, i)] as const;
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const pj = atNum(poly, j);
      for (let k = 0; k < factor.length; k += 1) {
        const fk = factor[k] ?? 0;
        next[j + k] = atNum(next, j + k) ^ gfMul(pj, fk);
      }
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = buildRsGenerator(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const coeff = atNum(msg, i);
    if (coeff === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      msg[i + j] = atNum(msg, i + j) ^ gfMul(atNum(gen, j), coeff);
    }
  }
  return msg.subarray(data.length);
}

function encodeDataCodewords(payload: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalBits = spec.dataCodewords * 8;
  const bits: number[] = [];
  const pushBits = (value: number, width: number) => {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      bits.push((value >>> shift) & 1);
    }
  };

  // Byte mode indicator (0100) + 8-bit char count for V1..V9
  pushBits(0b0100, 4);
  pushBits(payload.length, 8);
  for (const byte of payload) {
    pushBits(byte, 8);
  }

  const terminatorBits = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < terminatorBits; i += 1) {
    bits.push(0);
  }
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const out = new Uint8Array(spec.dataCodewords);
  const byteLen = bits.length / 8;
  for (let i = 0; i < byteLen; i += 1) {
    let val = 0;
    for (let b = 0; b < 8; b += 1) {
      val = (val << 1) | (bits[i * 8 + b] ?? 0);
    }
    out[i] = val;
  }

  for (let i = byteLen, padIdx = 0; i < spec.dataCodewords; i += 1, padIdx += 1) {
    out[i] = padIdx % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

function interleaveCodewords(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const blockDataCount = spec.dataCodewords / spec.blocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let b = 0; b < spec.blocks; b += 1) {
    const start = b * blockDataCount;
    const blockData = data.subarray(start, start + blockDataCount);
    dataBlocks.push(blockData);
    ecBlocks.push(computeRsRemainder(blockData, spec.ecPerBlock));
  }

  const interleaved = new Uint8Array(spec.totalCodewords);
  let cursor = 0;
  for (let i = 0; i < blockDataCount; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) {
      const block = dataBlocks[b];
      interleaved[cursor++] = block ? atNum(block, i) : 0;
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) {
      const block = ecBlocks[b];
      interleaved[cursor++] = block ? atNum(block, i) : 0;
    }
  }
  return interleaved;
}

function createGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array<boolean>(size).fill(false));
}

function setFinderPattern(modules: boolean[][], reserved: boolean[][], rowOffset: number, colOffset: number) {
  const size = modules.length;
  for (let dr = -1; dr <= 7; dr += 1) {
    const r = rowOffset + dr;
    if (r < 0 || r >= size) continue;
    for (let dc = -1; dc <= 7; dc += 1) {
      const c = colOffset + dc;
      if (c < 0 || c >= size) continue;
      const inOuterRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const isBorder = dr === -1 || dr === 7 || dc === -1 || dc === 7;
      setCell(reserved, r, c, true);
      setCell(modules, r, c, !isBorder && (inOuterRing || inCenter));
    }
  }
}

function setAlignmentPattern(modules: boolean[][], reserved: boolean[][], centerR: number, centerC: number) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const r = centerR + dr;
      const c = centerC + dc;
      setCell(reserved, r, c, true);
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setCell(modules, r, c, dist === 0 || dist === 2);
    }
  }
}

function reserveFormatAreas(reserved: boolean[][]) {
  const size = reserved.length;
  for (let i = 0; i <= 8; i += 1) {
    setCell(reserved, 8, i, true);
    setCell(reserved, i, 8, true);
  }
  for (let i = size - 8; i < size; i += 1) {
    setCell(reserved, 8, i, true);
    setCell(reserved, i, 8, true);
  }
}

function reserveAndDrawVersionInfo(modules: boolean[][], reserved: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setCell(reserved, a, b, true);
    setCell(modules, a, b, bit);
    setCell(reserved, b, a, true);
    setCell(modules, b, a, bit);
  }
}

function drawFormatInfo(modules: boolean[][], maskIndex: number) {
  const size = modules.length;
  // Error correction M indicator is 0b00
  const data = maskIndex & 0b111;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> (14 - i)) & 1) === 1;
    if (i < 6) {
      setCell(modules, 8, i, bit);
    } else if (i === 6) {
      setCell(modules, 8, 7, bit);
    } else if (i === 7) {
      setCell(modules, 8, 8, bit);
    } else if (i === 8) {
      setCell(modules, 7, 8, bit);
    } else {
      setCell(modules, 14 - i, 8, bit);
    }

    if (i < 7) {
      setCell(modules, size - 1 - i, 8, bit);
    } else {
      setCell(modules, 8, size - 15 + i, bit);
    }
  }
  setCell(modules, size - 8, 8, true);
}

function maskMatches(maskIndex: number, r: number, c: number): boolean {
  switch (maskIndex) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

const FINDER_RATIO_PATTERN = [true, false, true, true, true, false, true] as const;

function penaltyRule1And3(line: readonly boolean[]): number {
  let penalty = 0;
  let runColor = line[0] ?? false;
  let runLen = 1;
  for (let i = 1; i < line.length; i += 1) {
    const curr = line[i] ?? false;
    if (curr === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) penalty += 3 + (runLen - 5);
      runColor = curr;
      runLen = 1;
    }
  }
  if (runLen >= 5) penalty += 3 + (runLen - 5);

  for (let start = 0; start <= line.length - 11; start += 1) {
    let forward = true;
    let backward = true;
    for (let k = 0; k < 7; k += 1) {
      const target = FINDER_RATIO_PATTERN[k] ?? false;
      if ((line[start + k] ?? false) !== target) forward = false;
      if ((line[start + 4 + k] ?? false) !== target) backward = false;
    }
    if (forward && !line[start + 7] && !line[start + 8] && !line[start + 9] && !line[start + 10]) {
      penalty += 40;
    }
    if (backward && !line[start] && !line[start + 1] && !line[start + 2] && !line[start + 3]) {
      penalty += 40;
    }
  }
  return penalty;
}

function evaluatePenalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;

  for (let r = 0; r < size; r += 1) {
    const row = modules[r];
    if (row) penalty += penaltyRule1And3(row);
  }
  const col = new Array<boolean>(size).fill(false);
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r < size; r += 1) col[r] = getCell(modules, r, c);
    penalty += penaltyRule1And3(col);
  }

  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const tl = getCell(modules, r, c);
      if (tl) darkCount += 1;
      if (r < size - 1 && c < size - 1) {
        if (getCell(modules, r, c + 1) === tl && getCell(modules, r + 1, c) === tl && getCell(modules, r + 1, c + 1) === tl) {
          penalty += 3;
        }
      }
    }
  }

  const darkPercent = (darkCount * 100) / (size * size);
  const steps = Math.floor(Math.abs(darkPercent - 50) / 5);
  penalty += steps * 10;
  return penalty;
}

function buildFunctionGrid(spec: VersionSpec): { base: boolean[][]; reserved: boolean[][] } {
  const size = spec.version * 4 + 17;
  const base = createGrid(size);
  const reserved = createGrid(size);

  setFinderPattern(base, reserved, 0, 0);
  setFinderPattern(base, reserved, 0, size - 7);
  setFinderPattern(base, reserved, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0;
    setCell(reserved, 6, i, true);
    setCell(base, 6, i, bit);
    setCell(reserved, i, 6, true);
    setCell(base, i, 6, bit);
  }

  const maxCenter = size - 7;
  for (const r of spec.alignmentCenters) {
    for (const c of spec.alignmentCenters) {
      const overlapsTopLeft = r === 6 && c === 6;
      const overlapsTopRight = r === 6 && c === maxCenter;
      const overlapsBottomLeft = r === maxCenter && c === 6;
      if (!overlapsTopLeft && !overlapsTopRight && !overlapsBottomLeft) {
        setAlignmentPattern(base, reserved, r, c);
      }
    }
  }

  reserveFormatAreas(reserved);
  setCell(reserved, size - 8, 8, true);
  setCell(base, size - 8, 8, true);
  reserveAndDrawVersionInfo(base, reserved, spec.version);

  return { base, reserved };
}

function placeCodewords(base: boolean[][], reserved: readonly (readonly boolean[])[], codewords: Uint8Array) {
  const size = base.length;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;

  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) {
      rightCol -= 1;
    }
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [rightCol, rightCol - 1]) {
        if (getCell(reserved, r, c)) continue;
        let bit = false;
        if (bitIndex < totalBits) {
          const byte = atNum(codewords, bitIndex >>> 3);
          bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
        setCell(base, r, c, bit);
      }
    }
    upward = !upward;
  }
}

export function encodeQrMatrix(text: string): QrMatrix | null {
  if (!text) return null;
  const payload = new TextEncoder().encode(text);
  const spec = VERSION_SPECS.find(candidate => payload.length <= candidate.maxBytePayload);
  if (!spec) return null;

  const data = encodeDataCodewords(payload, spec);
  const codewords = interleaveCodewords(data, spec);
  const { base, reserved } = buildFunctionGrid(spec);
  placeCodewords(base, reserved, codewords);

  const size = base.length;
  let bestModules: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row, r) =>
      row.map((val, c) => (getCell(reserved, r, c) ? val : val !== maskMatches(mask, r, c))),
    );
    drawFormatInfo(candidate, mask);
    const penalty = evaluatePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestModules = candidate;
    }
  }

  return bestModules ? { version: spec.version, size, modules: bestModules } : null;
}

export function qrMatrixToPathData(matrix: QrMatrix): string {
  const segments: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    const row = matrix.modules[r];
    if (!row) continue;
    let c = 0;
    while (c < matrix.size) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      const start = c;
      while (c < matrix.size && row[c]) c += 1;
      segments.push(`M${start},${r}h${c - start}v1h-${c - start}z`);
    }
  }
  return segments.join("");
}

export function renderQrSvgString(text: string, quietZone = 4): string | null {
  const matrix = encodeQrMatrix(text);
  if (!matrix) return null;
  const totalSize = matrix.size + quietZone * 2;
  const path = qrMatrixToPathData(matrix);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges"><rect width="${totalSize}" height="${totalSize}" fill="#fff"/><path transform="translate(${quietZone},${quietZone})" d="${path}" fill="#000"/></svg>`;
}
