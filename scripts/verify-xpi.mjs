import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "addon", "manifest.json"), "utf8"));
const xpi = path.join(projectRoot, "build", `pdf-ocr-for-zotero-${manifest.version}.xpi`);
if (!fs.existsSync(xpi)) throw new Error(`XPI not found: ${xpi}`);
const stats = fs.statSync(xpi);
if (!stats.size) throw new Error("XPI is empty");
const entries = new Set(new AdmZip(xpi).getEntries().map((entry) => entry.entryName));
for (const required of [
  "manifest.json",
  "bootstrap.js",
  "content/scripts/pdf-ocr-for-zotero.js",
  "content/scripts/pdf.worker.mjs",
  "content/icons/pdf-ocr.svg",
  "content/scripts/ort-wasm-simd-threaded.jsep.wasm",
  "content/models/ch_PP-OCRv4_det_infer.onnx",
  "content/models/ch_PP-OCRv4_rec_infer.onnx",
  "content/models/ppocr_keys_v1.txt",
  "content/fonts/NotoSansCJKsc-Regular.otf",
  "locale/zh-CN/addon.ftl",
  "locale/en-US/addon.ftl",
]) {
  if (!entries.has(required)) throw new Error(`Required XPI entry missing: ${required}`);
}
console.log(`XPI exists: ${xpi}`);
console.log(`XPI bytes: ${stats.size}`);
console.log("XPI root and required entries verified");
