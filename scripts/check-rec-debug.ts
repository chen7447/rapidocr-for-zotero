// Debug rec: print argmax sequence and compare with Python
// Run: node --import tsx scripts/check-rec-debug.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { recPreprocess, cropRGBA } from "../src/ocr/preprocess.ts";
import { recDecode } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  const recBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"));
  const rec = await ort.InferenceSession.create(recBytes);
  const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
  charDict.unshift("blank"); // index 0 = CTC blank
  charDict.push(" ");        // last index = space

  // Load the real image
  const w = 500, h = 500;
  const raw = fs.readFileSync(path.join(root, "scripts", "test_text.rgba"));
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);

  // Crop: Python box[0] = [28,37,304,37,304,73,28,73]
  const bx = 28, by = 37, bw = 276, bh = 36;
  const crop = cropRGBA(px, w, h, bx, by, bw, bh);
  const rp = recPreprocess(crop, bw, bh);
  console.log(`recPreprocess: width=${rp.width}, height=${rp.height}, scale=${rp.scale}`);

  const recIn = new ort.Tensor("float32", rp.tensor, [1, 3, rp.height, rp.width]);
  const recOut = await rec.run({ [rec.inputNames[0]]: recIn });
  const rt = recOut[rec.outputNames[0]];
  const rd = rt.dims as number[];
  const rdata = rt.data as Float32Array;
  console.log(`rec output dims: ${JSON.stringify(rd)}`);

  // Debug: argmax per timestep
  const seqLen = rd[1], numClasses = rd[2];
  const argmaxes: number[] = [];
  for (let t = 0; t < seqLen; t++) {
    let maxVal = -Infinity, maxIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const v = rdata[t * numClasses + c];
      if (v > maxVal) { maxVal = v; maxIdx = c; }
    }
    argmaxes.push(maxIdx);
  }
  console.log(`argmax seq (${seqLen}): ${argmaxes.join(",")}`);
  console.log(`non-blank: ${argmaxes.filter(i => i !== 0).join(",")}`);

  const text = recDecode(rdata, seqLen, numClasses, charDict.slice());
  console.log(`rec text: "${text}"`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });