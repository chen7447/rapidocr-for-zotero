// Load the Python-preprocessed rec tensor and run rec with it.
// If this decodes correctly, our recPreprocess is buggy.
// Run: node --import tsx scripts/check-py-tensor-js.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { recDecode } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "addon", "content", "models");

async function main() {
  const recBytes = fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"));
  const rec = await ort.InferenceSession.create(recBytes);
  const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
  charDict.unshift("blank"); // index 0 = CTC blank
  charDict.push(" ");        // last index = space

  // Python saved shape (3, 48, 368) float32
  const raw = fs.readFileSync(path.join(root, "scripts", "python_rec_tensor.raw"));
  const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  console.log(`tensor len: ${data.length}, expected ${3 * 48 * 368}`);

  const inp = new ort.Tensor("float32", data, [1, 3, 48, 368]);
  const out = await rec.run({ [rec.inputNames[0]]: inp });
  const rt = out[rec.outputNames[0]];
  const rd = rt.dims as number[];
  const rdata = rt.data as Float32Array;
  console.log(`rec output dims: ${JSON.stringify(rd)}`);

  const seqLen = rd[1], numClasses = rd[2];
  // Print first 3 timestep class distributions for sanity
  for (let t = 0; t < 3; t++) {
    let maxVal = -Infinity, maxIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const v = rdata[t * numClasses + c];
      if (v > maxVal) { maxVal = v; maxIdx = c; }
    }
    console.log(`t=${t}: argmax=${maxIdx} ("${charDict[maxIdx]}") p=${maxVal.toFixed(4)}`);
  }

  const text = recDecode(rdata, seqLen, numClasses, charDict.slice());
  console.log(`rec text: "${text}"`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });