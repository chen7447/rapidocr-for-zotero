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
import { frameClaimingLine, orderBoxes } from "./postprocess";
import { debugLog } from "../debug-log";

/** Marked-content tag wrapping our overlay so a later pass can drop it. */
export const OCR_MARK = "PdfOcrV3";

export type OverlayFont = {
  sizeAtHeight(h: number): number;
  heightAtSize(s: number, o?: { descender?: boolean }): number;
  widthOfTextAtSize(t: string, s: number): number;
};

export type FontRun = { latin: boolean; text: string };

/** Slice `text` to the horizontal overlap of `raw` with `rect` (uniform glyph pitch). */
export function clipTextToRect(
  text: string,
  raw: { x1: number; x2: number },
  rect: { x1: number; x2: number },
): string {
  const w = raw.x2 - raw.x1;
  if (w < 1 || !text) return "";
  const a = Math.max(0, Math.min(1, (Math.max(raw.x1, rect.x1) - raw.x1) / w));
  const b = Math.max(0, Math.min(1, (Math.min(raw.x2, rect.x2) - raw.x1) / w));
  if (b <= a) return "";
  const chars = [...text];
  return chars.slice(Math.round(a * chars.length), Math.round(b * chars.length)).join("").trim();
}

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
  twoColumn = false,
  regions?: Array<{ pageIndex: number; x1: number; y1: number; x2: number; y2: number }>,
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
  let foundBlocks = 0;
  let strippedPages = 0;
  for (const pi of replace) {
    const found = stripOcrOverlay(doc.getPages()[pi]);
    if (found > 0) strippedPages++;
    foundBlocks += found;
  }
  try {
    debugLog.log(`pdf-builder: prior layer found=${foundBlocks} blocks pages=${strippedPages}/${replace.size}`);
  } catch { /* diag only */ }

  for (const pageResult of ocr.pages) {
    const pi = pageResult.pageIndex;
    if (pi < 0 || pi >= n) continue;
    const page = doc.getPages()[pi];
    const { width: pw, height: ph } = page.getSize();
    const pixelToPoint = pageResult.pageWidth > 0
      ? (pageResult.pageWidthPoints || pw) / pageResult.pageWidth
      : 0.5;

    // 框=版面块:engine 已按块序排好(块内纯阅读顺序、框外残段在后),这里直接采用,
    // 不再按中心点二次归组(框边界处会归错组,正是前几版粘连的嫌疑)。
    // 分栏归组只在用户勾「双栏版面」时发生(见 orderBoxes);圈选模式不再猜栏。
    const hasRegions = (regions ?? []).some((r) => r.pageIndex === pageResult.pageIndex);
    const orderedBoxes = hasRegions
      ? pageResult.boxes
      : orderBoxes(pageResult.boxes, pageResult.pageWidth, twoColumn);
    // X2 框外物理裁剪:统一把点单位框换算成像素框,供转储与写层裁剪共用
    const pagePxRects = hasRegions
      ? (regions ?? []).filter((r) => r.pageIndex === pageResult.pageIndex)
          .map((r) => {
            const scX = pageResult.pageWidth / (pageResult.pageWidthPoints || pw);
            const scY = pageResult.pageHeight / (pageResult.pageHeightPoints || ph);
            // 标注 y 是页底原点(PDF 原生,见 ocr-engine b53 注):像素从页顶量 → 翻转
            const Hpt = pageResult.pageHeightPoints || ph || 1;
            return { x1: r.x1 * scX, y1: (Hpt - r.y2) * scY, x2: r.x2 * scX, y2: (Hpt - r.y1) * scY };
          })
      : [];
    try {
      const s = `PDF OCR v3: page ${pi + 1} build ${addonVersion} — ${hasRegions ? "region" : twoColumn ? "two-column" : "single-column"} order (boxes=${pageResult.boxes.length}, pageW=${Math.round(pageResult.pageWidth)})`;
      debugLog.log(s);
      Zotero.debug(s);
    } catch { /* diag only */ }
    // 写入序逐行转储:ground truth。F#=基本落在哪个框;跨界行 engine 已剔除。
    // 框内判定与 engine 共用 frameClaimingLine(被圈盖住≥半行才算,纵向容差=行高一半)。
    if (hasRegions) {
      try {
        let line = 0;
        for (const b of orderedBoxes) {
          const full = (b.text || "").trim();
          if (!full) continue;
          const fi = frameClaimingLine(b, pagePxRects);
          if (fi < 0) continue;
          const tag = `write#${String(line++).padStart(3, "0")} [F${fi}]`;
          debugLog.log(`${tag} ${JSON.stringify(full.slice(0, 46))}`);
        }
      } catch { /* diag only */ }
    }
    for (const box of orderedBoxes) {
      const text = box.text.trim();
      if (!text) continue;

      // b31 完整行白名单(出血容差):engine 已过滤;此处兜底拒绝跨界行。
      // 不做字符硬裁(半词垃圾根源),不做裁剪路径(pdf.js 无视 W)。
      if (hasRegions && frameClaimingLine(box, pagePxRects) < 0) continue;
      const layoutRaw = box.raw;

      const runs = splitFontRuns(text);
      const heightFont = runs.some((r) => !r.latin) ? cjkFont : latinFont;
      const fontSize = Math.max(heightFont.sizeAtHeight(Math.max((layoutRaw.y2 - layoutRaw.y1) * pixelToPoint, 1)), 1);
      const textWidth = runWidth(runs, latinFont, cjkFont, fontSize);
      const place = overlayPlacementForWidth(layoutRaw, pixelToPoint, ph, heightFont, textWidth);
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

/** Cut `/PdfOcrV3 BMC` … matching `EMC`, including nested `/Tx BMC`. Returns found count. */
export function stripOcrBlocks(text: string): { text: string; stripped: boolean; found: number } {
  OCR_BMC_RE.lastIndex = 0;
  if (!OCR_BMC_RE.test(text)) return { text, stripped: false, found: 0 };
  let out = "";
  let i = 0;
  let found = 0;
  OCR_BMC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OCR_BMC_RE.exec(text))) {
    if (m.index < i) continue;
    out += text.slice(i, m.index);
    i = skipMarkedContent(text, m.index);
    OCR_BMC_RE.lastIndex = i;
    found++;
  }
  out += text.slice(i);
  return { text: out, stripped: true, found };
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

/** Drop tagged overlay operators, including when they sit inside a merged stream. Returns found block count. */
export function stripOcrOverlay(page: PDFPage): number {
  const items = contentItems(page);
  if (!items.length) return 0;
  const ctx = page.node.context;
  const next = PDFArray.withContext(ctx);
  let changed = false;
  let totalFound = 0;
  for (const item of items) {
    const stream = item instanceof PDFRef ? ctx.lookup(item) : item;
    if (!(stream instanceof PDFStream)) {
      if (item instanceof PDFRef) next.push(item);
      continue;
    }
    const decoded = new TextDecoder("latin1").decode(decodeStreamBytes(stream));
    const { text, stripped, found } = stripOcrBlocks(decoded);
    if (!stripped) {
      next.push(item instanceof PDFRef ? item : (ctx.getObjectRef(stream) || ctx.register(stream)));
      continue;
    }
    changed = true;
    totalFound += found;
    if (!text.trim()) continue;
    next.push(ctx.register(ctx.stream(new TextEncoder().encode(text))));
  }
  if (!changed) return 0;
  page.node.set(PDFName.of("Contents"), next);
  return totalFound;
}
