import assert from "node:assert/strict";
import test from "node:test";

import { parseOcrPrefs } from "../../src/ocr/prefs";

test("unset / NaN / non-numeric values fall back to defaults", () => {
  const p = parseOcrPrefs({});
  assert.equal(p.detLimitSideLen, 1536);
  assert.equal(p.detThresh, 0.3);
  assert.equal(p.detBoxThresh, 0.4);
  assert.equal(p.detMaxRotDeg, 30);
  assert.equal(p.cropMode, 2);
  assert.equal(p.ocrWorkers, 4);
  assert.equal(p.autoOpen, false);

  const junk = parseOcrPrefs({
    detLimitSideLen: NaN,
    detThresh: "abc" as unknown as number,
    detBoxThresh: undefined,
    detMaxRotDeg: null,
    cropMode: NaN,
    ocrWorkers: undefined,
  });
  assert.equal(junk.detLimitSideLen, 1536);
  assert.equal(junk.detThresh, 0.3);
  assert.equal(junk.detBoxThresh, 0.4);
  assert.equal(junk.detMaxRotDeg, 30);
  assert.equal(junk.cropMode, 2);
  assert.equal(junk.ocrWorkers, 4);

  // null must mean "unset", NOT 0 (Number(null) === 0 is a JS trap)
  const nulls = parseOcrPrefs({ detMaxRotDeg: null, cropMode: null });
  assert.equal(nulls.detMaxRotDeg, 30);
  assert.equal(nulls.cropMode, 2);
});

test("thresholds stored as integer percentages convert to 0..1", () => {
  const p = parseOcrPrefs({ detThresh: 30, detBoxThresh: 40 });
  assert.equal(p.detThresh, 0.3);
  assert.equal(p.detBoxThresh, 0.4);
  assert.equal(parseOcrPrefs({ detThresh: 100 }).detThresh, 1);
  assert.equal(parseOcrPrefs({ detThresh: 1 }).detThresh, 0.01);
});

test("legacy float storage (0<v<1) still converts with the same rounding", () => {
  assert.equal(parseOcrPrefs({ detThresh: 0.3 }).detThresh, 0.3);
  assert.equal(parseOcrPrefs({ detBoxThresh: 0.45 }).detBoxThresh, 0.45);
});

test("LEGITIMATE ZERO is preserved, not defaulted (detThresh/detBoxThresh/detMaxRotDeg)", () => {
  const p = parseOcrPrefs({ detThresh: 0, detBoxThresh: 0, detMaxRotDeg: 0 });
  assert.equal(p.detThresh, 0);
  assert.equal(p.detBoxThresh, 0);
  assert.equal(p.detMaxRotDeg, 0);
});

test("detMaxRotDeg clamps into 0..90", () => {
  assert.equal(parseOcrPrefs({ detMaxRotDeg: 200 }).detMaxRotDeg, 90);
  assert.equal(parseOcrPrefs({ detMaxRotDeg: -5 }).detMaxRotDeg, 0);
  assert.equal(parseOcrPrefs({ detMaxRotDeg: 45.6 }).detMaxRotDeg, 46);
});

test("detLimitSideLen requires >=1; zero is meaningless and falls back", () => {
  assert.equal(parseOcrPrefs({ detLimitSideLen: 1920 }).detLimitSideLen, 1920);
  assert.equal(parseOcrPrefs({ detLimitSideLen: 0 }).detLimitSideLen, 1536);
  assert.equal(parseOcrPrefs({ detLimitSideLen: -512 }).detLimitSideLen, 1536);
  assert.equal(parseOcrPrefs({ detLimitSideLen: 1300.4 }).detLimitSideLen, 1300);
});

test("cropMode keeps 0/1/2 (0 is valid) and rejects everything else", () => {
  assert.equal(parseOcrPrefs({ cropMode: 0 }).cropMode, 0);
  assert.equal(parseOcrPrefs({ cropMode: 1 }).cropMode, 1);
  assert.equal(parseOcrPrefs({ cropMode: 2 }).cropMode, 2);
  assert.equal(parseOcrPrefs({ cropMode: 7 }).cropMode, 2);
  assert.equal(parseOcrPrefs({ cropMode: -1 }).cropMode, 2);
});

test("ocrWorkers accepts integers 1..8, clamps high values, rejects junk", () => {
  assert.equal(parseOcrPrefs({ ocrWorkers: 1 }).ocrWorkers, 1);
  assert.equal(parseOcrPrefs({ ocrWorkers: 8 }).ocrWorkers, 8);
  assert.equal(parseOcrPrefs({ ocrWorkers: 99 }).ocrWorkers, 8);
  assert.equal(parseOcrPrefs({ ocrWorkers: 0 }).ocrWorkers, 4);
  assert.equal(parseOcrPrefs({ ocrWorkers: 2.5 }).ocrWorkers, 4);
});

test("autoOpenAfterSuccess coerces to boolean", () => {
  assert.equal(parseOcrPrefs({ autoOpenAfterSuccess: true }).autoOpen, true);
  assert.equal(parseOcrPrefs({ autoOpenAfterSuccess: 1 as unknown as boolean }).autoOpen, true);
  assert.equal(parseOcrPrefs({ autoOpenAfterSuccess: false }).autoOpen, false);
  assert.equal(parseOcrPrefs({ autoOpenAfterSuccess: 0 as unknown as boolean }).autoOpen, false);
  assert.equal(parseOcrPrefs({ autoOpenAfterSuccess: undefined }).autoOpen, false);
});
