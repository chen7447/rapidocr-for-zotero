import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { regionBBox } from "../../src/ui/reader-toolbar";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/ui/reader-toolbar.ts"),
  "utf8",
);

test("popup uses a shield and click-delegates strip/ocr", () => {
  assert.match(src, /POP_ID \+ "-shield"/);
  assert.match(src, /host\.append\(shield, pop\)/);
  assert.match(src, /closest\?\.\("#pdfocr-go, #pdfocr-strip"\)/);
  assert.doesNotMatch(src, /pointerEvents = on \? "none"/);
});

test("strip OCR closes reader, shows progress, then reopens", () => {
  const hooks = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/hooks.ts"),
    "utf8",
  );
  assert.match(hooks, /ocrDialog\.open\(ocrItem\.getDisplayTitle\?\.\(\) \|\| "", t\("strip\.title"\)\)/);
  assert.match(hooks, /await waitReadersClosed/);
  assert.match(hooks, /await writePdf\(ocrPath, bytes\)/);
  assert.match(hooks, /reopen after strip/);
  assert.match(hooks, /reopen after page OCR/);
  assert.doesNotMatch(hooks, /reader\?\.navigate/);
});

test("regionBBox covers real Zotero ink and rect shapes", () => {
  const ink = regionBBox({ paths: [{ lines: [[10, 20, 30, 40]], points: [[5, 60]] }] });
  assert.deepEqual(ink, { x1: 5, y1: 20, x2: 30, y2: 60 });
  const rect = regionBBox({ rects: [[100, 50, 300, 90]] });
  assert.deepEqual(rect, { x1: 100, y1: 50, x2: 300, y2: 90 });
  assert.equal(regionBBox({}), null);
  assert.equal(regionBBox(undefined), null);
});
