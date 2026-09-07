// 复现「扫描版 PDF 渲染成白布」：用插件同款 pdfjs-dist 渲染第 1 页并统计非白像素。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const file = process.argv[2] ?? "CN102135528A.pdf";
const withWasm = process.argv.includes("--wasm");

const params = {
  url: path.resolve(projectRoot, file),
};
if (withWasm) {
  params.wasmUrl = path.join(projectRoot, "node_modules", "pdfjs-dist", "wasm") + "/";
}

const doc = await pdfjs.getDocument(params).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 2.0 });
const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
let nonWhite = 0;
for (let i = 0; i < data.length; i += 4) {
  if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
}
console.log(`${file} wasmUrl=${withWasm} nonWhite=${nonWhite}/${data.length / 4}`);
await doc.loadingTask.destroy();
