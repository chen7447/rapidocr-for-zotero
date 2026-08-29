import assert from "node:assert/strict";
import test from "node:test";
import { isGarbageText, nmsBoxes, orderBoxes, readingOrder, type BoxLike, type DetBox } from "../../src/ocr/postprocess";

function box(id: string, x1: number, y1: number, x2: number, y2: number, score = 0.9): DetBox {
  return {
    points: [x1, y1, x2, y1, x2, y2, x1, y2],
    raw: { x1, y1, x2, y2 },
    score,
  };
}

test("nmsBoxes keeps a line box and drops chips inside it", () => {
  const line = box("line", 0, 0, 200, 20, 0.8);
  const chip = box("chip", 10, 2, 40, 18, 0.9);
  const kept = nmsBoxes([line, chip]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0], line);
});

test("nmsBoxes keeps two formula symbols when the parent is already gone", () => {
  const abn = box("ABn", 10, 5, 50, 25, 0.9);
  const abt = box("ABt", 10, 50, 50, 70, 0.9);
  assert.equal(nmsBoxes([abn, abt]).length, 2);
});

test("nmsBoxes keeps two side-by-side line boxes", () => {
  const a = box("a", 0, 0, 100, 20);
  const b = box("b", 0, 30, 100, 50);
  assert.equal(nmsBoxes([a, b]).length, 2);
});

test("readingOrder is top-to-bottom then left-to-right, not score order", () => {
  const bottom = box("bottom", 0, 80, 100, 100, 0.99);
  const topRight = box("topRight", 80, 0, 160, 20, 0.5);
  const topLeft = box("topLeft", 0, 2, 70, 18, 0.2);
  const ordered = readingOrder([bottom, topRight, topLeft]);
  assert.deepEqual(ordered.map((b) => b.points[0] + "," + b.points[1]), [
    "0,2",
    "80,0",
    "0,80",
  ]);
});

test("isGarbageText catches fraction-bar 8-runs and keeps citations", () => {
  assert.equal(isGarbageText("8888885888"), true);
  assert.equal(isGarbageText("881188 84 4019 1"), false); // mixed digits, no long run
  assert.equal(isGarbageText("9(1):101-123"), false);
  assert.equal(isGarbageText("https://doi.org/10.1007"), false);
  assert.equal(isGarbageText("control."), false);
});

const PAGE = 1200;

function colBoxes(x1: number, x2: number, rows: number, y0 = 120): BoxLike[] {
  const out: BoxLike[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * 80;
    out.push(box('c', x1, y, x2, y + 40));
  }
  return out;
}

test("orderBoxes splits two columns: left column fully, then right", () => {
  const left = colBoxes(80, 520, 10);
  const right = colBoxes(680, 1120, 10);
  const boxes = [];
  for (let r = 0; r < 10; r++) { boxes.push(left[r], right[r]); } // 同一基线交错入列
  const out = orderBoxes(boxes, PAGE);
  assert.equal(out.length, 20);
  for (let i = 0; i < 10; i++) assert.ok(out[i].raw.x1 < 600, 'first half must be left column');
  for (let i = 10; i < 20; i++) assert.ok(out[i].raw.x1 > 600, 'second half must be right column');
  for (let i = 1; i < 10; i++) assert.ok(out[i].raw.y1 > out[i - 1].raw.y1);
  for (let i = 11; i < 20; i++) assert.ok(out[i].raw.y1 > out[i - 1].raw.y1);
});

test("orderBoxes single-column page equals plain readingOrder (regression)", () => {
  const boxes = colBoxes(80, 520, 12);
  const got = orderBoxes(boxes, PAGE).map((b) => b.raw);
  const want = readingOrder(boxes).map((b) => b.raw);
  assert.deepEqual(got, want);
});

test("orderBoxes puts a full-wide title before the two-column body", () => {
  const title = box('title', 80, 40, 1120, 80);
  const left = colBoxes(80, 520, 10);
  const right = colBoxes(680, 1120, 10);
  const boxes = [title, ...left, ...right];
  const out = orderBoxes(boxes, PAGE);
  assert.equal(out[0], title);
  for (let i = 1; i <= 10; i++) assert.ok(out[i].raw.x1 < 600);
  for (let i = 11; i < 20; i++) assert.ok(out[i].raw.x1 > 600);
});

test("orderBoxes falls back to single column for a mid-page spanning figure", () => {
  const fig = box('fig', 100, 400, 1100, 500);
  const left = colBoxes(80, 520, 10);
  const right = colBoxes(680, 1120, 10);
  const boxes = [fig, ...left, ...right];
  const got = orderBoxes(boxes, PAGE).map((b) => b.raw);
  const want = readingOrder(boxes).map((b) => b.raw);
  assert.deepEqual(got, want);
});

test("orderBoxes handles three columns", () => {
  const boxes = [...colBoxes(80, 360, 8), ...colBoxes(460, 740, 8), ...colBoxes(840, 1120, 8)];
  const out = orderBoxes(boxes, PAGE);
  assert.equal(out.length, 24);
  for (let i = 0; i < 8; i++) assert.ok(out[i].raw.x1 < 400);
  for (let i = 8; i < 16; i++) assert.ok(out[i].raw.x1 > 400 && out[i].raw.x1 < 800);
  for (let i = 16; i < 24; i++) assert.ok(out[i].raw.x1 > 800);
});

test("nmsBoxes without pageWidth keeps the plain readingOrder behavior", () => {
  const boxes = colBoxes(80, 520, 10).concat(colBoxes(680, 1120, 10));
  const got = nmsBoxes(boxes).map((b) => b.raw);
  const want = readingOrder(boxes).map((b) => b.raw);
  assert.deepEqual(got, want);
});
