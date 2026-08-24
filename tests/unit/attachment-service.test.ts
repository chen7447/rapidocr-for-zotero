import assert from "node:assert/strict";
import test from "node:test";

import { createOCRAttachment, createParentAndAttachOCR } from "../../src/zotero/attachment-service";

type FakeItem = {
  id: number;
  libraryID: number;
  parentItemID: number | false;
  isAttachment: () => boolean;
  isRegularItem: () => boolean;
};

type FakeImportCall = {
  file: string;
  libraryID: number;
  parentItemID: number;
  title: string;
};

class FakeZoteroItems {
  readonly items = new Map<number, FakeItem>();
  get(id: number): FakeItem | undefined { return this.items.get(id); }
}

class FakeZoteroAttachments {
  importCalls: FakeImportCall[] = [];
  async importFromFile(opts: {
    file: string;
    libraryID: number;
    parentItemID: number;
    title: string;
  }): Promise<{ id: number }> {
    this.importCalls.push(opts);
    return { id: 999 };
  }
}

class FakeZoteroFulltext {
  indexCalls: number[][] = [];
  async indexItems(ids: number[], _opts?: { complete?: boolean }): Promise<void> {
    this.indexCalls.push(ids);
  }
}

test("createOCRAttachment imports a sibling attachment under the original's parent", async () => {
  const items = new FakeZoteroItems();
  const attachments = new FakeZoteroAttachments();
  const fulltext = new FakeZoteroFulltext();

  items.items.set(5, { id: 5, libraryID: 1, parentItemID: 10, isAttachment: () => true, isRegularItem: () => false });
  items.items.set(10, { id: 10, libraryID: 1, parentItemID: false, isAttachment: () => false, isRegularItem: () => true });

  const result = await createOCRAttachment({
    attachmentID: 5,
    path: "C:\\paper.pdf",
    title: "My Paper",
    getItems: (ids) => ids.map((id) => items.get(id)).filter(Boolean) as FakeItem[],
    importFromFile: async (opts) => attachments.importFromFile(opts),
    indexItems: async (ids, opts) => fulltext.indexItems(ids, opts),
  });

  assert.equal(result.status, "sibling_imported");
  if (result.status === "sibling_imported") assert.equal(result.attachmentID, 999);
  assert.equal(attachments.importCalls.length, 1);
  assert.equal(attachments.importCalls[0].file, "C:\\paper.pdf");
  assert.equal(attachments.importCalls[0].libraryID, 1);
  assert.equal(attachments.importCalls[0].parentItemID, 10);
  assert.equal(attachments.importCalls[0].title, "My Paper [OCR]");
  assert.deepEqual(fulltext.indexCalls, [[999]]);
});

test("createOCRAttachment returns standalone_attachment when original PDF has no parent", async () => {
  const items = new FakeZoteroItems();
  const attachments = new FakeZoteroAttachments();
  const fulltext = new FakeZoteroFulltext();

  items.items.set(7, { id: 7, libraryID: 2, parentItemID: false, isAttachment: () => true, isRegularItem: () => false });

  const result = await createOCRAttachment({
    attachmentID: 7,
    path: "C:\\standalone.pdf",
    title: "Standalone",
    getItems: (ids) => ids.map((id) => items.get(id)).filter(Boolean) as FakeItem[],
    importFromFile: async (opts) => attachments.importFromFile(opts),
    indexItems: async (ids, opts) => fulltext.indexItems(ids, opts),
  });

  assert.equal(result.status, "standalone_attachment");
  assert.equal(attachments.importCalls.length, 0);
});

test("createOCRAttachment returns error when item not found", async () => {
  const result = await createOCRAttachment({
    attachmentID: 999,
    path: "C:\\missing.pdf",
    title: "Missing",
    getItems: () => [],
    importFromFile: async () => ({ id: 0 }),
    indexItems: async () => {},
  });
  assert.equal(result.status, "item_not_found");
});

test("createParentAndAttachOCR creates a regular parent item, attaches original, and imports [OCR] sibling", async () => {
  const created: Array<{ libraryID: number; title: string }> = [];
  const setParentCalls: Array<[number, number]> = [];
  const importCalls: FakeImportCall[] = [];
  const indexCalls: number[][] = [];

  const result = await createParentAndAttachOCR({
    attachmentID: 7,
    path: "C:\\standalone.pdf",
    title: "Standalone Paper",
    getItems: (ids) => ids.map((id) => ({ id, libraryID: 2, parentItemID: false, isAttachment: () => true, isRegularItem: () => false })),
    createRegularItem: async (opts) => { created.push(opts); return { id: 200 }; },
    setAttachmentParent: async (id, pid) => { setParentCalls.push([id, pid]); },
    importFromFile: async (opts) => { importCalls.push(opts); return { id: 201 }; },
    indexItems: async (ids) => { indexCalls.push(ids); },
  });

  assert.equal(result.status, "parent_created");
  if (result.status === "parent_created") assert.equal(result.attachmentID, 201);
  assert.deepEqual(created, [{ libraryID: 2, title: "Standalone Paper" }]);
  assert.deepEqual(setParentCalls, [[7, 200]]);
  assert.deepEqual(importCalls, [{
    file: "C:\\standalone.pdf",
    libraryID: 2,
    parentItemID: 200,
    title: "Standalone Paper [OCR]",
  }]);
  assert.deepEqual(indexCalls, [[201]]);
});

test("createParentAndAttachOCR returns item_not_found when item missing", async () => {
  const result = await createParentAndAttachOCR({
    attachmentID: 999,
    path: "C:\\missing.pdf",
    title: "Missing",
    getItems: () => [],
    createRegularItem: async () => ({ id: 0 }),
    setAttachmentParent: async () => {},
    importFromFile: async () => ({ id: 0 }),
    indexItems: async () => {},
  });
  assert.equal(result.status, "item_not_found");
});