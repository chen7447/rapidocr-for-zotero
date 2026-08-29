// Test det model with a real image (downloaded from the web).
// Run: node --import tsx scripts/check-real.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess } from "../src/ocr/preprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");
const imgPath = path.join(root, "scripts", "test-text.jpg");

async function main() {
  // Load a real test image (RGBA pixels from a JPEG)
  const detBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"));
  const det = await ort.InferenceSession.create(detBytes);

  // Read the image file, decode to RGBA pixels
  // The image is a JPEG, we need to decode it. Use the built-in approach:
  // Read raw bytes and call a simple decoder? That's complex.
  // Better: use a small script that generates a simple test image with text-like patterns
  // that should trigger the model.

  // Actually, let's create a more realistic synthetic image:
  // Multiple small white rectangles arranged in a row to simulate text characters
  const iw = 400, ih = 72;
  const px = new Uint8ClampedArray(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      // Simulate "text" with multiple small white blocks (like characters)
      let lit = false;
      if (y > 16 && y < 56) {
        // "characters" at various positions with gaps between them
        if ((x > 20 && x < 45) || (x > 55 && x < 75) || (x > 90 && x < 120) || (x > 140 && x < 155) || (x > 170 && x < 200) || (x > 220 && x < 245) || (x > 260 && x < 280) || (x > 300 && x < 320) || (x > 340 && x < 360)) {
          lit = true;
        }
      }
      const v = lit ? 250 : 20;
      const i = (y * iw + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }

  const pre = detPreprocess(px, iw, ih);
  const inputName = det.inputNames[0];
  const feed = { [inputName]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) };
  console.log(`Running det with ${inputName} [1,3,${pre.resizedHeight},${pre.resizedWidth}]...`);
  const out = await det.run(feed);
  const outName = det.outputNames[0];
  const t = out[outName];
  console.log(`  out ${outName}: dims=${JSON.stringify(t.dims)}`);
  const arr = t.data as Float32Array;
  const [, , mapH, mapW] = t.dims as number[];
  let mn = Infinity, mx = -Infinity, sum = 0, nz = 0, nzMax = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    if (v !== 0) { nz++; if (v > nzMax) nzMax = v; }
  }
  console.log(`  prob map min=${mn}, max=${mx}, mean=${(sum / arr.length).toFixed(6)}, nonZero=${nz} (${((nz / arr.length) * 100).toFixed(3)}%), nzMax=${nzMax}`);

  // Also try with a real image: generate a gradient + text-like pattern
  // that looks more like natural scene text
  const iw2 = 400, ih2 = 200;
  const px2 = new Uint8ClampedArray(iw2 * ih2 * 4);
  for (let y = 0; y < ih2; y++) {
    for (let x = 0; x < iw2; x++) {
      // Gradient background
      const bg = 30 + (y / ih2) * 40;
      // "Text" with varied intensity
      let lit = false;
      if (y > 50 && y < 150) {
        if (x > 30 && x < 370) {
          // Add some texture/variation within the text block
          const charX = x % 30;
          const charSpacing = Math.floor(x / 30) % 2;
          if (charSpacing === 0 && charX > 3 && charX < 27) {
            // Add some "stroke" variation
            const strokeY = y % 10;
            if (strokeY > 1 && strokeY < 8) {
              lit = true;
            }
          }
        }
      }
      const v = lit ? 240 : bg;
      const i = (y * iw2 + x) * 4;
      px2[i] = v; px2[i + 1] = v; px2[i + 2] = v; px2[i + 3] = 255;
    }
  }
  const pre2 = detPreprocess(px2, iw2, ih2);
  const feed2 = { [inputName]: new ort.Tensor("float32", pre2.tensor, [1, 3, pre2.resizedHeight, pre2.resizedWidth]) };
  console.log(`\nTest 2 (textured text block): ${inputName} [1,3,${pre2.resizedHeight},${pre2.resizedWidth}]...`);
  const out2 = await det.run(feed2);
  const t2 = out2[outName];
  const arr2 = t2.data as Float32Array;
  let mn2 = Infinity, mx2 = -Infinity, sum2 = 0, nz2 = 0, nzMax2 = -Infinity;
  for (let i = 0; i < arr2.length; i++) {
    const v = arr2[i];
    if (v < mn2) mn2 = v;
    if (v > mx2) mx2 = v;
    sum2 += v;
    if (v !== 0) { nz2++; if (v > nzMax2) nzMax2 = v; }
  }
  console.log(`  prob map min=${mn2}, max=${mx2}, mean=${(sum2 / arr2.length).toFixed(6)}, nonZero=${nz2} (${((nz2 / arr2.length) * 100).toFixed(3)}%), nzMax=${nzMax2}`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });