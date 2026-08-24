/**
 * Shared types for the OCR pipeline.
 * Phase 4 (pdf.js rendering) fills in PageRenderer; the engine consumes
 * RGBA page images and produces per-page text boxes.
 */

/** A single detected text region with its recognized content. */
export interface OCRBox {
  /** 4 corner points [x1,y1, x2,y1, x2,y2, x1,y2] in page pixel coords. */
  points: number[];
  /**
   * Raw (pre-unclip) bounding box in page pixel coords — the true text
   * region. Used to place the invisible text layer aligned with the
   * original glyphs (the unclipped `points` are fine for cropping the
   * recognizer but too padded for exact overlay placement).
   */
  raw: { x1: number; y1: number; x2: number; y2: number };
  /** Average confidence of the det region (0..1). */
  score: number;
  /** Recognized text (CTC-decoded). */
  text: string;
}

/** Result of OCR for one page. */
export interface OCRPageResult {
  pageIndex: number;
  /** Page dimensions in pixels (at the render scale used). */
  pageWidth: number;
  pageHeight: number;
  /** Physical page size in points (1/72 inch) — needed by pdf-lib. */
  pageWidthPoints: number;
  pageHeightPoints: number;
  boxes: OCRBox[];
}

/** Final OCR result of a whole PDF. */
export interface OCRResult {
  pages: OCRPageResult[];
}

/**
 * Page renderer abstraction. Phase 4 implements this with pdf.js —
 * `renderPage(index)` returns RGBA pixels + page geometry. The OCR engine
 * only depends on this interface, so Phase 4 can plug in later without
 * touching the engine.
 */
export interface PageRenderer {
  pageCount: number;
  /** Render page `index` (0-based) to RGBA pixels at a reasonable DPI. */
  renderPage(index: number): Promise<PageImage>;
  /** Release all resources held by the renderer. */
  dispose(): void;
}

export interface PageImage {
  /** RGBA pixel data, length = width * height * 4. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Physical page size in points (1/72 inch). */
  widthPoints: number;
  heightPoints: number;
}