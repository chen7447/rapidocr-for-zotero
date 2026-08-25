// Full JS pipeline on a REAL image (raw rgba from Python).
// Run: node --import tsx scripts/check-real-pipeline.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess, recPreprocess, cropRGBA } from "../src/ocr/preprocess.ts";
import { detPostprocess, recDecode } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const recBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"));
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(detBytes),
    ort.InferenceSession.create(recBytes),
  ]);
  const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
  // Replicate PP-OCR's CTCLabelDecode: insert "blank" at 0, space at end
  charDict.unshift("blank");
  charDict.push(" ");

  // Real 500x500 RGBA image
  const w = 500, h = 500;
  const raw = fs.readFileSync(path.join(root, "scripts", "test_text.rgba"));
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);

  const pre = detPreprocess(px, w, h);
  console.log(`resized: ${pre.resizedWidth}x${pre.resizedHeight}, scale=${pre.scale}`);
  const feed = { [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  const out = await det.run(feed);
  const t = out[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const arr = t.data as Float32Array;

  // Prob map stats
  let nz = 0;
  for (const v of arr) if (v > 0.3) nz++;
  console.log(`prob map ${mapW}x${mapH}, pixels>0.3: ${nz}`);

  const detRes = detPostprocess(arr, mapW, mapH, w, h, pre.scale);
  console.log(`DET boxes: ${detRes.boxes.length}`);

  for (let bi = 0; bi < Math.min(detRes.boxes.length, 5); bi++) {
    const box = detRes.boxes[bi];
    const bx = box.points[0], by = box.points[1];
    const bw = box.points[2] - bx, bh = box.points[5] - by;
    console.log(`  box[${bi}] score=${box.score.toFixed(3)} @ ${bx},${by} ${bw}x${bh}`);

    const crop = cropRGBA(px, w, h, bx, by, bw, bh);
    const rp = recPreprocess(crop, bw, bh);
    const recOut = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", rp.tensor, [1, 3, rp.height, rp.width]) });
    const rt = recOut[rec.outputNames[0]];
    const rd = rt.dims as number[];
    const rdata = rt.data as Float32Array;
    const text = recDecode(rdata, rd[1], rd[2], charDict.slice());
    console.log(`  rec "${text}"`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });