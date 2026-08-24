// src/ocr/postprocess.ts
// PP-OCRv4 post-processing: DB (detection) + CTC (recognition).
// Pure-JS implementation — no OpenCV, no numpy.

// ─── helpers ─────────────────────────────────────────────────────────

/** 8-connected flood fill to find connected components in a binary mask. */
function connectedComponents(
  binary: Uint8Array,
  width: number,
  height: number,
): number[][] {
  const visited = new Uint8Array(width * height);
  const components: number[][] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!binary[idx] || visited[idx]) continue;

      // Flood fill (8-connected — matches OpenCV's findContours connectivity)
      const comp: number[] = [];
      const stack = [idx];
      visited[idx] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        comp.push(p);
        const px = p % width;
        const py = (p / width) | 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1],
                                 [-1,-1], [1,-1], [-1, 1], [1, 1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const ni = ny * width + nx;
            if (binary[ni] && !visited[ni]) {
              visited[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }
      components.push(comp);
    }
  }
  return components;
}

/** Axis-aligned bounding box of a component. */
function compBBox(
  comp: number[],
  width: number,
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of comp) {
    const x = p % width;
    const y = (p / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Mean score of the probability map within the bounding box. */
function boxScore(
  probMap: Float32Array,
  mapW: number,
  box: { x: number; y: number; w: number; h: number },
): number {
  let sum = 0, count = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      sum += probMap[y * mapW + x];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ─── det postprocess (simplified DB) ─────────────────────────────────

export interface DetBox {
  /** 4 corner points in original image coordinates: [x1,y1, x2,y2, x3,y3, x4,y4] */
  points: number[];
  /**
   * Un-clipped (raw) bounding box in original image coordinates — the
   * connected component that the box was derived from, BEFORE the unclip
   * expansion. This is the true text region and should be used to place
   * the invisible text layer so it aligns with the original glyphs.
   */
  raw: { x1: number; y1: number; x2: number; y2: number };
  score: number;
}

export interface DetPostprocessResult {
  boxes: DetBox[];
}

/**
 * Simplified DB postprocess.
 *
 * Steps:
 * 1. Threshold probability map → binary mask
 * 2. Dilation (2×2, optional)
 * 3. Connected components → bounding boxes
 * 4. Score filtering
 * 5. Scale back to original image coordinates
 *
 * @param probMap  Flat Float32Array of the det model output [H, W].
 * @param mapW     Width of the probability map.
 * @param mapH     Height of the probability map.
 * @param origW    Original image width (before resize).
 * @param origH    Original image height (before resize).
 * @param scaleX   X resize factor (resized / original). 与 scaleY 独立 —
 *                 因为 roundTo32 会使宽高的缩放不对称，用单一 scale 反向
 *                 缩放会造成垂直/水平错位（PaddleOCR 官方 ratio_w/ratio_h）。
 * @param scaleY   Y resize factor (resized / original).
 * @param options  Tuning parameters.
 */
export function detPostprocess(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  origW: number,
  origH: number,
  scaleX: number,
  scaleY: number,
  options: {
    thresh?: number;
    boxThresh?: number;
    minSize?: number;
    useDilation?: boolean;
  } = {},
): DetPostprocessResult {
  const { thresh = 0.3, boxThresh = 0.5, minSize = 3, useDilation = true } = options;

  // 1. Threshold
  const binary = new Uint8Array(mapW * mapH);
  for (let i = 0; i < mapW * mapH; i++) {
    binary[i] = probMap[i] > thresh ? 1 : 0;
  }

  // 2. Optional dilation (2×2 kernel)
  if (useDilation) {
    const dilated = new Uint8Array(mapW * mapH);
    for (let y = 0; y < mapH; y++) {
      for (let x = 0; x < mapW; x++) {
        const idx = y * mapW + x;
        if (binary[idx]) {
          dilated[idx] = 1;
          for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < mapW && ny < mapH) {
              dilated[ny * mapW + nx] = 1;
            }
          }
        }
      }
    }
    for (let i = 0; i < mapW * mapH; i++) binary[i] = dilated[i];
  }

  // 3. Connected components
  const components = connectedComponents(binary, mapW, mapH);

  // 4. Convert to boxes, unclip, filter, scale
  const boxes: DetBox[] = [];
  const invScaleX = 1 / scaleX;
  const invScaleY = 1 / scaleY;
  const unclipRatio = 1.6;  // matching RapidOCR config

  for (const comp of components) {
    const bbox = compBBox(comp, mapW);
    if (bbox.w < minSize || bbox.h < minSize) continue;

    // Score is computed on the ORIGINAL box (pre-unclip) — matches Python
    const score = boxScore(probMap, mapW, bbox);
    if (score < boxThresh) continue;

    // Unclip: expand the box by distance = area * unclipRatio / perimeter
    // This approximates pyclipper's polygon offset in the Python code.
    const area = bbox.w * bbox.h;
    const peri = 2 * (bbox.w + bbox.h);
    const dist = peri > 0 ? (area * unclipRatio) / peri : 0;

    // Expanded box (clamped to map bounds)
    const ux1 = Math.max(0, Math.floor(bbox.x - dist));
    const uy1 = Math.max(0, Math.floor(bbox.y - dist));
    const ux2 = Math.min(mapW - 1, Math.ceil(bbox.x + bbox.w + dist));
    const uy2 = Math.min(mapH - 1, Math.ceil(bbox.y + bbox.h + dist));

    // Scale back to original coordinates (X and Y independently — roundTo32
    // makes the resize ratios differ between axes, PaddleOCR ratio_w/ratio_h)
    const x1 = Math.round(ux1 * invScaleX);
    const y1 = Math.round(uy1 * invScaleY);
    const x2 = Math.round(ux2 * invScaleX);
    const y2 = Math.round(uy2 * invScaleY);

    // Clamp to original image bounds
    const cx1 = Math.max(0, Math.min(x1, origW - 1));
    const cy1 = Math.max(0, Math.min(y1, origH - 1));
    const cx2 = Math.max(0, Math.min(x2, origW - 1));
    const cy2 = Math.max(0, Math.min(y2, origH - 1));

    // Raw (pre-unclip) bounding box, also scaled back to original coords —
    // this is the true text region for the invisible text layer.
    const r1 = Math.max(0, Math.min(Math.round(bbox.x * invScaleX), origW - 1));
    const rt1 = Math.max(0, Math.min(Math.round(bbox.y * invScaleY), origH - 1));
    const r2 = Math.max(0, Math.min(Math.round((bbox.x + bbox.w) * invScaleX), origW - 1));
    const rt2 = Math.max(0, Math.min(Math.round((bbox.y + bbox.h) * invScaleY), origH - 1));

    // 4 corner points: top-left, top-right, bottom-right, bottom-left
    boxes.push({
      points: [cx1, cy1, cx2, cy1, cx2, cy2, cx1, cy2],
      raw: { x1: r1, y1: rt1, x2: r2, y2: rt2 },
      score,
    });
  }

  return { boxes };
}

function boxArea(b: { x1: number; y1: number; x2: number; y2: number }): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

function boxIntersection(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

type BoxLike = { raw: { x1: number; y1: number; x2: number; y2: number }; score: number };

/**
 * After rec: drop fragments that sit inside a larger surviving box, then IoU-NMS.
 * Must run AFTER garbage text is removed — a formula parent that recoded as
 * 8888 is already gone, so ABn/ABt stay; a body line stays and eats its chips.
 */
export function nmsBoxes<T extends BoxLike>(boxes: T[], contain = 0.7, iou = 0.5): T[] {
  const withoutChips = boxes.filter((child, i) => {
    const cArea = boxArea(child.raw);
    if (cArea <= 0) return false;
    return !boxes.some((parent, j) => {
      if (i === j) return false;
      const pArea = boxArea(parent.raw);
      if (pArea <= cArea) return false;
      return boxIntersection(parent.raw, child.raw) / cArea >= contain;
    });
  });
  const order = withoutChips.slice().sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const box of order) {
    const a = boxArea(box.raw);
    if (kept.some((k) => {
      const inter = boxIntersection(box.raw, k.raw);
      const u = a + boxArea(k.raw) - inter;
      return u > 0 && inter / u >= iou;
    })) continue;
    kept.push(box);
  }
  return readingOrder(kept);
}

/** Top-to-bottom, then left-to-right within a line — PDF selection follows write order. */
export function readingOrder<T extends BoxLike>(boxes: T[]): T[] {
  const sorted = boxes.slice().sort((a, b) => a.raw.y1 - b.raw.y1 || a.raw.x1 - b.raw.x1);
  const lines: T[][] = [];
  for (const box of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const ref = line[0];
      const overlap = Math.min(box.raw.y2, ref.raw.y2) - Math.max(box.raw.y1, ref.raw.y1);
      const minH = Math.min(box.raw.y2 - box.raw.y1, ref.raw.y2 - ref.raw.y1);
      if (minH > 0 && overlap / minH >= 0.5) {
        line.push(box);
        continue;
      }
    }
    lines.push([box]);
  }
  for (const line of lines) line.sort((a, b) => a.raw.x1 - b.raw.x1);
  return lines.flat();
}

