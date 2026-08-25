// Cross-check the det model with onnxruntime-node (native binary, no wasm).
// Run: node --import tsx scripts/check-node.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess } from "../src/ocr/preprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const det = await ort.InferenceSession.create(detBytes); // CPU by default

  console.log("=== det inputMetadata ===");
  for (const m of det.inputMetadata) {
    console.log(`  ${m.name}: type=${m.type}, dims=${JSON.stringify(m.dims)}`);
  }
  console.log("=== det outputMetadata ===");
  for (const m of det.outputMetadata) {
    console.log(`  ${m.name}: type=${m.type}, dims=${JSON.stringify(m.dims)}`);
  }

  // Synthetic image (same as hooks.ts)
  const iw = 400, ih = 72;
  const px = new Uint8ClampedArray(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const lit = x > 40 && x < 360 && y > 16 && y < 56;
      const v = lit ? 250 : 20;
      const i = (y * iw + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }

  const pre = detPreprocess(px, iw, ih);
  const inputName = det.inputNames[0];
  const feed = { [inputName]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  console.log(`\nRunning det with ${inputName} [1,3,${pre.resizedHeight},${pre.resizedWidth}]...`);
  const out = await det.run(feed);
  for (const name of det.outputNames) {
    const t = out[name];
    console.log(`  out ${name}: dims=${JSON.stringify(t.dims)}`);
    const arr = t.data as Float32Array;
    let mn = Infinity, mx = -Infinity, sum = 0, nz = 0, nzMax = -Infinity;
    const nzSamples: string[] = [];
    const mapW = t.dims[3] as number;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
      if (v !== 0) {
        nz++;
        if (nzSamples.length < 8) nzSamples.push(`[${i % mapW},${(i / mapW) | 0}]=${v.toFixed(4)}`);
        if (v > nzMax) nzMax = v;
      }
    }
    console.log(`  prob map min=${mn}, max=${mx}, mean=${(sum / arr.length).toFixed(6)}, nonZero=${nz} (${((nz / arr.length) * 100).toFixed(3)}%)`);
    console.log(`  nonZero max=${nzMax}, samples: ${nzSamples.join("; ")}`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });