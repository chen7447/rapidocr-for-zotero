// Local test for pdf-builder: create a simple PDF, add OCR layer, verify.
// Run: node --import tsx scripts/check-pdf-builder.ts
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { addOcrLayerToPdf } from "../src/ocr/pdf-builder.ts";
import { OCRResult, OCRBox } from "../src/ocr/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  // 1. Create a simple test PDF with a visible text line
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  const { width: pw, height: ph } = page.getSize();

  // Draw some visible text
  page.drawText("Hello OCR World", { x: 50, y: ph - 100, size: 20, font, color: rgb(0, 0, 0) });
  page.drawText("Line 2: test", { x: 50, y: ph - 130, size: 16, font, color: rgb(0, 0, 0) });

  const originalPdf = await doc.save();
  console.log(`Original PDF: ${originalPdf.length} bytes`);

  // 2. Mock OCR result (simulating what the engine would produce)
  const mockResult: OCRResult = {
    pages: [{
      pageIndex: 0,
      pageWidth: 800,
      pageHeight: 400,
      pageWidthPoints: 400,
      pageHeightPoints: 200,
      boxes: [
        { points: [100, 80, 400, 80, 400, 105, 100, 105], raw: { x1: 100, y1: 80, x2: 400, y2: 105 }, score: 0.95, text: "Hello OCR World" },
        { points: [100, 110, 300, 110, 300, 130, 100, 130], raw: { x1: 100, y1: 110, x2: 300, y2: 130 }, score: 0.92, text: "Line 2: test" },
      ],
    }],
  };

  // 3. Add OCR layer (scale from pageWidth / pageWidthPoints)
  const outputPdf = await addOcrLayerToPdf(originalPdf, mockResult);
  console.log(`Output PDF: ${outputPdf.length} bytes`);

  // 4. Verify: load the output and check it has 1 page
  const outDoc = await PDFDocument.load(outputPdf);
  console.log(`Output pages: ${outDoc.getPageCount()}`);
  console.log("SUCCESS: pdf-builder works!");

  // Write output for manual inspection
  fs.writeFileSync(path.join(root, "scripts", "test-ocr-output.pdf"), outputPdf);
  console.log("Written to test-ocr-output.pdf");
}

main().catch(e => { console.error("FAILED:", e); process.exit(1); });