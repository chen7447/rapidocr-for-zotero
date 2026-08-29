import assert from "node:assert/strict";
import test from "node:test";

import { detPreprocess, recPreprocess } from "../../src/ocr/preprocess";

// ─── reference implementation (verbatim copy of the pre-fusion algorithm) ──
//
// This file is the bit-exact SPEC for src/ocr/preprocess.ts. The functions
// below are a verbatim copy of the original three-pass implementation
// (resizeBilinear → normalize → HWC→CHW transpose). If preprocess.ts is ever
// refactored (e.g. fused into a single pass), these tests guarantee the
// output tensors are bit-for-bit identical: same operations, same order,
// including the intermediate Float32 store of the interpolated value.

function refResizeBilinear(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const out = new Float32Array(dstW * dstH * 3);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const srcY = dy * yRatio;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const yFrac = srcY - y0;

    for (let dx = 0; dx < dstW; dx++) {
      const srcX = dx * xRatio;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const xFrac = srcX - x0;

      const dstIdx = (dy * dstW + dx) * 3;

      for (let c = 0; c < 3; c++) {
        const p00 = src[(y0 * srcW + x0) * 4 + c];
        const p10 = src[(y0 * srcW + x1) * 4 + c];
        const p01 = src[(y1 * srcW + x0) * 4 + c];
        const p11 = src[(y1 * srcW + x1) * 4 + c];

        const top = p00 + (p10 - p00) * xFrac;
        const bot = p01 + (p11 - p01) * xFrac;
        out[dstIdx + c] = top + (bot - top) * yFrac;
      }
    }
  }
  return out;
}

function refDetPreprocess(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  limitSideLen = 1536,
): { tensor: Float32Array; scaleX: number; scaleY: number; resizedWidth: number; resizedHeight: number } {
  const maxSide = Math.max(width, height);
  const ratio = maxSide > limitSideLen ? limitSideLen / maxSide : 1.0;

  let resizeW = Math.round((width * ratio) / 32) * 32;
  let resizeH = Math.round((height * ratio) / 32) * 32;

  if (resizeW < 1) resizeW = 1;
  if (resizeH < 1) resizeH = 1;

  const rgb = refResizeBilinear(pixels, width, height, resizeW, resizeH);

  const len = resizeW * resizeH * 3;
  const norm = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    norm[i] = (rgb[i] / 255 - 0.5) / 0.5;
  }

  const chw = new Float32Array(3 * resizeH * resizeW);
  for (let y = 0; y < resizeH; y++) {
    for (let x = 0; x < resizeW; x++) {
      const hwcIdx = (y * resizeW + x) * 3;
      for (let c = 0; c < 3; c++) {
        chw[c * resizeH * resizeW + y * resizeW + x] = norm[hwcIdx + c];
      }
    }
  }

  return {
    tensor: chw,
    scaleX: resizeW / width,
    scaleY: resizeH / height,
    resizedWidth: resizeW,
    resizedHeight: resizeH,
  };
}

function refRecPreprocess(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  imgH = 48,
): { tensor: Float32Array; width: number; height: number } {
  const ratio = width / height;
  let resizedW = Math.ceil(imgH * ratio);
  if (resizedW < 4) resizedW = 4;

  const rgb = refResizeBilinear(pixels, width, height, resizedW, imgH);

  const area = imgH * resizedW;
  const chw = new Float32Array(3 * area);

  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < resizedW; x++) {
      const hwcIdx = (y * resizedW + x) * 3;
      const r = (rgb[hwcIdx] / 255 - 0.5) / 0.5;
      const g = (rgb[hwcIdx + 1] / 255 - 0.5) / 0.5;
      const b = (rgb[hwcIdx + 2] / 255 - 0.5) / 0.5;
      // BGR order: channel 0 = B, channel 1 = G, channel 2 = R
      chw[0 * area + y * resizedW + x] = b;
      chw[1 * area + y * resizedW + x] = g;
      chw[2 * area + y * resizedW + x] = r;
    }
  }

  return { tensor: chw, width: resizedW, height: imgH };
}

// ─── deterministic input ────────────────────────────────────────────────

/** Gradient RGBA buffer, a pure function of the pixel index (no randomness). */
function gradientRGBA(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = (i * 7) % 256;
    px[i * 4 + 1] = (i * 13) % 256;
    px[i * 4 + 2] = (i * 29) % 256;
    px[i * 4 + 3] = 255;
  }
  return px;
}

function assertBitExact(a: Float32Array, b: Float32Array, label: string): void {
  assert.equal(a.length, b.length, `${label}: length mismatch`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}: first bit-level mismatch at [${i}]: ${a[i]} !== ${b[i]}`);
    }
  }
}

// ─── tests ──────────────────────────────────────────────────────────────

test("detPreprocess is bit-exact vs reference on the downscale path (100×60, limit 64)", () => {
  const px = gradientRGBA(100, 60);
  const got = detPreprocess(px, 100, 60, 64);
  const ref = refDetPreprocess(px, 100, 60, 64);

  assert.equal(got.resizedWidth, ref.resizedWidth);
  assert.equal(got.resizedHeight, ref.resizedHeight);
  assert.equal(got.scaleX, ref.scaleX);
  assert.equal(got.scaleY, ref.scaleY);
  assertBitExact(got.tensor, ref.tensor, "det downscale");
});

test("detPreprocess is bit-exact vs reference on the ratio=1 path (64×48, limit 1536)", () => {
  const px = gradientRGBA(64, 48);
  const got = detPreprocess(px, 64, 48, 1536);
  const ref = refDetPreprocess(px, 64, 48, 1536);

  assert.equal(got.resizedWidth, ref.resizedWidth);
  assert.equal(got.resizedHeight, ref.resizedHeight);
  assertBitExact(got.tensor, ref.tensor, "det ratio=1");
});

test("recPreprocess is bit-exact vs reference for a wide crop (37×11, BGR + dynamic width)", () => {
  const px = gradientRGBA(37, 11);
  const got = recPreprocess(px, 37, 11);
  const ref = refRecPreprocess(px, 37, 11);

  assert.equal(got.width, ref.width);
  assert.equal(got.height, ref.height);
  assertBitExact(got.tensor, ref.tensor, "rec wide");
});

test("recPreprocess is bit-exact vs reference for a tall crop (9×20)", () => {
  const px = gradientRGBA(9, 20);
  const got = recPreprocess(px, 9, 20);
  const ref = refRecPreprocess(px, 9, 20);

  assert.equal(got.width, ref.width);
  assertBitExact(got.tensor, ref.tensor, "rec tall");
});

test("recPreprocess clamps the dynamic width to the 4px minimum", () => {
  // ratio = 1/60 → ceil(48/60) = 1 → clamped to 4
  const px = gradientRGBA(1, 60);
  const got = recPreprocess(px, 1, 60);
  assert.equal(got.width, 4);
  const ref = refRecPreprocess(px, 1, 60);
  assertBitExact(got.tensor, ref.tensor, "rec min-width clamp");
});
