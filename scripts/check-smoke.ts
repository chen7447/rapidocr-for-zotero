// Debug: why does the multi-block synthetic image give 0 boxes even with thresh=0.2?
// Run: node --import tsx scripts/check-smoke.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess } from "../src/ocr/preprocess.ts";
import { detPostprocess } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const det = await ort.InferenceSession.create(detBytes);

  // Same synthetic image as hooks.ts
  const iw = 400, ih = 72;
  const px = new Uint8ClampedArray(iw * ih * 4);
  const chars: [number, number][] = [
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

  const pre = detPreprocess(px, iw, ih);
  console.log(`resized: ${pre.resizedWidth}x${pre.resizedHeight}, scale=${pre.scale}`);

  const feed = { [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  const out = await det.run(feed);
  const t = out[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const arr = t.data as Float32Array;

  // Try different thresholds
  for (const thresh of [0.2, 0.15, 0.1, 0.05, 0.01]) {
    const detRes = detPostprocess(arr, mapW, mapH, iw, ih, pre.scale, { thresh, boxThresh: 0.0 });
    console.log(`thresh=${thresh}: boxes=${detRes.boxes.length}${detRes.boxes.length > 0 ? ` score=${detRes.boxes[0].score.toFixed(4)} @ ${detRes.boxes[0].points.slice(0, 2).join(",")}` : ""}`);
  }

  // Also check: how many pixels above each threshold?
  for (const t of [0.2, 0.15, 0.1, 0.05, 0.01, 0.001]) {
    let cnt = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > t) cnt++;
    console.log(`pixels > ${t}: ${cnt}`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });