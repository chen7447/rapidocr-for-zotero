// src/ocr/preprocess.ts
// Image preprocessing for PP-OCRv4 models (RapidOCR).
// Pure-JS implementation — no OpenCV, no canvas, no numpy.

// ─── bilinear resize ─────────────────────────────────────────────────

/**
 * Resize an RGBA pixel buffer to the target dimensions using bilinear
 * interpolation.  Returns a **Float32Array** of length dstW × dstH × 3
 * (RGB channels only, no alpha).
 */
function resizeBilinear(
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

      // 4 source pixels around the target point
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

// ─── round to multiple of 32 ─────────────────────────────────────────

function roundTo32(v: number): number {
  return Math.round(v / 32) * 32;
}

// ─── det preprocess ──────────────────────────────────────────────────

export interface DetPreprocessResult {
  /** The model input tensor as a flat Float32Array in CHW order with
   *  batch dimension: [1, 3, H, W].  H and W are the resized dimensions. */
  tensor: Float32Array;
  /** X-axis resize factor (resized / original). 独立于 scaleY — roundTo32
   *  会让宽高的缩放比例不同，单一 scale 反向缩放会造成坐标错位。 */
  scaleX: number;
  /** Y-axis resize factor (resized / original). */
  scaleY: number;
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
}

/**
 * PP-OCRv4 det preprocess.
 *
 * @param pixels  RGBA pixel data from a canvas (width × height × 4 bytes).
 * @param width   Original image width.
 * @param height  Original image height.
 * @param limitSideLen  Long-side limit (default 1536). 若长边超过此值则等比缩小
 *                      到长边 = limitSideLen（PaddleOCR DetResizeForTest 语义）。
 * @returns       A Float32Array tensor ready for the det model, plus
 *                metadata needed to rescale output boxes back to original
 *                coordinates.
 */
export function detPreprocess(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  limitSideLen = 1536,
): DetPreprocessResult {
  // 1. Compute resize ratio: preserve aspect, long side ≤ limitSideLen.
  //    PaddleOCR DetResizeForTest only shrinks, never enlarges.
  const maxSide = Math.max(width, height);
  const ratio = maxSide > limitSideLen ? limitSideLen / maxSide : 1.0;

  let resizeW = roundTo32(width * ratio);
  let resizeH = roundTo32(height * ratio);

  // Ensure at least 1 pixel
  if (resizeW < 1) resizeW = 1;
  if (resizeH < 1) resizeH = 1;

  // 2. Resize
  const rgb = resizeBilinear(pixels, width, height, resizeW, resizeH);

  // 3. Normalize: (val / 255 - 0.5) / 0.5  → range [-1, 1]
  const len = resizeW * resizeH * 3;
  const norm = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    norm[i] = (rgb[i] / 255 - 0.5) / 0.5;
  }

  // 4. HWC → CHW + batch dim [1, 3, H, W]
  //    Input norm is HWC flat (H*W*3).
  //    Output tensor is CHW flat (3*H*W) with batch dim.
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
    tensor: chw, // [1, 3, H, W] — caller adds batch dim if needed
    scaleX: resizeW / width,
    scaleY: resizeH / height,
    originalWidth: width,
    originalHeight: height,
    resizedWidth: resizeW,
    resizedHeight: resizeH,
  };
}

// ─── rec preprocess (for a single text box crop) ─────────────────────

export interface RecPreprocessResult {
  tensor: Float32Array; // [1, 3, imgH, dynamicWidth]
  scale: number;
  width: number;
  height: number;
}

/**
 * PP-OCRv4 rec preprocess for a single text-box crop.
 * Resizes to h=48, w proportional to preserve aspect ratio (dynamic width,
 * matching Python's flexible max_wh_ratio logic). Normalizes, pads.
 * Input is RGBA pixels; internal processing uses BGR order (matching
 * PP-OCR's OpenCV-based training pipeline).
 *
 * @param pixels  RGBA crop of the text region.
 * @param width   Crop width.
 * @param height  Crop height.
 * @param imgH    Target height (default 48 for PP-OCRv4).
 * @param imgW    Unused — kept for compatibility; actual width is dynamic.
 * @returns       Tensor [1, 3, imgH, resizedW] ready for the rec model.
 */
export function recPreprocess(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  imgH = 48,
  _imgW = 320,
): RecPreprocessResult {
  // Dynamic width: preserve aspect ratio (matching Python's max_wh_ratio logic)
  const ratio = width / height;
  let resizedW = Math.ceil(imgH * ratio);
  // Ensure minimum width
  if (resizedW < 4) resizedW = 4;

  // Resize to (resizedW, imgH) — uses bilinear, returns Float32Array RGB
  const rgb = resizeBilinear(pixels, width, height, resizedW, imgH);

  // Normalize: (val / 255 - 0.5) / 0.5  → range [-1, 1]
  // Then convert RGB → BGR by swapping channels 0 ↔ 2 (PP-OCR models
  // were trained on BGR images from OpenCV).
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

  return { tensor: chw, scale: resizedW / width, width: resizedW, height: imgH };
}

// ─── crop RGBA region from image ────────────────────────────────────

/**
 * Extract a rectangular region from an RGBA pixel buffer.
 * @returns A new Uint8ClampedArray containing the cropped RGBA pixels.
 */
export function cropRGBA(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const sx = Math.min(Math.max(x + col, 0), srcW - 1);
      const sy = Math.min(Math.max(y + row, 0), srcH - 1);
      const si = (sy * srcW + sx) * 4;
      const di = (row * w + col) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}