/** Fraction bars recode as 8888… — don't write those into the PDF. */
export function isGarbageText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  let run = 1;
  for (let i = 1; i < t.length; i++) {
    run = t[i] === t[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  const counts = new Map<string, number>();
  for (const ch of t) {
    if (ch === " ") continue;
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let n = 0, max = 0;
  for (const c of counts.values()) { n += c; if (c > max) max = c; }
  if (n >= 6 && max / n >= 0.5) return true;
  const useful = t.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, "").length;
  return useful < 2 && t.length >= 4;
}

// ─── rec decode (CTC) ───────────────────────────────────────────────

/**
 * Simple CTC decode for a single prediction sequence.
 *
 * @param probs     Flat Float32Array [seq_len, num_classes].
 * @param seqLen    Sequence length.
 * @param numClasses  Number of output classes (including blank).
 * @param charDict  Character dictionary (index 0 = blank).
 * @returns         Decoded text string.
 */
export function recDecode(
  probs: Float32Array,
  seqLen: number,
  numClasses: number,
  charDict: string[],
): string {
  if (numClasses > charDict.length) {
    // Model has more classes than dict entries; pad with empty strings
    while (charDict.length < numClasses) charDict.push("");
  }

  const chars: string[] = [];
  let prevIdx = -1;

  for (let t = 0; t < seqLen; t++) {
    const offset = t * numClasses;
    // Argmax
    let maxIdx = 0;
    let maxVal = probs[offset];
    for (let c = 1; c < numClasses; c++) {
      if (probs[offset + c] > maxVal) {
        maxVal = probs[offset + c];
        maxIdx = c;
      }
    }

    // Skip blank (index 0) and consecutive duplicates
    if (maxIdx !== 0 && maxIdx !== prevIdx) {
      chars.push(charDict[maxIdx] || "?");
    }
    prevIdx = maxIdx;
  }

  return chars.join("");
}