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
 *                 因为 roundTo32 会使宽高的缩放不对称,用单一 scale 反向
 *                 缩放会造成垂直/水平错位(PaddleOCR 官方 ratio_w/ratio_h)].
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
    /** 0=直立正文(1.7.2:AABB 框 + AABB 得分,无旋转过滤,worker 直接拷贝)
     *  1=倾斜正文(minAreaRect + 旋转矫正裁剪)
     *  2=复合方法(默认:近轴对齐走直接拷贝,真倾斜才拉正) */
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
      // 1.7.2 直立正文:AABB 框 + AABB 得分 + 无旋转过滤(原版行为)
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

export type BoxLike = { raw: { x1: number; y1: number; x2: number; y2: number }; score: number };

/**
 * After rec: drop fragments that sit inside a larger surviving box, then IoU-NMS.
 * Must run AFTER garbage text is removed — a formula parent that recoded as
 * 8888 is already gone, so ABn/ABt stay; a body line stays and eats its chips.
 */
export function nmsBoxes<T extends BoxLike>(boxes: T[], contain = 0.7, iou =  0.5): T[] {
	const withoutChips = boxes.filter((child, i) => {
		const cArea = boxArea(child.raw);
		if (cArea <=  0) return false;
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
			return u >  0 && inter / u >= iou;
		})) continue;
		kept.push(box);
	}
	return readingOrder(kept);
}

/** Group boxes into text lines by y-overlap (≥50% of the smaller height). */
function clusterByY<T extends BoxLike>(boxes: T[]): T[][] {
	const sorted = boxes.slice().sort((a, b) => a.raw.y1 - b.raw.y1 || a.raw.x1 - b.raw.x1);
	const lines: T[][] = [];
	for (const box of sorted) {
		const line = lines[lines.length - 1];
		if (line) {
			const ref = line[0];
			const overlap = Math.min(box.raw.y2, ref.raw.y2) - Math.max(box.raw.y1, ref.raw.y1);
			const minH = Math.min(box.raw.y2 - box.raw.y1, ref.raw.y2 - ref.raw.y1);
			if (minH >  0 && overlap / minH >=  0.5) {
				line.push(box);
				continue;
			}
		}
		lines.push([box]);
	}
	return lines;
}

/**
 * 圈内阅读顺序:先测「真实栏沟」再分堆,不靠页中线/宽度比例猜栏。
 * 做法:块内框按 x 求并集,找最宽一段连续空白(≥ max(12px, 2×中位行高))当沟 —— 单栏块词间
 * 只有几 px,测不到沟就原样 readingOrder。找沟时先丢掉宽度 >60% 块跨度的通栏框(它们会把沟
 * 填平),分类时它们当分隔符:先冲刷左堆、再冲刷右堆,然后自己出。
 * b45 实测:一个圈横跨两栏时输出逐行交错(左1 右1 左2 右2),这个函数治的就是它。
 */
export function stackedOrder<T extends BoxLike>(boxes: T[]): T[] {
	if (boxes.length < 3) return readingOrder(boxes);
	const span = Math.max(...boxes.map((b) => b.raw.x2)) - Math.min(...boxes.map((b) => b.raw.x1));
	if (span <= 0) return readingOrder(boxes);
	const heights = boxes.map((b) => b.raw.y2 - b.raw.y1).sort((a, b) => a - b);
	const minGap = Math.max(12, (heights[Math.floor(heights.length / 2)] || 1) * 2);
	const merged: number[][] = [];
	for (const b of boxes.filter((q) => q.raw.x2 - q.raw.x1 <= span * 0.6).sort((a, b) => a.raw.x1 - b.raw.x1)) {
		const last = merged[merged.length - 1];
		if (last && b.raw.x1 <= last[1]) last[1] = Math.max(last[1], b.raw.x2);
		else merged.push([b.raw.x1, b.raw.x2]);
	}
	let gutter = -1;
	let best = minGap;
	for (let i = 1; i < merged.length; i++) {
		const gap = merged[i][0] - merged[i - 1][1];
		if (gap > best) { best = gap; gutter = (merged[i][0] + merged[i - 1][1]) / 2; }
	}
	if (gutter < 0) return readingOrder(boxes);
	const out: T[] = [];
	let lbuf: T[] = [];
	let rbuf: T[] = [];
	const flush = (): void => { out.push(...readingOrder(lbuf), ...readingOrder(rbuf)); lbuf = []; rbuf = []; };
	for (const b of boxes.slice().sort((a, b) => a.raw.y1 - b.raw.y1)) {
		if (b.raw.x2 <= gutter) lbuf.push(b);
		else if (b.raw.x1 >= gutter) rbuf.push(b);
		else { flush(); out.push(b); }
	}
	flush();
	return out;
}

/**
 * 圈与圈之间的阅读顺序:按 y 归带 → 带内自左而右,返回 rects 下标序(长度同 rects)。
 * 旧写法直接按标注数组序输出 = 按「画框先后」,先画右下再画左上就把文字层整个顺序拧反。
 * 归带分母用**本帧自身高度**,不能复用 clusterByY 的「较小高度」:手绘圈常从页眉一路拉到
 * 摘要(b36 实测 F4 135~694 vs 页眉 F3 79~211),按较小高度会被并进页眉带,右栏摘要就抢在左栏前。
 */
export function frameReadingOrder(
	rects: { x1: number; y1: number; x2: number; y2: number }[],
	pageW?: number,
	twoColumn?: boolean,
): number[] {
	const byTop = rects.map((_, i) => i).sort((a, b) => rects[a].y1 - rects[b].y1 || rects[a].x1 - rects[b].x1);
	const bands: number[][] = [];
	for (const i of byTop) {
		const band = bands[bands.length - 1];
		const ref = band ? rects[band[0]] : undefined;
		const ov = ref ? Math.min(ref.y2, rects[i].y2) - Math.max(ref.y1, rects[i].y1) : -1;
		if (band && ref && ov >= Math.max(1, rects[i].y2 - rects[i].y1) * 0.5) band.push(i);
		else bands.push([i]);
	}
	const order = bands.map((b) => b.sort((x, y) => rects[x].x1 - rects[y].x1)).flat();
	// b56 双栏×圈选:圈=白名单(识别哪些),双栏=圈间顺序(怎么读)。
	// b57 修正墙判据:宽>0.6页宽会把"用户画宽了的栏框"误判成墙(实测摘要圈 61.5%、
	// 标题圈 75% 都超线,右栏反而排到左栏前)。真墙的特征是**两边顶到页边距**
	// (刊头带 53~1151/1190):x1≤8%W 且 x2≥92%W。
	if (!twoColumn || !pageW || pageW <= 0) return order;
	const isFull = (i: number) => rects[i].x1 <= pageW * 0.08 && rects[i].x2 >= pageW * 0.92;
	const cy = (i: number) => (rects[i].y1 + rects[i].y2) / 2;
	const colCmp = (a: number, b: number) => rects[a].y1 - rects[b].y1 || rects[a].x1 - rects[b].x1;
	const cols = order.filter((i) => !isFull(i));
	const emitCols = (lo: number, hi: number): number[] => {
		const inZone = cols.filter((i) => cy(i) > lo && cy(i) <= hi);
		const left = inZone.filter((i) => (rects[i].x1 + rects[i].x2) / 2 < pageW / 2).sort(colCmp);
		const right = inZone.filter((i) => (rects[i].x1 + rects[i].x2) / 2 >= pageW / 2).sort(colCmp);
		return [...left, ...right];
	};
	const out: number[] = [];
	let prev = -Infinity;
	for (const f of order.filter(isFull).sort((a, b) => rects[a].y1 - rects[b].y1)) {
		out.push(...emitCols(prev, rects[f].y1), f);
		prev = rects[f].y1;
	}
	out.push(...emitCols(prev, Infinity));
	return out;
}

/** Top-to-bottom, then left-to-right within a line — PDF selection follows write order. */
export function readingOrder<T extends BoxLike>(boxes: T[]): T[] {
	const lines = clusterByY(boxes);
	for (const line of lines) line.sort((a, b) => a.raw.x1 - b.raw.x1);
	return lines.flat();
}

/** 纵向定带:行中心落在帧的 y 范围内,上下各放宽**半个行高**(手绘圈的边常切在行中间,
 * b46 实测 F3 底 1043 vs 行 1039~1048,中心只差 0.5px 就整行丢)。 */
function lineInBand(
	b: { raw: { x1: number; y1: number; x2: number; y2: number } },
	r: { x1: number; y1: number; x2: number; y2: number },
): boolean {
	const cy = (b.raw.y1 + b.raw.y2) / 2;
	const hy = Math.max(2, (b.raw.y2 - b.raw.y1) / 2);
	return cy >= r.y1 - hy && cy <= r.y2 + hy;
}

