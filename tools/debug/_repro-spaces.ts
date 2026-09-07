// Repro: run the plugin's exact det+rec stack on test1_1536.rgba and inspect
// how inter-word spaces behave inside each box text and between adjacent boxes.
// Run: node --import tsx tools/debug/_repro-spaces.ts
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detPreprocess, recPreprocess, cropRGBA, cropQuad } from "../../src/ocr/preprocess.ts";
import { detPostprocess, recDecode, nmsBoxes } from "../../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modelsDir = path.join(root, "addon", "content", "models");
const w = 1152, h = 1536;

const charDict = fs.readFileSync(path.join(modelsDir, "ppocr_keys_v1.txt"), "utf8").split("\n");
charDict.unshift("blank");
charDict.push(" ");
console.log("dict length:", charDict.length);

async function main() {
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"))),
    ort.InferenceSession.create(fs.readFileSync(path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"))),
  ]);
  const raw = fs.readFileSync(path.join(root, "tools", "debug", "test1_1536.rgba"));
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);

  // det — same options as the plugin defaults (cropMode 2, maxRotDeg 30)
  const pre = detPreprocess(px, w, h, 1536);
  const detOut = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) });
  const t = detOut[det.outputNames[0]];
  const [, , mapH, mapW] = t.dims as number[];
  const detRes = detPostprocess(t.data as Float32Array, mapW, mapH, w, h, pre.scaleX, pre.scaleY, {
    thresh: 0.3, boxThresh: 0.4, maxRotDeg: 30, cropMode: 2,
  });
  const rawBoxes = nmsBoxes(detRes.boxes.map((b) => ({ points: b.points.slice(), raw: b.raw, score: b.score, text: "" })));
  console.log("det boxes after nms:", rawBoxes.length);

  // rec — same per-box path as ocr-worker.recBoxes
  const recName = rec.inputNames[0];
  const boxes: Array<{ text: string; raw: { x1: number; y1: number; x2: number; y2: number } }> = [];
  for (const box of rawBoxes) {
    const q = box.points;
    const outW = Math.round(Math.hypot(q[2] - q[0], q[3] - q[1]));
    const outH = Math.round(Math.hypot(q[6] - q[0], q[7] - q[1]));
    if (outW < 2 || outH < 2) continue;
    // hybrid cropMode 2: axis-aligned (tilt <= 1.5deg) -> sharp AABB copy else cropQuad
    const tilt = Math.min(
      Math.abs(Math.atan2(q[3] - q[1], q[2] - q[0])) * 180 / Math.PI,
      180 - Math.abs(Math.atan2(q[3] - q[1], q[2] - q[0])) * 180 / Math.PI,
    );
    const l1 = Math.hypot(q[2] - q[0], q[3] - q[1]);
    const l2 = Math.hypot(q[6] - q[0], q[7] - q[1]);
    const longIdx = l1 >= l2 ? 2 : 6;
    const deg = Math.min(Math.abs(Math.atan2(q[longIdx + 1] - q[1], q[longIdx] - q[0])) * 180 / Math.PI, 180 - Math.abs(Math.atan2(q[longIdx + 1] - q[1], q[longIdx] - q[0])) * 180 / Math.PI);
    let crop: Uint8ClampedArray, cw: number, ch: number;
    if (deg <= 1.5) {
      const minX = Math.min(q[0], q[2], q[4], q[6]), maxX = Math.max(q[0], q[2], q[4], q[6]);
      const minY = Math.min(q[1], q[3], q[5], q[7]), maxY = Math.max(q[1], q[3], q[5], q[7]);
      crop = cropRGBA(px, w, h, minX, minY, maxX - minX, maxY - minY);
      cw = maxX - minX; ch = maxY - minY;
    } else {
      crop = cropQuad(px, w, h, q, outW, outH);
      cw = outW; ch = outH;
    }
    if (cw < 2 || ch < 2) continue;
    const rp = recPreprocess(crop, cw, ch);
    const recOut = await rec.run({ [recName]: new ort.Tensor("float32", rp.tensor, [1, 3, rp.height, rp.width]) });
    const rt = recOut[rec.outputNames[0]];
    const dims = rt.dims as number[];
    const text = recDecode(rt.data as Float32Array, dims[1], dims[2], charDict.slice());
    const trimmed = text.trim();
    if (!trimmed) continue;
    boxes.push({ text: trimmed, raw: box.raw });
  }

  console.log("recognized boxes:", boxes.length);

  // group into visual lines by y-overlap (like readingOrder) and print left->right
  const sorted = boxes.slice().sort((a, b) => a.raw.y1 - b.raw.y1 || a.raw.x1 - b.raw.x1);
  const lines: typeof boxes[] = [];
  for (const box of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const ref = line[0];
      const overlap = Math.min(box.raw.y2, ref.raw.y2) - Math.max(box.raw.y1, ref.raw.y1);
      const minH = Math.min(box.raw.y2 - box.raw.y1, ref.raw.y2 - ref.raw.y1);
      if (minH > 0 && overlap / minH >= 0.5) { line.push(box); continue; }
    }
    lines.push([box]);
  }
  let n = 0;
  for (const line of lines) {
    line.sort((a, b) => a.raw.x1 - b.raw.x1);
    const joined = line.map((b) => b.text).join("|");
    const gaps = line.map((b, i) => i > 0 ? b.raw.x1 - line[i - 1].raw.x2 : 0).join(",");
    console.log(`[L${String(n++).padStart(2, "0")}] pieces=${line.length} gaps=[${gaps}]  =>  ${joined}`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });