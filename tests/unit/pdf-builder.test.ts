import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { addOcrLayerToPdf, overlayPlacement, splitFontRuns } from "../../src/ocr/pdf-builder";
import type { OCRResult } from "../../src/ocr/types";

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

test("Helvetica encodes digits as WinAnsi, not Noto CID/PUA", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const hex = font.encodeText("0123456789").toString();
  assert.equal(hex, "<30313233343536373839>"); // ASCII '0'..'9'
});
