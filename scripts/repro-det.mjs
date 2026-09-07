import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as ort from "onnxruntime-node";
import { detPreprocess } from "../src/ocr/preprocess.ts";
import { detPostprocess, nmsBoxes } from "../src/ocr/postprocess.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdf = path.join(root, "CN102135528A.pdf");
const doc = await pdfjs.getDocument({
  url: pdf,
  wasmUrl: path.join(root, "node_modules", "pdfjs-dist", "wasm") + "/",
}).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 2 });
const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: ctx, viewport }).promise;
const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
const pixels = new Uint8ClampedArray(data);
const pre = detPreprocess(pixels, width, height, 1536);
const session = await ort.InferenceSession.create(path.join(root, "addon", "content", "models", "ch_PP-OCRv4_det_infer.onnx"));
const inputName = session.inputNames[0];
const out = await session.run({ [inputName]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]) });
const t = out[session.outputNames[0]];
const [, , mapH, mapW] = t.dims;
const detRes = detPostprocess(t.data, mapW, mapH, width, height, pre.scaleX, pre.scaleY, {
  thresh: 0.3, boxThresh: 0.4, maxRotDeg: 30, cropMode: 2,
});
const boxes = nmsBoxes(detRes.boxes.map((b) => ({ points: b.points.slice(), raw: b.raw, score: b.score, text: "" })));
console.log(`det boxes=${boxes.length} resized=${pre.resizedWidth}x${pre.resizedHeight} page=${width}x${height}`);
if (boxes[0]) console.log("first", boxes[0].raw, boxes[0].score.toFixed(3));
await session.release();
