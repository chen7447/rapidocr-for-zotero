// Debug the det postprocess step: where do the high-prob pixels sit?
// Run: node --import tsx scripts/check-post.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess } from "../src/ocr/preprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

function makeTextImage(iw: number, ih: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(iw * ih * 4);
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
  const det = await ort.InferenceSession.create(detBytes);

  const iw = 400, ih = 72;
  const px = makeTextImage(iw, ih);
  const pre = detPreprocess(px, iw, ih);
  const feed = { [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  const out = await det.run(feed);
  const t = out[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const arr = t.data as Float32Array;
  console.log(`map ${mapH}x${mapW}, scale=${pre.scale}`);

  // Histogram of probability values
  const buckets = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
  const counts = new Array(buckets.length - 1).fill(0);
  const coordOf = (i: number) => `(${i % mapW},${(i / mapW) | 0})`;
  const hot: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    for (let b = 0; b < buckets.length - 1; b++) {
      if (v >= buckets[b] && v < buckets[b + 1]) { counts[b]++; break; }
      if (v >= buckets[b] && b === buckets.length - 2) { counts[b]++; }
    }
    if (v > 0.5 && hot.length < 15) hot.push(`${coordOf(i)}=${v.toFixed(3)}`);
  }
  console.log("histogram:", buckets.slice(0, -1).map((b, i) => `${b}-${buckets[i + 1]}: ${counts[i]}`).join(" | "));
  console.log("hot pixels (>0.5):", hot.join("; "));
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });