import assert from "node:assert/strict";
import test from "node:test";

import { t, resetLocaleCacheForTests } from "../../src/locale";

type TestGlobal = typeof globalThis & { Zotero?: unknown };

function setZotero(locale: string | undefined): void {
  const g = globalThis as TestGlobal;
  if (locale === undefined) {
    delete g.Zotero;
  } else {
    g.Zotero = { locale };
  }
  resetLocaleCacheForTests();
}

test("t() falls back to English when no Zotero global is present", () => {
  const saved = (globalThis as TestGlobal).Zotero;
  setZotero(undefined);
  assert.equal(t("queue.cancelAll"), "Cancel all");
  assert.equal(t("hooks.skipped", { n: 2 }), "2 attachment(s) already queued — skipped.");
  setZotero(saved === undefined ? undefined : String((saved as { locale?: string }).locale));
});

test("t() uses the zh-CN table for zh* locales and interpolates args", () => {
  const saved = (globalThis as TestGlobal).Zotero;
  setZotero("zh-CN");
  assert.equal(t("hooks.skipped", { n: 2 }), "2 个附件已在队列中，已跳过。");
  assert.equal(t("hooks.done", { n: 12 }), "OCR 完成 — 12 个文本框");
  setZotero("en-US");
  assert.equal(t("hooks.done", { n: 12 }), "OCR complete — 12 text box(es)");
  setZotero(saved === undefined ? undefined : String((saved as { locale?: string }).locale));
});

test("t() unknown keys fall back to en, then to the key itself", () => {
  setZotero(undefined);
  // key exists only in zh → en table wins as fallback of last resort... here it
  // exists in neither, so the key itself comes back.
  assert.equal(t("no.such.key"), "no.such.key");
  setZotero(undefined);
});

test("t() interpolation is repeatable and does not mutate the table", () => {
  setZotero(undefined);
  assert.equal(t("engine.allocBoxes", { n: 4, k: 3, x: 12 }), "Allocated 4 workers, 3 boxes each (12 total)");
  assert.equal(t("engine.allocBoxes", { n: 8, k: 1, x: 8 }), "Allocated 8 workers, 1 boxes each (8 total)");
  setZotero(undefined);
});
