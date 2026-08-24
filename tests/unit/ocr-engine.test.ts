import assert from "node:assert/strict";
import test from "node:test";
import { OcrEngine } from "../../src/ocr/ocr-engine";
import type { PageRenderer } from "../../src/ocr/types";

function fakeRenderer(): PageRenderer {
  return {
    pageCount: 1,
    renderPage: async () => { throw new Error("should not render"); },
    dispose() {},
  };
}

test("OcrEngine.run aborts before fetching models when already cancelled", async () => {
  const engine = new OcrEngine(fakeRenderer(), { isCancelled: () => true });
  await assert.rejects(() => engine.run(), /OCR cancelled/);
});

test("OcrEngine.cancel() makes a subsequent run() throw immediately", async () => {
  const engine = new OcrEngine(fakeRenderer());
  engine.cancel();
  await assert.rejects(() => engine.run(), /OCR cancelled/);
});
