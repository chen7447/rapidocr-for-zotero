import assert from "node:assert/strict";
import test from "node:test";
import { parsePageSpec, toPageIndexes } from "../../src/ocr/page-spec";
import { resolvePageIndexes } from "../../src/ocr/ocr-engine";

test("parsePageSpec empty uses current page", () => {
  assert.deepEqual(parsePageSpec("", 10, 3), [3]);
  assert.deepEqual(parsePageSpec("  ", 10, 1), [1]);
});

test("parsePageSpec ranges and commas", () => {
  assert.deepEqual(parsePageSpec("3", 10), [3]);
  assert.deepEqual(parsePageSpec("3,5,7-9", 10), [3, 5, 7, 8, 9]);
  assert.deepEqual(parsePageSpec("9-7,1", 10), [1, 7, 8, 9]);
  assert.deepEqual(parsePageSpec("3，5", 10), [3, 5]);
});

test("parsePageSpec drops junk and out of range", () => {
  assert.deepEqual(parsePageSpec("0,1,10,11,foo,2-2", 10), [1, 2, 10]);
  assert.deepEqual(parsePageSpec("abc", 10, 4), []);
});

test("parsePageSpec keeps pages when pageCount is unknown", () => {
  assert.deepEqual(parsePageSpec("3", 0, 1), [3]);
  assert.deepEqual(parsePageSpec("3,5", 0, 1), [3, 5]);
});

test("toPageIndexes is 1-based to 0-based", () => {
  assert.deepEqual(toPageIndexes([1, 3, 10]), [0, 2, 9]);
});

test("resolvePageIndexes omits = all, filters range", () => {
  assert.deepEqual(resolvePageIndexes(3), [0, 1, 2]);
  assert.deepEqual(resolvePageIndexes(3, [2, 0, 2, -1, 9]), [0, 2]);
  assert.deepEqual(resolvePageIndexes(3, []), []);
});
