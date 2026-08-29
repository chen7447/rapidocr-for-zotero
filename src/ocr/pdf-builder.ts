/**
 * PDF rebuild — takes the original PDF bytes and OCR results, produces a
 * new PDF with invisible text layers overlaid on each page using pdf-lib.
 *
 * Latin/digits use Helvetica (WinAnsi → copyable ASCII). CJK uses the
 * bundled Noto Sans SC. Mixing both in one box avoids Noto's CID/PUA
 * digits (U+F6Bx) when the user copies a DOI or citation.
 */
import {
  PDFArray,
  PDFContentStream,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  beginMarkedContent,
  decodePDFRawStream,
  endMarkedContent,
  popGraphicsState,
  pushGraphicsState,
  scale,
  translate,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { OCRResult } from "./types";
import { orderBoxes } from "./postprocess";

/** Marked-content tag wrapping our overlay so a later pass can drop it. */
export const OCR_MARK = "PdfOcrV3";

export type OverlayFont = {
  sizeAtHeight(h: number): number;
  heightAtSize(s: number, o?: { descender?: boolean }): number;
  widthOfTextAtSize(t: string, s: number): number;
};

export type FontRun = { latin: boolean; text: string };

/** ASCII → Helvetica; everything else → CJK. */
export function splitFontRuns(text: string): FontRun[] {
  const runs: FontRun[] = [];
  for (const ch of text) {
    const latin = ch.charCodeAt(0) < 0x80;
    const last = runs[runs.length - 1];
    if (last && last.latin === latin) last.text += ch;
    else runs.push({ latin, text: ch });
  }
  return runs;
}

function runWidth(runs: FontRun[], latinFont: OverlayFont, cjkFont: OverlayFont, fontSize: number): number {
  let w = 0;
  for (const run of runs) {
    w += (run.latin ? latinFont : cjkFont).widthOfTextAtSize(run.text, fontSize);
  }
  return w;
}

/** Place one OCR box so the invisible glyphs fill `raw` in PDF points. */
export function overlayPlacement(
  raw: { x1: number; y1: number; x2: number; y2: number },
  pixelToPoint: number,
  pageHeight: number,
  font: OverlayFont,
  text: string,
): { x: number; y: number; fontSize: number; sx: number } | null {
  return overlayPlacementForWidth(
    raw,
    pixelToPoint,
    pageHeight,
    font,
    font.widthOfTextAtSize(text, Math.max(font.sizeAtHeight((raw.y2 - raw.y1) * pixelToPoint), 1)),
  );
}

function overlayPlacementForWidth(
  raw: { x1: number; y1: number; x2: number; y2: number },
  pixelToPoint: number,
  pageHeight: number,
  heightFont: OverlayFont,
  textWidth: number,
): { x: number; y: number; fontSize: number; sx: number } | null {
  const boxWidth = (raw.x2 - raw.x1) * pixelToPoint;
  const boxHeight = (raw.y2 - raw.y1) * pixelToPoint;
  if (boxWidth < 1 || boxHeight < 1) return null;
  const fontSize = Math.max(heightFont.sizeAtHeight(boxHeight), 1);
  const descender =
    heightFont.heightAtSize(fontSize, { descender: true }) -
    heightFont.heightAtSize(fontSize, { descender: false });
  return {
    x: raw.x1 * pixelToPoint,
    y: pageHeight - raw.y2 * pixelToPoint + descender,
    fontSize,
    sx: textWidth > 0 ? boxWidth / textWidth : 1,
  };
}

/**
 * Copy the original PDF and draw an invisible OCR text layer on each page.
 * Text is drawn with opacity 0 → visually invisible but selectable and
 * searchable.
 *
 * @param originalPdf  Bytes of the source PDF.
 * @param ocr          OCR results (page boxes in pixel coords).
 * @param fontBytes    Optional pre-loaded CJK font bytes (default: fetch from
 *                     addonRoot + "content/fonts/NotoSansCJKsc-Regular.otf").
 */
export async function addOcrLayerToPdf(
  originalPdf: Uint8Array,
  ocr: OCRResult,
  fontBytes?: Uint8Array,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalPdf);
  doc.registerFontkit(fontkit);

  const latinFont = await doc.embedFont(StandardFonts.Helvetica);
  let cjkFont: PDFFont = latinFont;
  try {
    if (!fontBytes) {
      const resp = await fetch(addonRoot + "content/fonts/NotoSansCJKsc-Regular.otf");
      fontBytes = new Uint8Array(await resp.arrayBuffer());
    }
    cjkFont = await doc.embedFont(fontBytes);
  } catch (err) {
    console?.warn?.("CJK font embed failed, falling back to Helvetica:", String(err));
  }

  const n = doc.getPageCount();
  const replace = new Set(ocr.pages.map((p) => p.pageIndex).filter((i) => i >= 0 && i < n));
  for (const pi of replace) stripOcrOverlay(doc.getPages()[pi]);

  for (const pageResult of ocr.pages) {
    const pi = pageResult.pageIndex;
    if (pi < 0 || pi >= n) continue;
    const page = doc.getPages()[pi];
    const { width: pw, height: ph } = page.getSize();
    const pixelToPoint = pageResult.pageWidth > 0
      ? (pageResult.pageWidthPoints || pw) / pageResult.pageWidth
      : 0.5;

    for (const box of orderBoxes(pageResult.boxes, pageResult.pageWidth)) {
      const text = box.text.trim();
      if (!text) continue;

      const runs = splitFontRuns(text);
      const heightFont = runs.some((r) => !r.latin) ? cjkFont : latinFont;
      const fontSize = Math.max(heightFont.sizeAtHeight(Math.max((box.raw.y2 - box.raw.y1) * pixelToPoint, 1)), 1);
      const textWidth = runWidth(runs, latinFont, cjkFont, fontSize);
      const place = overlayPlacementForWidth(box.raw, pixelToPoint, ph, heightFont, textWidth);
      if (!place) continue;

      page.pushOperators(
        beginMarkedContent(OCR_MARK),
        pushGraphicsState(),
        translate(place.x, place.y),
        scale(place.sx, 1),
      );
      let dx = 0;
      for (const run of runs) {
        const font = run.latin ? latinFont : cjkFont;
        try {
          page.drawText(run.text, { x: dx, y: 0, size: place.fontSize, font, opacity: 0 });
        } catch {
          // unencodable in the fallback font — skip the run
        }
        dx += font.widthOfTextAtSize(run.text, place.fontSize);
      }
      page.pushOperators(popGraphicsState(), endMarkedContent());
    }
  }

  return await doc.save();
}

function decodeStreamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFContentStream) return new TextEncoder().encode(stream.getContentsString());
  return stream.getContents();
}

const OCR_BMC_RE = /\/PdfOcrV3\s+BMC\b/g;
const MARKED_OP = /\/[^\s]+?\s+BMC\b|\bBDC\b|\bEMC\b/g;

/** Cut `/PdfOcrV3 BMC` … matching `EMC`, including nested `/Tx BMC`. */
export function stripOcrBlocks(text: string): { text: string; stripped: boolean } {
  OCR_BMC_RE.lastIndex = 0;
  if (!OCR_BMC_RE.test(text)) return { text, stripped: false };
  let out = "";
  let i = 0;
  OCR_BMC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OCR_BMC_RE.exec(text))) {
    if (m.index < i) continue;
    out += text.slice(i, m.index);
    i = skipMarkedContent(text, m.index);
    OCR_BMC_RE.lastIndex = i;
  }
  out += text.slice(i);
  return { text: out, stripped: true };
}

function skipMarkedContent(text: string, startAt: number): number {
  MARKED_OP.lastIndex = startAt;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKED_OP.exec(text))) {
    if (m[0] === "EMC") {
      depth--;
      if (depth === 0) return m.index + 3;
    } else {
      depth++;
    }
  }
  return text.length;
}

function contentItems(page: PDFPage): Array<PDFRef | PDFStream> {
  const raw = page.node.get(PDFName.of("Contents"));
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) {
    return contents.asArray().filter((o): o is PDFRef | PDFStream => o instanceof PDFRef || o instanceof PDFStream);
  }
  if (raw instanceof PDFRef) return [raw];
  if (contents instanceof PDFStream) return [contents];
  return [];
}

/** Drop our tagged overlay. `pageIndexes` omitted = every page. */
export async function stripAllOcrOverlays(
  pdf: Uint8Array,
  pageIndexes?: number[],
): Promise<{ bytes: Uint8Array; pagesStripped: number }> {
  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();
  const targets = pageIndexes
    ? [...new Set(pageIndexes)].filter((i) => i >= 0 && i < pages.length)
    : pages.map((_, i) => i);
  let pagesStripped = 0;
  for (const i of targets) {
    if (stripOcrOverlay(pages[i])) pagesStripped++;
  }
  return { bytes: await doc.save(), pagesStripped };
}

/** Replace those pages in `ocrPdf` with the same pages from `sourcePdf`. */
export async function restorePagesFromSource(
  ocrPdf: Uint8Array,
  sourcePdf: Uint8Array,
  pageIndexes: number[],
): Promise<{ bytes: Uint8Array; pagesRestored: number }> {
  const dest = await PDFDocument.load(ocrPdf);
  const src = await PDFDocument.load(sourcePdf);
  const n = Math.min(dest.getPageCount(), src.getPageCount());
  const targets = [...new Set(pageIndexes)].filter((i) => i >= 0 && i < n).sort((a, b) => b - a);
  for (const i of targets) {
    const [copied] = await dest.copyPages(src, [i]);
    dest.removePage(i);
    dest.insertPage(i, copied);
  }
  return { bytes: await dest.save(), pagesRestored: targets.length };
}

/** Drop tagged overlay operators, including when they sit inside a merged stream. */
export function stripOcrOverlay(page: PDFPage): boolean {
  const items = contentItems(page);
  if (!items.length) return false;
  const ctx = page.node.context;
  const next = PDFArray.withContext(ctx);
  let changed = false;
  for (const item of items) {
    const stream = item instanceof PDFRef ? ctx.lookup(item) : item;
    if (!(stream instanceof PDFStream)) {
      if (item instanceof PDFRef) next.push(item);
      continue;
    }
    const decoded = new TextDecoder("latin1").decode(decodeStreamBytes(stream));
    const { text, stripped } = stripOcrBlocks(decoded);
    if (!stripped) {
      next.push(item instanceof PDFRef ? item : (ctx.getObjectRef(stream) || ctx.register(stream)));
      continue;
    }
    changed = true;
    if (!text.trim()) continue;
    next.push(ctx.register(ctx.stream(new TextEncoder().encode(text))));
  }
  if (!changed) return false;
  page.node.set(PDFName.of("Contents"), next);
  return true;
}
