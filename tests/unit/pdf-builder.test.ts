import assert from "node:assert/strict";
import test from "node:test";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts, decodePDFRawStream, rgb } from "pdf-lib";
import { addOcrLayerToPdf, overlayPlacement, restorePagesFromSource, splitFontRuns, stripAllOcrOverlays, stripOcrBlocks } from "../../src/ocr/pdf-builder";
import type { OCRPageResult, OCRResult } from "../../src/ocr/types";

test("addOcrLayerToPdf scales boxes from pageWidthPoints, not a hardcoded DPI", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText("Hello", { x: 50, y: 100, size: 20, font, color: rgb(0, 0, 0) });
  const originalPdf = await doc.save();

  const ocr: OCRResult = {
    pages: [{
      pageIndex: 0,
      pageWidth: 1200,       // 3× render, not 144 DPI
      pageHeight: 600,
      pageWidthPoints: 400,
      pageHeightPoints: 200,
      boxes: [{
        points: [150, 240, 450, 240, 450, 315, 150, 315],
        raw: { x1: 150, y1: 240, x2: 450, y2: 315 },
        score: 0.9,
        text: "Hello",
      }],
    }],
  };

  const output = await addOcrLayerToPdf(originalPdf, ocr);
  const outDoc = await PDFDocument.load(output);
  assert.equal(outDoc.getPageCount(), 1);
  assert.ok(output.length > originalPdf.length);

  // 75px box × (400/1200) = 25pt. Must fill that height, not the old 12pt cap.
  const overlayFont = await outDoc.embedFont(StandardFonts.Helvetica);
  const place = overlayPlacement(
    { x1: 150, y1: 240, x2: 450, y2: 315 },
    400 / 1200,
    200,
    overlayFont,
    "Hello",
  );
  assert.ok(place);
  assert.ok(place.fontSize > 20, `expected ~25pt overlay, got ${place.fontSize}`);
  assert.equal(place.x, 50);
  const drawnWidth = overlayFont.widthOfTextAtSize("Hello", place.fontSize) * place.sx;
  assert.ok(Math.abs(drawnWidth - 100) < 0.5, `expected 100pt wide, got ${drawnWidth}`);
});

test("splitFontRuns sends ASCII (digits, DOI) to latin and CJK elsewhere", () => {
  assert.deepEqual(splitFontRuns("9(1):101-123 https://doi.org/10.1007"), [
    { latin: true, text: "9(1):101-123 https://doi.org/10.1007" },
  ]);
  assert.deepEqual(splitFontRuns("见表1-3"), [
    { latin: false, text: "见表" },
    { latin: true, text: "1-3" },
  ]);
});

function pageHasOcrMark(doc: Awaited<ReturnType<typeof PDFDocument.load>>, pageIndex: number): boolean {
  const contents = doc.getPages()[pageIndex].node.Contents();
  if (!contents) return false;
  const ctx = doc.getPages()[pageIndex].node.context;
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => ctx.lookup(ref))
    : [contents];
  return streams.some((stream) => {
    if (!(stream instanceof PDFStream)) return false;
    const bytes = stream instanceof PDFRawStream
      ? decodePDFRawStream(stream).decode()
      : stream.getContents();
    return /\/PdfOcrV3\s+BMC\b/.test(new TextDecoder("latin1").decode(bytes));
  });
}

function pageResult(pageIndex: number, text: string): OCRPageResult {
  return {
    pageIndex,
    pageWidth: 400,
    pageHeight: 200,
    pageWidthPoints: 200,
    pageHeightPoints: 100,
    boxes: [{
      points: [10, 10, 80, 10, 80, 40, 10, 40],
      raw: { x1: 10, y1: 10, x2: 80, y2: 40 },
      score: 0.9,
      text,
    }],
  };
}

test("addOcrLayerToPdf overlays by pageIndex, not array position", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const output = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(1, "PageTwo")] });
  const outDoc = await PDFDocument.load(output);
  assert.equal(pageHasOcrMark(outDoc, 0), false);
  assert.equal(pageHasOcrMark(outDoc, 1), true);
});

