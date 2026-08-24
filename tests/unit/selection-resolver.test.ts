import assert from "node:assert/strict";
import test from "node:test";

import {
  SelectionItem,
  SelectionResolver,
} from "../../src/zotero/selection-resolver";

class FakeItem implements SelectionItem {
  constructor(
    public readonly id: number,
    private readonly attachment: boolean,
    private readonly contentType = "",
    private readonly path: string | null = null,
    private readonly title = `Item ${id}`,
    private readonly children: FakeItem[] = [],
    public readonly libraryID = 1,
    public readonly parentItemID: number | false = false,
  ) {}

  isAttachment(): boolean { return this.attachment; }
  getAttachments(): number[] { return this.children.map((item) => item.id); }
  async getFilePathAsync(): Promise<string | false> { return this.path || false; }
  getDisplayTitle(): string { return this.title; }
  get attachmentContentType(): string { return this.contentType; }
}

function resolver(items: FakeItem[]): SelectionResolver {
  const byID = new Map(items.map((item) => [item.id, item]));
  return new SelectionResolver((ids) => ids.map((id) => byID.get(id)).filter((item): item is FakeItem => Boolean(item)));
}

test("direct local PDF attachment resolves to one job", async () => {
  const pdf = new FakeItem(1, true, "application/pdf", "C:\\papers\\paper.pdf", "Paper.pdf");
  const result = await resolver([pdf]).resolve([pdf]);
  assert.deepEqual(result.jobs.map((job) => ({ id: job.attachment.id, path: job.path })), [
    { id: 1, path: "C:\\papers\\paper.pdf" },
  ]);
  assert.equal(result.unavailable.length, 0);
});

test("non-PDF attachment produces no jobs", async () => {
  const image = new FakeItem(2, true, "image/png", "C:\\papers\\figure.png");
  const result = await resolver([image]).resolve([image]);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.unavailable.length, 0);
});

test("parent item resolves all local PDF children rather than only the first", async () => {
  const first = new FakeItem(11, true, "application/pdf", "C:\\papers\\main.pdf", "Main.pdf");
  const second = new FakeItem(12, true, "application/pdf", "C:\\papers\\supplement.pdf", "Supplement.pdf");
  const note = new FakeItem(13, true, "text/html", "C:\\papers\\note.html");
  const parent = new FakeItem(10, false, "", null, "Parent", [first, second, note]);
  const result = await resolver([parent, first, second, note]).resolve([parent]);
  assert.deepEqual(result.jobs.map((job) => job.attachment.id), [11, 12]);
});

test("multiple selections deduplicate the same PDF attachment", async () => {
  const pdf = new FakeItem(21, true, "application/pdf", "C:\\papers\\same.pdf");
  const parent = new FakeItem(20, false, "", null, "Parent", [pdf]);
  const result = await resolver([parent, pdf]).resolve([parent, pdf, parent]);
  assert.deepEqual(result.jobs.map((job) => job.attachment.id), [21]);
});

test("unavailable local PDF is reported and not scheduled", async () => {
  const remote = new FakeItem(31, true, "application/pdf", null, "Cloud PDF.pdf");
  const result = await resolver([remote]).resolve([remote]);
  assert.equal(result.jobs.length, 0);
  assert.deepEqual(result.unavailable.map((entry) => ({ id: entry.attachment.id, reason: entry.reason })), [
    { id: 31, reason: "FILE_UNAVAILABLE" },
  ]);
});

test("derived OCR attachment is skipped by default", async () => {
  const derived = new FakeItem(41, true, "application/pdf", "C:\\papers\\paper OCR.pdf", "Paper [OCR]");
  const result = await resolver([derived]).resolve([derived]);
  assert.equal(result.jobs.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ["DERIVED_OCR_ATTACHMENT"]);
});

test("PDF extension fallback works when content type is absent", async () => {
  const pdf = new FakeItem(51, true, "", "C:\\papers\\fallback.PDF", "Fallback");
  const result = await resolver([pdf]).resolve([pdf]);
  assert.deepEqual(result.jobs.map((job) => job.attachment.id), [51]);
});
