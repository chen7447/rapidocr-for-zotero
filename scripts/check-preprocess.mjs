// Local sanity check for preprocess.ts without Zotero.
import { detPreprocess } from "../src/ocr/preprocess.ts";

const iw = 400, ih = 72;
const px = new Uint8ClampedArray(iw * ih * 4);
for (let y = 0; y < ih; y++) {
  for (let x = 0; x < iw; x++) {
    const lit = x > 40 && x < 360 && y > 16 && y < 56;
    const v = lit ? 250 : 20;
    const i = (y * iw + x) * 4;
    px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
  }
}

const pre = detPreprocess(px, iw, ih);
console.log("resized:", pre.resizedWidth, "x", pre.resizedHeight, "scale:", pre.scale);
console.log("tensor len:", pre.tensor.length, "(expected", 3 * pre.resizedHeight * pre.resizedWidth + ")");

let mn = Infinity, mx = -Infinity, sum = 0, nz = 0;
for (let i = 0; i < pre.tensor.length; i++) {
  const v = pre.tensor[i];
  if (v < mn) mn = v;
  if (v > mx) mx = v;
  sum += v;
  if (v !== 0) nz++;
}
console.log(`tensor min: ${mn}, max: ${mx}, mean: ${(sum / pre.tensor.length).toFixed(4)}, nonZero: ${nz} (${((nz / pre.tensor.length) * 100).toFixed(1)}%)`);

// Sample: first few values of channel 0
const ch0 = pre.tensor.slice(0, 12);
console.log("ch0 first 12:", Array.from(ch0).map((v) => v.toFixed(3)).join(", "));