test("re-OCR strips previous overlay on that page only", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const first = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(0, "One"), pageResult(1, "Two")] });
  const second = await addOcrLayerToPdf(first, { pages: [pageResult(1, "TwoB")] });
  const outDoc = await PDFDocument.load(second);
  assert.equal(pageHasOcrMark(outDoc, 0), true);
  assert.equal(pageHasOcrMark(outDoc, 1), true);
  const ctx = outDoc.getPages()[1].node.context;
  const contents = outDoc.getPages()[1].node.Contents();
  assert.ok(contents instanceof PDFArray);
  const marked = contents.asArray().filter((ref) => {
    const stream = ctx.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return false;
    return /\/PdfOcrV3\s+BMC\b/.test(new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()));
  });
  assert.equal(marked.length, 1);
});

test("stripAllOcrOverlays removes tagged layers and leaves a source PDF unchanged", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const none = await stripAllOcrOverlays(originalPdf);
  assert.equal(none.pagesStripped, 0);

  const ocred = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(0, "One"), pageResult(1, "Two")] });
  const stripped = await stripAllOcrOverlays(ocred);
  assert.equal(stripped.pagesStripped, 2);
  const outDoc = await PDFDocument.load(stripped.bytes);
  assert.equal(pageHasOcrMark(outDoc, 0), false);
  assert.equal(pageHasOcrMark(outDoc, 1), false);
});

test("stripOcrBlocks cuts nested /Tx BMC inside /PdfOcrV3 BMC", () => {
  const text = "q /Img Do Q /PdfOcrV3 BMC q /Tx BMC BT (Hi) Tj ET EMC Q EMC";
  const { text: out, stripped } = stripOcrBlocks(text);
  assert.equal(stripped, true);
  assert.equal(out.includes("PdfOcrV3"), false);
  assert.equal(out.includes("/Img Do"), true);
});

test("stripAllOcrOverlays works after save/reload when Contents is a single stream", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const ocred = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(0, "One")] });
  const reloaded = await PDFDocument.load(ocred);
  const page = reloaded.getPages()[0];
  const ctx = page.node.context;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => ctx.lookup(ref))
    : [contents];
  const chunks: Uint8Array[] = [];
  for (const stream of streams) {
    if (!(stream instanceof PDFStream)) continue;
    chunks.push(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
    merged[off++] = 10;
  }
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(merged)));
  const forced = await reloaded.save();
  const stripped = await stripAllOcrOverlays(forced, [0]);
  assert.equal(stripped.pagesStripped, 1);
  const outDoc = await PDFDocument.load(stripped.bytes);
  assert.equal(pageHasOcrMark(outDoc, 0), false);
});

test("restorePagesFromSource copies source pages over OCR pages", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const ocred = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(0, "One"), pageResult(1, "Two")] });
  const restored = await restorePagesFromSource(ocred, originalPdf, [1]);
  assert.equal(restored.pagesRestored, 1);
  const outDoc = await PDFDocument.load(restored.bytes);
  assert.equal(pageHasOcrMark(outDoc, 0), true);
  assert.equal(pageHasOcrMark(outDoc, 1), false);
});

test("stripAllOcrOverlays with pageIndexes only drops those pages", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  const originalPdf = await doc.save();
  const ocred = await addOcrLayerToPdf(originalPdf, { pages: [pageResult(0, "One"), pageResult(1, "Two")] });
  const stripped = await stripAllOcrOverlays(ocred, [1]);
  assert.equal(stripped.pagesStripped, 1);
  const outDoc = await PDFDocument.load(stripped.bytes);
  assert.equal(pageHasOcrMark(outDoc, 0), true);
  assert.equal(pageHasOcrMark(outDoc, 1), false);
});

test("Helvetica encodes digits as WinAnsi, not Noto CID/PUA", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const hex = font.encodeText("0123456789").toString();
  assert.equal(hex, "<30313233343536373839>"); // ASCII '0'..'9'
});
