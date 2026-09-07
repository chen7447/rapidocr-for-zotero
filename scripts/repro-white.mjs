// 复现扫描版 PDF 渲染：渲第 1 页、存 PNG、统计像素，并列出图像算子。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const file = process.argv[2] ?? "CN102135528A.pdf";
const withWasm = !process.argv.includes("--no-wasm");
const outPng = path.join(projectRoot, "build", "repro-page1.png");

const params = { url: path.resolve(projectRoot, file) };
if (withWasm) {
  params.wasmUrl = path.join(projectRoot, "node_modules", "pdfjs-dist", "wasm") + "/";
}

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.map(String).join(" ")); origWarn(...a); };

const doc = await pdfjs.getDocument(params).promise;
const page = await doc.getPage(1);
const ops = await page.getOperatorList();
const fns = pdfjs.OPS ?? {};
const names = Object.fromEntries(Object.entries(fns).map(([k, v]) => [v, k]));
const opCounts = {};
for (const op of ops.fnArray) {
  const n = names[op] ?? String(op);
  opCounts[n] = (opCounts[n] ?? 0) + 1;
}
console.log("ops", JSON.stringify(opCounts));

const viewport = page.getViewport({ scale: 2.0 });
const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: ctx, viewport }).promise;
const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
let nonWhite = 0, opaque = 0, black = 0;
for (let i = 0; i < data.length; i += 4) {
  if (data[i + 3] > 0) opaque++;
  if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
  if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20 && data[i + 3] > 200) black++;
}
fs.mkdirSync(path.join(projectRoot, "build"), { recursive: true });
fs.writeFileSync(outPng, canvas.toBuffer("image/png"));
console.log(`${file} wasm=${withWasm} ${canvas.width}x${canvas.height} nonWhite=${nonWhite} black=${black} opaque=${opaque}/${data.length / 4}`);
console.log("png", outPng);
if (warnings.length) console.log("warnings", warnings.slice(0, 8).join(" | "));
await doc.cleanup();