/**
 * 圈选白名单的唯一判定(engine 与 pdf-builder 共用)——**行级白名单,按覆盖长度算**:
 * 所有圈在这一行上盖住的**长度 ≥ 整行的 50%** → 整行写入(两头允许超出圈边);否则整行不写。
 * b41~b50 用的是「行中心在任一圈内」,它对**相邻两圈的中缝**无解:b50 实测 4 条页眉行
 * (det#0/1/3/5)横跨 F4(右边界 594)与 F5(左边界 613),两个圈合计盖住 94% 的行,
 * 中心却正好掉进那 19px 缝里 → 明明整行都在圈内却被判"圈外"。
 * 纵向仍走 lineInBand,所以真没圈到的横缝(det#24/25/26/70/82/83)照旧一行不写。
 * @returns 盖住这段行最多的圈下标;不足一半 -1。
 */
export function frameClaimingLine(
	b: { raw: { x1: number; y1: number; x2: number; y2: number } },
	rects: { x1: number; y1: number; x2: number; y2: number }[],
): number {
	const iv: number[][] = [];
	let best = 0;
	let at = -1;
	rects.forEach((r, i) => {
		if (!lineInBand(b, r)) return;
		const s = Math.max(r.x1, b.raw.x1);
		const e = Math.min(r.x2, b.raw.x2);
		if (e <= s) return;
		if (e - s > best) { best = e - s; at = i; }
		iv.push([s, e]);
	});
	if (at < 0) return -1;
	iv.sort((p, q) => p[0] - q[0]);
	let covered = 0;
	let end = -1;
	for (const [s, e] of iv) {
		if (s > end) covered += e - s;
		else if (e > end) covered += e - end;
		end = Math.max(end, e);
	}
	return covered / Math.max(1, b.raw.x2 - b.raw.x1) >= 0.5 ? at : -1;
}

/**
 * rec 出的字符数明显撑不满框宽 = det 给的 quad 把这一行裁扁/裁歪了(b48 实测整页通道把
 * "Article history:" 读成 "e:",同一框用 AABB 重 rec 就正常)。判据:len×2 < 框宽/行高。
 * 英文小写正文实测约 1 字符占一个行高宽,掉到一半以下才算异常。
 */
export function lowDensityLine(b: {
	raw: { x1: number; y1: number; x2: number; y2: number };
	text?: string;
}): boolean {
	const h = Math.max(1, b.raw.y2 - b.raw.y1);
	return (b.text || "").trim().length * 2 < (b.raw.x2 - b.raw.x1) / h;
}

/** 宽于此的框当通栏(标题/通栏图/满宽公式),不参与左右栏归类]. */
const FULL_WIDE_SHARE =  0.55;

/** 双栏阅读顺序(整页版):小框按中心 x 归左右栏,宽框当通栏。 */
export function sortedLayoutBoxes<T extends BoxLike>(boxes: T[], pageWidth: number): T[] {
	return splitRegion(boxes, 0, pageWidth);
}

/** 在 x∈[x1,x2] 范围内做双栏切分:小框按中心 x 在区间中线左右归栏;宽于此区间 55% 的框、或骑在中线上的框(居中的版权行/通栏短行/跨栏图表)当通栏,先冲左右栏再原地输出。 */
function splitRegion<T extends BoxLike>(boxes: T[], x1: number, x2: number): T[] {
	const sorted = boxes.slice().sort((a, b) => a.raw.y1 - b.raw.y1 || a.raw.x1 - b.raw.x1);
	const out: T[] = [];
	let left: T[] = [];
	let right: T[] = [];
	const flush = (): void => {
		out.push(...readingOrder(left), ...readingOrder(right));
		left = [];
		right = [];
	};
	const mid = (x1 + x2) / 2;
	const fullWide = FULL_WIDE_SHARE * (x2 - x1);
	for (const b of sorted) {
		const { x1: bx1, x2: bx2 } = b.raw;
		// 跨中线且"骑在中线上"(居中≤5% 区间宽)才算通栏:版权行/居中短标题/跨栏图表。
		// 只跨一点点的非对称栏(如摘要 37/63 的右栏)仍按中心 x 归栏,否则会被当通栏与左栏逐行交错。
		// ponytail: 中线取区间几何中点,分栏严重偏心时仍靠中心 x 归类兜住;真要精细就逐带投票找 gutter。
		const straddle = bx1 < mid && bx2 > mid && Math.abs((bx1 + bx2) / 2 - mid) <= 0.05 * (x2 - x1);
		if (bx2 - bx1 >= fullWide || straddle) {
			flush();
			out.push(b);
		} else {
			((bx1 + bx2) / 2 < mid ? left : right).push(b);
		}
	}
	flush();
	return out;
}

