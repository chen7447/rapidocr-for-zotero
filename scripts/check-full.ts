// Full pipeline check with text-like synthetic image (local, onnxruntime-node).
// Run: node --import tsx scripts/check-full.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess, recPreprocess, cropRGBA } from "../src/ocr/preprocess.ts";
import { detPostprocess, recDecode } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

function makeTextImage(iw: number, ih: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(iw * ih * 4);
  // Text-like: multiple small white blocks (characters) on dark background
  const chars = [
    [20, 45], [55, 78], [90, 122], [140, 157], [170, 202], [220, 247],
    [260, 282], [300, 322], [340, 362],
  ];
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      let lit = false;
      if (y > 14 && y < 58) {
        for (const [cs, ce] of chars) {
          if (x > cs && x < ce) { lit = true; break; }
        }
      }
      const v = lit ? 250 : 20;
      const i = (y * iw + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  return px;
}

async function main() {
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const recBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"));
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(detBytes),
    ort.InferenceSession.create(recBytes),
  ]);
  const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
  charDict.unshift("blank"); // index 0 = CTC blank
  charDict.push(" ");        // last index = space

  const iw = 400, ih = 72;
  const px = makeTextImage(iw, ih);
  const pre = detPreprocess(px, iw, ih);
  const feed = { [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  const out = await det.run(feed);
  const t = out[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const arr = t.data as Float32Array;

  const detRes = detPostprocess(arr, mapW, mapH, iw, ih, pre.scale);
  console.log(`DET boxes: ${detRes.boxes.length}`);
  for (let bi = 0; bi < Math.min(detRes.boxes.length, 5); bi++) {
    const box = detRes.boxes[bi];
    const bx = box.points[0], by = box.points[1];
    const bw = box.points[2] - bx, bh = box.points[5] - by;
    console.log(`  box[${bi}] score=${box.score.toFixed(3)} @ ${bx},${by} ${bw}x${bh}`);

    const crop = cropRGBA(px, iw, ih, bx, by, bw, bh);
    const rp = recPreprocess(crop, bw, bh);
    const recOut = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", rp.tensor, [1, 3, 48, 320]) });
    const rt = recOut[rec.outputNames[0]];
    const rd = rt.dims as number[];
    const rdata = rt.data as Float32Array;
    const text = recDecode(rdata, rd[1], rd[2], charDict.slice());
    console.log(`  rec "${text}" (dims ${JSON.stringify(rd)})`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });