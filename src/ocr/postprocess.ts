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

/** Mean probability over the component's own pixels (the text region).
 *  PaddleOCR's box_score_fast fills the contour as a mask — an AABB mean
 *  would dilute with the empty corner triangles of a rotated box and drop
 *  valid tilted text below the box threshold. */
function compScore(probMap: Float32Array, comp: number[]): number {
  let sum = 0;
  for (const p of comp) sum += probMap[p];
  return comp.length > 0 ? sum / comp.length : 0;
}

/** Mean probability over the AABB (1.7.2 behavior — used by cropMode 0). */
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

// ─── geometry: convex hull + minAreaRect + convex polygon offset ─────
// Pure-JS replacements for OpenCV (minAreaRect) and pyclipper (unclip),
// so rotated text boxes get a proper rotated quad instead of an AABB.

type Pt = [number, number];

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew monotone chain → convex hull, counter-clockwise. */
function convexHull(pts: Pt[]): Pt[] {
  if (pts.length <= 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function polygonPerimeter(pts: Pt[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

/**
 * Minimum-area enclosing rectangle (rotating calipers over hull edges).
 * O(n²) on the hull — text blobs are small, fine for hundreds of boxes.
 * Returns the 4 corners (cyclic) and the rect area.
 */
function minAreaRect(pts: Pt[]): { corners: Pt[]; area: number } {
  const hull = convexHull(pts);
  const n = hull.length;
  if (n < 3) return { corners: hull, area: 0 };
  let bestArea = Infinity, best: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const nx = -dy, ny = dx; // unit normal
    let minD = 0, maxD = 0, minN = 0, maxN = 0;
    for (const p of hull) {
      const d = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
      const nn = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
      if (d < minD) minD = d; if (d > maxD) maxD = d;
      if (nn < minN) minN = nn; if (nn > maxN) maxN = nn;
    }
    const area = (maxD - minD) * (maxN - minN);
    if (area < bestArea) {
      bestArea = area;
      best = [
        [a[0] + minD * dx + minN * nx, a[1] + minD * dy + minN * ny],
        [a[0] + maxD * dx + minN * nx, a[1] + maxD * dy + minN * ny],
        [a[0] + maxD * dx + maxN * nx, a[1] + maxD * dy + maxN * ny],
        [a[0] + minD * dx + maxN * nx, a[1] + minD * dy + maxN * ny],
      ];
    }
  }
  return { corners: best, area: bestArea };
}

/**
 * Order minAreaRect corners as [TL, TR, BR, BL] for the rec crop.
 * The TEXT READING DIRECTION is the quad's LONG AXIS — make it the top edge
 * (TL→TR), with TL = the long-axis endpoint with the smaller x (the left end).
 * This deskews BOTH slope directions correctly: the old "topmost corner"
 * heuristic put the SHORT edge on top for negative-slope lines, feeding the
 * recognizer a 90°-rotated crop (→ missed text).
 *
 * `corners` must be cyclic ([c0,c1,c2,c3], as minAreaRect returns). The long
 * axis is the LONGER ADJACENT SIDE (edge01 or edge12) — never the diagonal,
 * which is the farthest point-pair but not the text direction.
 */
function orderRectCorners(corners: Pt[]): Pt[] {
  const e01 = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
  const e12 = Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
  let TL: Pt, TR: Pt, BL: Pt, BR: Pt;
  if (e01 >= e12) {
    // long side = c0–c1; short neighbors: c3 (of c0) and c2 (of c1)
    [TL, TR, BL, BR] = corners[0][0] <= corners[1][0]
      ? [corners[0], corners[1], corners[3], corners[2]]
      : [corners[1], corners[0], corners[2], corners[3]];
  } else {
    // long side = c1–c2; short neighbors: c0 (of c1) and c3 (of c2)
    [TL, TR, BL, BR] = corners[1][0] <= corners[2][0]
      ? [corners[1], corners[2], corners[0], corners[3]]
      : [corners[2], corners[1], corners[3], corners[0]];
  }
  return [TL, TR, BR, BL];
}

/**
 * Outward offset of a convex polygon by `dist` (official DB unclip, pyclipper
 * equivalent). Each edge is translated outward along its normal, then adjacent
 * offset edges are intersected to rebuild the vertex. Exact for convex quads —
 * no pyclipper dependency needed.
 */
function offsetPolygon(hull: Pt[], dist: number): Pt[] {
  const n = hull.length;
  const sign = polygonArea(hull) >= 0 ? 1 : -1; // CCW → outward is the right-hand normal
  const offStart: Pt[] = [], dir: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy * sign / len, ny = -dx * sign / len;
    offStart.push([a[0] + dist * nx, a[1] + dist * ny]);
    dir.push([dx, dy]);
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = offStart[(i - 1 + n) % n], d1 = dir[(i - 1 + n) % n];
    const p2 = offStart[i], d2 = dir[i];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9) { out.push([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]); continue; }
    const t1 = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
    out.push([p1[0] + t1 * d1[0], p1[1] + t1 * d1[1]]);
  }
  return out;
}

// ─── det postprocess (simplified DB) ─────────────────────────────────

export interface DetBox {
  /** 4 corner points in original image coords, ordered [TL, TR, BR, BL].
   *  minAreaRect quad — may be rotated (not an AABB), for the rec crop. */
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
    /** Drop boxes whose long axis is tilted more than this many degrees from
     *  horizontal (diagonal watermarks / rotated stamps). PP-OCRv4 rec only
     *  reads horizontal text; these aren't content anyway — keep the layer clean. */
    maxRotDeg?: number;
    /** 0=直立正文（1.7.2：AABB 框 + AABB 得分，无旋转过滤，worker 直接拷贝）
     *  1=倾斜正文（minAreaRect + 旋转矫正裁剪）
     *  2=复合方法（默认：近轴对齐走直接拷贝，真倾斜才拉正） */
    cropMode?: number;
  } = {},
): DetPostprocessResult {
  const { thresh = 0.3, boxThresh = 0.5, minSize = 3, useDilation = true, maxRotDeg = 30, cropMode = 2 } = options;

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

  // 4. Convert to boxes, unclip (convex polygon offset), scale
  const boxes: DetBox[] = [];
  const invScaleX = 1 / scaleX;
  const invScaleY = 1 / scaleY;
  const unclipRatio = 1.6;  // matching RapidOCR config
  const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  for (const comp of components) {
    const bbox = compBBox(comp, mapW);
    if (bbox.w < minSize || bbox.h < minSize) continue;

    if (cropMode === 0) {
      // 1.7.2 直立正文：AABB 框 + AABB 得分 + 无旋转过滤（原版行为）
      const score = boxScore(probMap, mapW, bbox);
      if (score < boxThresh) continue;
      const dist = (bbox.w * bbox.h * unclipRatio) / (2 * (bbox.w + bbox.h));
      const x1 = Math.round(clampTo((bbox.x - dist) * invScaleX, 0, origW - 1));
      const y1 = Math.round(clampTo((bbox.y - dist) * invScaleY, 0, origH - 1));
      const x2 = Math.round(clampTo((bbox.x + bbox.w + dist) * invScaleX, 0, origW - 1));
      const y2 = Math.round(clampTo((bbox.y + bbox.h + dist) * invScaleY, 0, origH - 1));
      const r1 = Math.round(clampTo(bbox.x * invScaleX, 0, origW - 1));
      const rt1 = Math.round(clampTo(bbox.y * invScaleY, 0, origH - 1));
      const r2 = Math.round(clampTo((bbox.x + bbox.w) * invScaleX, 0, origW - 1));
      const rt2 = Math.round(clampTo((bbox.y + bbox.h) * invScaleY, 0, origH - 1));
      boxes.push({
        points: [x1, y1, x2, y1, x2, y2, x1, y2], // AABB, TL,TR,BR,BL
        raw: { x1: r1, y1: rt1, x2: r2, y2: rt2 },
        score,
      });
      continue;
    }

    // mode 1/2 — score over the component region (pre-unclip) — matches PaddleOCR
    const score = compScore(probMap, comp);
    if (score < boxThresh) continue;

    // Component pixels → convex hull → minAreaRect quad (official: contour →
    // unclip → minAreaRect). dist = area * unclipRatio / perimeter (PaddleOCR).
    const pts: Pt[] = [];
    for (const p of comp) pts.push([p % mapW, (p / mapW) | 0]);
    const hull = convexHull(pts);
    const area = Math.abs(polygonArea(hull));
    const peri = polygonPerimeter(hull);
    if (area <= 0 || peri <= 0) continue;
    const dist = (area * unclipRatio) / peri;
    const quad = orderRectCorners(minAreaRect(offsetPolygon(hull, dist)).corners);

    // Drop steeply-rotated boxes (diagonal watermarks/stamps). With the new
    // ordering, TL→TR is the long axis (text direction), so the angle is
    // well-defined. Guard with aspect ratio: near-square boxes (single chars,
    // math symbols) have a meaningless "long axis" angle and are NOT watermarks
    // — only filter clearly-elongated boxes (real lines/watermarks).
    if (maxRotDeg < 90) {
      const longLen = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
      const shortLen = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
      if (longLen > 0 && longLen / shortLen >= 1.5) {
        const deg = Math.abs(Math.atan2(quad[1][1] - quad[0][1], quad[1][0] - quad[0][0])) * 180 / Math.PI;
        if (Math.min(deg, 180 - deg) > maxRotDeg) continue;
      }
    }

    // Scale back to original coords (X/Y independently — roundTo32 skews
    // ratios; PaddleOCR ratio_w/ratio_h), clamp to image bounds.
    const scaled = quad.map(([x, y]) => [
      Math.round(clampTo(x * invScaleX, 0, origW - 1)),
      Math.round(clampTo(y * invScaleY, 0, origH - 1)),
    ]);

    // Raw (pre-unclip) AABB, scaled back — the true text region for the
    // invisible text layer (unclipped quad is too padded for exact overlay).
    const r1 = Math.round(clampTo(bbox.x * invScaleX, 0, origW - 1));
    const rt1 = Math.round(clampTo(bbox.y * invScaleY, 0, origH - 1));
    const r2 = Math.round(clampTo((bbox.x + bbox.w) * invScaleX, 0, origW - 1));
    const rt2 = Math.round(clampTo((bbox.y + bbox.h) * invScaleY, 0, origH - 1));

    boxes.push({
      points: [scaled[0][0], scaled[0][1], scaled[1][0], scaled[1][1], scaled[2][0], scaled[2][1], scaled[3][0], scaled[3][1]],
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
export function nmsBoxes<T extends BoxLike>(boxes: T[], contain = 0.7, iou = 0.5, pageWidth?: number): T[] {
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
  return orderBoxes(kept, pageWidth);
}

// ─── column-aware page ordering ─────────────────────────────────────

/** Full-wide threshold as a share of page width (titles/abstracts/spanning figures). */
const FULL_WIDE_SHARE = 0.55;
/** A blank vertical band must be at least this share of page width to count as a gutter.
 *  1.2% ≈ 14px @A4/144dpi — dense journal gutters measure only ~1.7-2.1% (实测 Springer
 *  排版 4-5mm 栏间距)；贯穿全部行高的连续细缝在单栏内几乎不存在，误判由显著性检查兜底。 */
const GUTTER_MIN_SHARE = 0.012;
/** Each side of a gutter needs at least this many boxes… */
const GUTTER_MIN_BOXES = 3;
/** …and at least this share of the non-full-wide boxes. */
const GUTTER_MIN_SHARE_BOXES = 0.15;
/** x 区间精确扫描（排序 + 单遍合并），无分桶量化误差——19px 的窄沟也能测出。 */
/** More candidate columns than this → pathological, fall back to single column. */
const MAX_COLUMNS = 3;

/** 诊断输出：列检测的结果与回退原因（测试构建期无条件打印，正式版再收口）。 */
export interface ColumnDiag {
  reason: string;
  cuts: number;
  /** 实测的纵向空白带宽度（px，降序前几条） */
  gaps: number[];
}

/**
 * Page-level reading order with optional column detection.
 * 双栏页面按「左栏全部 → 右栏全部」排序；单栏与无法确定的情况走原
 * `readingOrder()`（单列语义）。检测是保守的：任何显著性/位置条件不满足
 * 都回退——最坏情况 = v1.9 行为，永不劣化。
 */
export function orderBoxes<T extends BoxLike>(boxes: T[], pageWidth?: number, diag?: ColumnDiag): T[] {
  if (!pageWidth || pageWidth <= 0 || boxes.length < 8) {
    if (diag) { diag.reason = "too-few-boxes-or-no-width"; diag.cuts = 0; diag.gaps = []; }
    return readingOrder(boxes);
  }
  const groups = detectColumnGroups(boxes, pageWidth, diag);
  if (!groups) return readingOrder(boxes);
  if (diag) diag.reason = "ok";
  const out: T[] = [];
  for (const group of groups) out.push(...readingOrder(group));
  return out;
}

/**
 * Split page boxes into column groups, or null when the page does not
 * clearly look columnar. Full-wide boxes (titles/abstracts) are only kept
 * — as a leading group — when they all sit ABOVE the columnar body; any
 * mid-page spanning element means the layout is not a clean column grid.
 */
function detectColumnGroups<T extends BoxLike>(boxes: T[], pageWidth: number, diag?: ColumnDiag): T[][] | null {
  const setDiag = (reason: string, cuts: number, gaps: number[]): void => {
    if (diag) { diag.reason = reason; diag.cuts = cuts; diag.gaps = gaps; }
  };
  const fullWideLimit = FULL_WIDE_SHARE * pageWidth;
  const fullWide: T[] = [];
  const rest: T[] = [];
  for (const b of boxes) {
    (b.raw.x2 - b.raw.x1 >= fullWideLimit ? fullWide : rest).push(b);
  }
  if (rest.length < 6) {
    setDiag("too-few-body-boxes", 0, []);
    return null;
  }

  // Sort intervals by x1, sweep once to find vertical blank bands (exact, no quantization)
  const sorted = rest.map((b) => [b.raw.x1, b.raw.x2] as [number, number]).sort((p, q) => p[0] - q[0]);
  const minGapPx = GUTTER_MIN_SHARE * pageWidth;
  const cuts: number[] = []; // midpoint of each detected gutter
  const allGaps: number[] = [];
  let contentStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (const [x1, x2] of sorted) {
    const gap = x1 - curEnd;
    if (gap > 0) allGaps.push(gap);
    if (gap >= minGapPx) cuts.push((curEnd + x1) / 2);
    if (x2 > curEnd) curEnd = x2;
  }
  const contentEnd = curEnd;
  allGaps.sort((p, q) => q - p);
  setDiag("pending", cuts.length, allGaps.slice(0, 4));
  if (cuts.length < 1) { setDiag("no-gutter-widest-" + Math.round(allGaps[0] ?? 0) + "px", 0, allGaps.slice(0, 4)); return null; }
  if (cuts.length > MAX_COLUMNS - 1) { setDiag("too-many-cuts", cuts.length, allGaps.slice(0, 4)); return null; }

  const bounds: number[] = [contentStart, ...cuts, contentEnd];
  const groups: T[][] = Array.from({ length: bounds.length - 1 }, () => []);
  const minSide = Math.max(GUTTER_MIN_BOXES, Math.ceil(rest.length * GUTTER_MIN_SHARE_BOXES));
  for (const b of rest) {
    const cx = (b.raw.x1 + b.raw.x2) / 2;
    let gi = 0;
    while (gi < cuts.length && cx >= bounds[gi + 1]) gi++;
    groups[gi].push(b);
  }
  if (groups.some((g) => g.length < minSide)) {
    setDiag("weak-side", cuts.length, allGaps.slice(0, 4));
    return null;
  }

  if (fullWide.length) {
    const bodyTop = Math.min(...rest.map((b) => b.raw.y1));
    if (!fullWide.every((b) => b.raw.y2 <= bodyTop)) {
      setDiag("midpage-spanning-full-wide", cuts.length, allGaps.slice(0, 4));
      return null;
    }
    setDiag("ok-with-fullwide-header", cuts.length, allGaps.slice(0, 4));
    return [fullWide, ...groups];
  }
  return groups;
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