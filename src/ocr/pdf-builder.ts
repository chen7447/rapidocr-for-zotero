/**
 * PDF rebuild — takes the original PDF bytes and OCR results, produces a
 * new PDF with invisible text layers overlaid on each page using pdf-lib.
 *
 * Latin/digits use Helvetica (WinAnsi → copyable ASCII). CJK uses the
 * bundled Noto Sans SC. Mixing both in one box avoids Noto's CID/PUA
 * digits (U+F6Bx) when the user copies a DOI or citation.
 */
import { PDFDocument, PDFFont, StandardFonts, pushGraphicsState, popGraphicsState, translate, scale } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { OCRResult } from "./types";
import { readingOrder } from "./postprocess";

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

  const pageCount = Math.min(ocr.pages.length, doc.getPageCount());

  for (let pi = 0; pi < pageCount; pi++) {
    const pageResult = ocr.pages[pi];
    const page = doc.getPages()[pi];
    const { width: pw, height: ph } = page.getSize();
    const pixelToPoint = pageResult.pageWidth > 0
      ? (pageResult.pageWidthPoints || pw) / pageResult.pageWidth
      : 0.5;

    for (const box of readingOrder(pageResult.boxes)) {
      const text = box.text.trim();
      if (!text) continue;

      const runs = splitFontRuns(text);
      const heightFont = runs.some((r) => !r.latin) ? cjkFont : latinFont;
      const fontSize = Math.max(heightFont.sizeAtHeight(Math.max((box.raw.y2 - box.raw.y1) * pixelToPoint, 1)), 1);
      const textWidth = runWidth(runs, latinFont, cjkFont, fontSize);
      const place = overlayPlacementForWidth(box.raw, pixelToPoint, ph, heightFont, textWidth);
      if (!place) continue;

      page.pushOperators(pushGraphicsState(), translate(place.x, place.y), scale(place.sx, 1));
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
      page.pushOperators(popGraphicsState());
    }
  }

  return await doc.save();
}