/**
 * Default = RapidOCR/Paddle `sorted_boxes` (Y then X via readingOrder).
 * `twoColumn` = 双栏阅读顺序(先左栏后右栏)].Off unless the user asks..
 */
export function orderBoxes<T extends BoxLike>(boxes: T[], pageWidth?: number, twoColumn = false): T[] {
	if (twoColumn && pageWidth && pageWidth >  0) return sortedLayoutBoxes(boxes, pageWidth);
	return readingOrder(boxes);
}

export function isGarbageText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // b60: 同字符连跑只有"主导短串"才算 CTC 塌缩伪影。旧规则 run>=4 无差别枪毙,
  // 把长串里合法的 9999(zhangtao9999@hotmail.com)也杀了——识别再准也进不了文字层。
  let run = 1;
  for (let i = 1; i < t.length; i++) {
    run = t[i] === t[i - 1] ? run + 1 : 1;
    if (run >= 4 && run * 3 >= t.length) return true;
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

// ─── b59 高分辨率抢救:框坐标整体缩放 ────────────────────────────────

/**
 * 把框(points + raw)按 ratio 缩放,用于在 4× 重渲染图上重新裁剪 rec。
 * 纯函数:round-trip scaleBox(scaleBox(b,r),1/r) === b(整数坐标下)。
 */
export function scaleBox<T extends { points: number[]; raw: { x1: number; y1: number; x2: number; y2: number } }>(
	b: T,
	ratio: number,
): T {
	const r = (v: number): number => Math.round(v * ratio);
	return {
		...b,
		points: b.points.map(r),
		raw: { x1: r(b.raw.x1), y1: r(b.raw.y1), x2: r(b.raw.x2), y2: r(b.raw.y2) },
	};
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
  const times: number[] = []; // 每个字符发射的 timestep(空格恢复用)
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
      times.push(t);
    }
    prevIdx = maxIdx;
  }
  if (!chars.length) return "";

  // b62 词间空格恢复:小字/双栏正文里 CTC 常不发空格类("andTechnology")。两条证据其一即插:
  //  1) 概率证据 —— 词间空隙里模型其实投过 Space 概率(实测真空格 maxSpace 0.11~0.38,词内几乎
  //     恒 ≤0.002),次强证据干净可分,这是主判据;
  //  2) 步长证据 —— 大字号标题里模型对空格不投票,退化为「间隙 ≥ 词内中位步长 ×1.55」。
  //     宽字母 m/w/M/W 的邻对天然偏大(发射点在字形中心,宽字把间距顶长),步长证据禁用
  //     这种邻对,交给概率证据兜底——否则满页 "fro m""chro matography"。
  // 只在两个可打印 ASCII 之间插(中文/汉字不参与),模型已吐出的空格不重复插。
  const isAsciiChar = (ch: string): boolean =>
    ch.length === 1 && ch.charCodeAt(0) > 0x20 && ch.charCodeAt(0) < 0x7f;
  let spaceIdx = -1;
  for (let i = charDict.length - 1; i > 0; i--) {
    if (charDict[i] === " ") { spaceIdx = i; break; }
  }
  const gaps: number[] = [];
  for (let i = 1; i < chars.length; i++) {
    if (isAsciiChar(chars[i - 1]) && isAsciiChar(chars[i])) gaps.push(times[i] - times[i - 1]);
  }
  // 中位步长;样本太少(单词/缩写单独成行)时按不可信处理
  let cut = Infinity;
  if (gaps.length >= 8) {
    const sorted = gaps.slice().sort((a, b) => a - b);
    cut = sorted[Math.floor(sorted.length / 2)] * 1.55;
  }
  const SPACE_PROB_MIN = 0.1; // ponytail: 实测分界面;调低会在 m/w 宽字母后误插("fro m")
  let out = chars[0];
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] !== " " && chars[i - 1] !== " "
      && isAsciiChar(chars[i - 1]) && isAsciiChar(chars[i])) {
      const wide = "mwMW";
      let hit = !wide.includes(chars[i - 1]) && !wide.includes(chars[i])
        && times[i] - times[i - 1] >= cut;
      if (!hit && spaceIdx > 0 && spaceIdx < numClasses) {
        let maxSpace = 0;
        for (let tt = times[i - 1]; tt < times[i]; tt++) {
          const p = probs[tt * numClasses + spaceIdx];
          if (p > maxSpace) maxSpace = p;
        }
        hit = maxSpace >= SPACE_PROB_MIN;
      }
      if (hit) out += " ";
    }
    out += chars[i];
  }
  return out;
}