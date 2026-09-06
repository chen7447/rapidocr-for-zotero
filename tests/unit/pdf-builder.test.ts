import assert from "node:assert/strict";
import test from "node:test";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts, decodePDFRawStream, rgb } from "pdf-lib";
import { addOcrLayerToPdf, clipTextToRect, overlayPlacement, restorePagesFromSource, splitFontRuns, stripAllOcrOverlays, stripOcrBlocks } from "../../src/ocr/pdf-builder";
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

test("clipTextToRect keeps only the overlapping slice", () => {
  assert.equal(clipTextToRect("ABCD", { x1: 0, x2: 100 }, { x1: 25, x2: 200 }), "BCD");
  assert.equal(clipTextToRect("ABCD", { x1: 10, x2: 90 }, { x1: 0, x2: 100 }), "ABCD");
  assert.equal(clipTextToRect("ABCD", { x1: 0, x2: 10 }, { x1: 50, x2: 80 }), "");
});

test("Helvetica encodes digits as WinAnsi, not Noto CID/PUA", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const hex = font.encodeText("0123456789").toString();
  assert.equal(hex, "<30313233343536373839>"); // ASCII '0'..'9'
});

test("b41: region mode is a line-level whitelist (行中心在圈内→整行写)", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]); // pt;渲染 2x → 400x200px
  const originalPdf = await doc.save();
  // 框(点,**PDF 原生坐标:页底原点,y 向上**,b53 实证 Zotero「选择区域」就这么存):
  // [50,0~150,50] → 翻转(页高100pt)成"从页顶量"50~100 → px [100,100~300,200]
  const regions = [{ pageIndex: 0, x1: 50, y1: 0, x2: 150, y2: 50 }];
  const ocr: OCRResult = {
    pages: [{
      pageIndex: 0,
      pageWidth: 400, pageHeight: 200,
      pageWidthPoints: 200, pageHeightPoints: 100,
      boxes: [
        // 行中心(140,130) 在框内 → 整行写入,即使左右端伸出框边(b30 的"整行拒写"已废弃)
        { points: [20, 120, 260, 120, 260, 140, 20, 140], raw: { x1: 20, y1: 120, x2: 260, y2: 140 }, score: 0.9, text: "Crossing line text" },
        // 中心(65,30) 在框外 → 不得写入
        { points: [40, 20, 90, 20, 90, 40, 40, 40], raw: { x1: 40, y1: 20, x2: 90, y2: 40 }, score: 0.9, text: "Outside row" },
        // 完整在框内:px[120,120~280,140] ⊂ 框 px[100,100~300,200]
        { points: [120, 120, 280, 120, 280, 140, 120, 140], raw: { x1: 120, y1: 120, x2: 280, y2: 140 }, score: 0.9, text: "Kept line" },
      ],
    }],
  };
  const output = await addOcrLayerToPdf(originalPdf, ocr, undefined, false, regions);
  const outDoc = await PDFDocument.load(output);
  const page = outDoc.getPages()[0];
  const contents = page.node.Contents();
  const ctx = page.node.context;
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((r) => ctx.lookup(r))
    : [contents];
  let stream = "";
  for (const s of streams) {
    if (!(s instanceof PDFStream)) continue;
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    stream += new TextDecoder("latin1").decode(bytes);
  }
  const blocks = stream.match(/\/PdfOcrV3 BMC/g) ?? [];
  assert.equal(blocks.length, 2, `expected 2 overlay blocks (kept + crossing), got ${blocks.length}`);
  // b41:中心在圈内的行整行写入;中心在圈外的行整行不写;无裁剪路径算子;无字符裁
  const hexOf = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();
  const streamUp = stream.toUpperCase();
  assert.ok(streamUp.includes(hexOf("Kept line")), `kept line missing: ${stream.slice(0, 400)}`);
  assert.ok(streamUp.includes(hexOf("Crossing")), `line centred in the frame must be written whole: ${stream.slice(0, 400)}`);
  assert.ok(!streamUp.includes(hexOf("Outside")), "outside-row text must not be written");
  assert.ok(!/\bW\s+n\b/.test(stream), "clip-path approach must be gone (pdf.js ignores it)");
});
