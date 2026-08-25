import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.match(hooks, /ocrDialog\.open\(ocrItem\.getDisplayTitle\?\.\(\) \|\| "", "删除 OCR 文字层"\)/);
  assert.match(hooks, /await waitReadersClosed/);
  assert.match(hooks, /await writePdf\(ocrPath, bytes\)/);
  assert.match(hooks, /reopen after strip/);
  assert.match(hooks, /reopen after page OCR/);
  assert.doesNotMatch(hooks, /reader\?\.navigate/);
});
