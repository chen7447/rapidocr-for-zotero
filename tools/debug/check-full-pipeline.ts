// Full pipeline local test: OCR real image → build searchable PDF
// Run: node --import tsx scripts/check-full-pipeline.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess, recPreprocess, cropRGBA } from "../src/ocr/preprocess.ts";
import { detPostprocess, recDecode } from "../src/ocr/postprocess.ts";
import { addOcrLayerToPdf } from "../src/ocr/pdf-builder.ts";
import { OCRResult, OCRBox } from "../src/ocr/types.ts";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  // 1. Load models
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const recBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"));
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(detBytes),
    ort.InferenceSession.create(recBytes),
  ]);
  const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
  charDict.unshift("blank");
  charDict.push(" ");

  // 2. Load real image
  const w = 500, h = 500;
  const raw = fs.readFileSync(path.join(root, "scripts", "test_text.rgba"));
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);

  // 3. Run det
  const pre = detPreprocess(px, w, h);
  const detOut = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) });
  const t = detOut[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const arr = t.data as Float32Array;
  const detRes = detPostprocess(arr, mapW, mapH, w, h, pre.scale);
  console.log(`DET boxes: ${detRes.boxes.length}`);

  // 4. Run rec
  const boxes: OCRBox[] = [];
  for (let bi = 0; bi < detRes.boxes.length; bi++) {
    const box = detRes.boxes[bi];
    const bx = box.points[0], by = box.points[1];
    const bw = box.points[2] - bx, bh = box.points[5] - by;
    if (bw < 2 || bh < 2) continue;
    const crop = cropRGBA(px, w, h, bx, by, bw, bh);
    const rp = recPreprocess(crop, bw, bh);
    const recOut = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", rp.tensor, [1, 3, rp.height, rp.width]) });
    const rt = recOut[rec.outputNames[0]];
    const rd = rt.dims as number[];
    const rdata = rt.data as Float32Array;
    const text = recDecode(rdata, rd[1], rd[2], charDict.slice());
    boxes.push({ points: box.points.slice(), raw: box.raw, score: box.score, text });
    console.log(`  box[${bi}] "${text}" score=${box.score.toFixed(3)} @ ${bx},${by} ${bw}x${bh}`);
  }

  // 5. Build OCR result
  const ocrResult: OCRResult = {
    pages: [{
      pageIndex: 0,
      pageWidth: w,
      pageHeight: h,
      pageWidthPoints: 500,
      pageHeightPoints: 500,
      boxes,
    }],
  };

  // 6. Create a simple PDF page
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.addPage([500, 500]);

  // 7. Add OCR layer — pass bundled font bytes directly (Node has no fetch file://)
  const fontBytes = fs.readFileSync(path.join(root, "addon", "content", "fonts", "NotoSansCJKsc-Regular.otf"));
  const outputPdf = await addOcrLayerToPdf(await doc.save(), ocrResult, fontBytes);
  fs.writeFileSync(path.join(root, "scripts", "test-full-ocr.pdf"), outputPdf);
  console.log(`\nOutput PDF: ${outputPdf.length} bytes`);
  console.log("Written to test-full-ocr.pdf");
  console.log("SUCCESS: Full pipeline works!");
}

main().catch(e => { console.error("FAILED:", e); process.exit(1); });