import assert from "node:assert/strict";
import test from "node:test";

import { openAttachment } from "../../src/zotero/open-file";

test("openAttachment uses FileHandlers.open with the attachment item", async () => {
  const item = { id: 42 };
  const opened: unknown[] = [];
  (globalThis as { Zotero: unknown }).Zotero = {
    Items: { get: (id: number) => (id === 42 ? item : undefined) },
    FileHandlers: { open: async (it: unknown, params?: unknown) => { opened.push(it, params); } },
  };
  await openAttachment(42, 2);
  assert.deepEqual(opened, [item, { location: { pageIndex: 2 } }]);
});

test("openAttachment falls back to Reader.open", async () => {
  const opened: number[] = [];
  (globalThis as { Zotero: unknown }).Zotero = {
    Items: { get: (id: number) => ({ id }) },
    Reader: { open: async (id: number) => { opened.push(id); } },
  };
  await openAttachment(7);
  assert.deepEqual(opened, [7]);
});

test("openAttachment throws when item is missing", async () => {
  (globalThis as { Zotero: unknown }).Zotero = {
    Items: { get: () => undefined },
  };
  await assert.rejects(() => openAttachment(1), /not found/);
});
