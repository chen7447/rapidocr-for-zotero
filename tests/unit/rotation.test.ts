import assert from "node:assert/strict";
import test from "node:test";

import { detPostprocess } from "../../src/ocr/postprocess";
import { cropQuad } from "../../src/ocr/preprocess";

// Synthesize a probability map with one filled rotated rectangle (the "text").
function renderRect(mapW: number, mapH: number, cx: number, cy: number, w: number, h: number, angleDeg: number): Float32Array {
  const m = new Float32Array(mapW * mapH);
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const dx = x - cx, dy = y - cy;
      const rx = dx * cos + dy * sin, ry = -dx * sin + dy * cos; // inverse-rotate
      if (Math.abs(rx) <= w / 2 && Math.abs(ry) <= h / 2) m[y * mapW + x] = 1.0;
    }
  }
  return m;
}

function topEdgeAngle(points: number[]): number {
  // points = [TL, TR, BR, BL]; top edge = TL→TR
  const deg = (Math.atan2(points[3] - points[1], points[2] - points[0]) * 180) / Math.PI;
  return Math.abs(deg);
}

function edgeLen(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

// detPostprocess must return a ROTATED quad (not the old axis-aligned AABB)
// for a tilted text blob, with the top edge along the text long axis.
test("detPostprocess recovers a rotated (non-AABB) quad for a 15° text blob", () => {
  const mapW = 200, mapH = 200;
  const prob = renderRect(mapW, mapH, 100, 100, 80, 20, 15);
  const { boxes } = detPostprocess(prob, mapW, mapH, mapW, mapH, 1, 1, { minSize: 3 });

  assert.equal(boxes.length, 1, "expected exactly one detected box");
  const q = boxes[0].points;
  // old AABB would give a horizontal top edge (angle 0) — rotated must be ~15°
  assert.ok(topEdgeAngle(q) >= 10 && topEdgeAngle(q) <= 20, `top edge angle = ${topEdgeAngle(q)}`);
  // unclip expands the 80x20 rect by dist = area*1.6/peri = 12.8 → ~105.6 x 45.6
  const topLen = edgeLen(q[0], q[1], q[2], q[3]);
  const sideLen = edgeLen(q[0], q[1], q[6], q[7]);
  assert.ok(topLen > 100 && topLen < 112, `top edge length = ${topLen}`);
  assert.ok(sideLen > 40 && sideLen < 50, `side edge length = ${sideLen}`);
  // `raw` stays the pre-unclip AABB — it sits INSIDE the expanded quad
  // (unclip grows the box), so raw.y1 is below quad.TL.y (y-down).
  assert.ok(boxes[0].raw.y1 >= q[1] && boxes[0].raw.x1 >= q[0]);
});

test("cropQuad rectifies a rotated quad back to an upright filled bar", () => {
  const W = 200, H = 200;
  const img = new Uint8ClampedArray(W * H * 4); // black
  // white 80x20 bar rotated 15° about center
  const a = (15 * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = 100, cy = 100, w = 80, h = 20;
  const corners: number[] = []; // [TL,TR,BR,BL]
  for (const [lx, ly] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
    corners.push(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const rx = dx * cos + dy * sin, ry = -dx * sin + dy * cos;
      if (Math.abs(rx) <= w / 2 && Math.abs(ry) <= h / 2) {
        const i = (y * W + x) * 4;
        img[i] = img[i + 1] = img[i + 2] = 255;
      }
    }
  }

  // quad = exact bar corners → crop should come back fully filled (straightened)
  const out = cropQuad(img, W, H, corners, 80, 20);
  let bright = 0;
  for (let i = 0; i < out.length; i += 4) if (out[i] > 128) bright++;
  const pct = bright / (80 * 20);
  assert.ok(pct > 0.9, `rectified crop filled fraction = ${pct.toFixed(3)} (expected > 0.9)`);
});

test("offsetPolygon path: detPostprocess expands an upright rect symmetric on all sides", () => {
  const mapW = 200, mapH = 200;
  const prob = renderRect(mapW, mapH, 100, 100, 80, 20, 0);
  const { boxes } = detPostprocess(prob, mapW, mapH, mapW, mapH, 1, 1, { minSize: 3 });
  const q = boxes[0].points;
  // 80x20 rect unclipped by dist=12.8 → 105.6 x 45.6, still axis-aligned
  assert.ok(Math.abs(topEdgeAngle(q)) < 1, `top edge angle = ${topEdgeAngle(q)}`);
  const topLen = edgeLen(q[0], q[1], q[2], q[3]);
  const sideLen = edgeLen(q[0], q[1], q[6], q[7]);
  assert.ok(topLen > 100 && topLen < 112, `top=${topLen}`);
  assert.ok(sideLen > 40 && sideLen < 50, `side=${sideLen}`);
});

// Diagonal watermarks / rotated stamps must NOT enter the text layer:
// default maxRotDeg=30 drops steep boxes, keeps mild skew.
test("detPostprocess drops steeply-rotated boxes (diagonal watermark), keeps mild skew", () => {
  const drops = [45, -45, 60];
  for (const ang of drops) {
    const { boxes } = detPostprocess(
      renderRect(200, 200, 100, 100, 80, 20, ang), 200, 200, 200, 200, 1, 1, { minSize: 3 },
    );
    assert.equal(boxes.length, 0, `angle ${ang}° should be dropped as watermark`);
  }
  const keeps = [0, 15, -15];
  for (const ang of keeps) {
    const { boxes } = detPostprocess(
      renderRect(200, 200, 100, 100, 80, 20, ang), 200, 200, 200, 200, 1, 1, { minSize: 3 },
    );
    assert.equal(boxes.length, 1, `angle ${ang}° body text should be kept`);
  }
  // threshold is configurable
  const { boxes: lively } = detPostprocess(
    renderRect(200, 200, 100, 100, 80, 20, 45), 200, 200, 200, 200, 1, 1, { maxRotDeg: 50 },
  );
  assert.equal(lively.length, 1, "45° kept when maxRotDeg raised to 50");
});

// Regression lock: NEGATIVE-slope text lines (right end higher) were fed to
// rec as a 90°-rotated crop (short edge on top) → all such lines got dropped
// as garbage. The top edge must be the LONG axis for both slope directions.
test("negative-slope text lines keep the long axis as the top edge (no 90° crop)", () => {
  for (const ang of [-1, -3, -5, -10]) {
    const { boxes } = detPostprocess(
      renderRect(300, 300, 150, 150, 300, 30, ang), 300, 300, 300, 300, 1, 1, { minSize: 3 },
    );
    assert.equal(boxes.length, 1, `angle ${ang}° line must be kept`);
    const q = boxes[0].points;
    const topLen = edgeLen(q[0], q[1], q[2], q[3]);
    const sideLen = edgeLen(q[0], q[1], q[6], q[7]);
    assert.ok(topLen > sideLen, `angle ${ang}°: top edge must be the LONG axis (top=${topLen.toFixed(0)}, side=${sideLen.toFixed(0)})`);
  }
});

// Regression lock: near-square boxes (single CJK char / symbol) have a
// meaningless "long axis" angle — the rotation filter must NOT drop them,
// even when the page has mild tilt.
test("near-square single-character boxes are not dropped by the rotation filter", () => {
  const { boxes } = detPostprocess(
    renderRect(200, 200, 100, 100, 40, 40, 5), 200, 200, 200, 200, 1, 1, { minSize: 3 },
  );
  assert.equal(boxes.length, 1, "near-square char at 5° must be kept (aspect-ratio guard)");
});

// cropMode 0 = 直立正文: faithful 1.7.2 — axis-aligned AABB boxes, no rotation filter.
test("cropMode 0 emits axis-aligned AABB boxes like 1.7.2", () => {
  const { boxes } = detPostprocess(
    renderRect(200, 200, 100, 100, 80, 20, 0), 200, 200, 200, 200, 1, 1, { minSize: 3, cropMode: 0 },
  );
  assert.equal(boxes.length, 1);
  const q = boxes[0].points;
  assert.ok(Math.abs(topEdgeAngle(q)) < 1, `angle=${topEdgeAngle(q)}`);
  assert.equal(q[0], q[6], "TL.x === BL.x (AABB)");
  assert.equal(q[2], q[4], "TR.x === BR.x (AABB)");
  // mode 0 has no rotation filter → near-square char at 5° is kept
  const sq = detPostprocess(
    renderRect(200, 200, 100, 100, 40, 40, 5), 200, 200, 200, 200, 1, 1, { minSize: 3, cropMode: 0 },
  );
  assert.equal(sq.boxes.length, 1, "near-square char kept in upright mode (no rotation filter)");
});
