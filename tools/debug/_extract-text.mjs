import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
const data = new Uint8Array(fs.readFileSync("F:/zotero插件/PDF OCR For Zotero v3/tools/debug/test-full-ocr.pdf"));
const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
const page = await doc.getPage(1);
const tc = await page.getTextContent();
const items = tc.items;
console.log("items:", items.length);
let line = "";
let lastY = null;
for (const it of items) {
  const y = Math.round(it.transform[5]);
  if (lastY !== null && Math.abs(y - lastY) > 2) line += "\n";
  line += it.str;
  lastY = y;
}
console.log(line);
