import { test } from "node:test";
import assert from "node:assert";
import { recDecode } from "../../src/ocr/postprocess";

// Synthetic CTC classes: 0=blank, 1="a", 2="b", 3="m", 4="w", 5=" ".
const NC = 6;
const DICT = ["blank", "a", "b", "m", "w", " "];

/** Build [seqLen, NC] probs: each event = (emit class, blankSpan, spaceProb inside span). */
function make(events: Array<{ cls: number; gap: number; spaceProb?: number }>): { probs: Float32Array; seqLen: number } {
  const seqLen = events.reduce((s, e) => s + e.gap, 0);
  const probs = new Float32Array(seqLen * NC);
  let t = 0;
  for (const e of events) {
    probs[t * NC + e.cls] = 1;
    for (let g = 1; g < e.gap; g++) {
      probs[(t + g) * NC] = 1 - (e.spaceProb ?? 0);
      if (e.spaceProb) probs[(t + g) * NC + 5] = e.spaceProb;
    }
    t += e.gap;
  }
  return { probs, seqLen };
}

test("recDecode: sub-argmax space prob recovers a word space", () => {
  const ev = [
    { cls: 1, gap: 2, spaceProb: 0.3 }, // a, 其后的 blank 间隙里模型投了 space 0.3
    { cls: 2, gap: 3 }, // b
  ];
  const { probs, seqLen } = make(ev);
  assert.equal(recDecode(probs, seqLen, NC, DICT.slice()), "a b");
});

test("recDecode: pure blank gap below 0.1 stays glued", () => {
  const { probs, seqLen } = make([{ cls: 1, gap: 2, spaceProb: 0.05 }, { cls: 2, gap: 3 }]);
  assert.equal(recDecode(probs, seqLen, NC, DICT.slice()), "ab");
});

test("recDecode: wide-letter pair with long blank gap does NOT split (fro m guard)", () => {
  // 9 chars at pitch 2 to make median meaningful, one o→m-like wide gap of 4 timesteps, no space vote
  const ev = [
    { cls: 1, gap: 2 }, { cls: 2, gap: 2 }, { cls: 1, gap: 2 }, { cls: 2, gap: 2 },
    { cls: 1, gap: 2 }, { cls: 3, gap: 4 }, // …a  <long gap> m…
    { cls: 1, gap: 2 }, { cls: 2, gap: 2 }, { cls: 1, gap: 2 }, { cls: 2, gap: 2 },
  ];
  const { probs, seqLen } = make(ev);
  assert.equal(recDecode(probs, seqLen, NC, DICT.slice()), "ababamabab");
});

test("recDecode: long gap between narrow chars recovers a space (headings, no space vote)", () => {
  const ev = [
    { cls: 1, gap: 2 }, { cls: 2, gap: 2 }, { cls: 1, gap: 2 }, { cls: 2, gap: 2 },
    { cls: 1, gap: 5 }, // real word space: gap ≈ 2.5× median
    { cls: 1, gap: 2 }, { cls: 2, gap: 2 }, { cls: 1, gap: 2 }, { cls: 2, gap: 2 },
  ];
  const { probs, seqLen } = make(ev);
  assert.equal(recDecode(probs, seqLen, NC, DICT.slice()), "ababa abab");
});
