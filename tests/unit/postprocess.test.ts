import assert from "node:assert/strict";
import test from "node:test";
import { isGarbageText, nmsBoxes, readingOrder, type DetBox } from "../../src/ocr/postprocess";

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
