/**
 * OCR Web Worker — runs the whole PP-OCRv4 det+rec inference off the
 * main thread so the Zotero UI stays responsive while a page is being
 * processed (each page takes seconds on a laptop CPU).
 *
 * Protocol (postMessage):
 *   main → worker:
 *     { type: "init", wasm: ArrayBuffer, det: ArrayBuffer, rec: ArrayBuffer,
 *       dict: string[],
 *       detLimitSideLen: number, detThresh: number, detBoxThresh: number,
 *       maxRotDeg: number }
 *     { type: "page", pageIndex: number, width: number, height: number,
 *       rgba: ArrayBuffer }   // rgba is transferred (zero-copy)
 *     { type: "det", id: number, width, height, rgba }          // 只检测框（单页并行第一阶段）
 *     { type: "recBatch", id: number, width, height, rgba, boxes } // 对指定框列表并行识别
 *   worker → main:
 *     { type: "ready" }
 *     { type: "pageResult", pageIndex: number, boxes: OCRBox[] }
 *     { type: "detResult", id: number, boxes: OCRBox[] }       // text 为空
 *     { type: "recResult", id: number, boxes: OCRBox[] }
 *     { type: "error", message: string }
 *
 * This module is bundled into its own iife file (ocr-worker.js) by esbuild;
 * it must not import anything that references Zotero / DOM (it only imports
 * the pure-JS preprocess/postprocess modules and onnxruntime-web).
 */
import * as ort from "onnxruntime-web";
import { detPreprocess, recPreprocess, cropQuad, cropRGBA } from "./preprocess";
import { detPostprocess, recDecode, isGarbageText, nmsBoxes } from "./postprocess";
import type { OCRBox } from "./types";

// ─── worker globals (typed loosely; the bundle is a plain script worker) ──
declare const self: {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
};

interface WorkerInit {
  type: "init";
  wasm: ArrayBuffer;
  det: ArrayBuffer;
  rec: ArrayBuffer;
  dict: string[];
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
  maxRotDeg: number;
  cropMode: number;
}

interface WorkerPage {
  type: "page";
  pageIndex: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

interface WorkerDet {
  type: "det";
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

interface WorkerRecBatch {
  type: "recBatch";
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  boxes: OCRBox[];
}

type WorkerMessage = WorkerInit | WorkerPage | WorkerDet | WorkerRecBatch;

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let charDict: string[] = [];
let opts = { detLimitSideLen: 1536, detThresh: 0.3, detBoxThresh: 0.4, maxRotDeg: 30, cropMode: 2 };

self.onmessage = async (ev: MessageEvent) => {
  const data = ev.data as WorkerMessage;
  try {
    if (data.type === "init") {
      ort.env.wasm.numThreads = 1; // 沙箱无 SharedArrayBuffer/Worker 池 → 单线程
      ort.env.wasm.wasmBinary = data.wasm; // 直接提供 wasm 字节，无需 URL 加载
      await Promise.all([
        ort.InferenceSession.create(new Uint8Array(data.det), { executionProviders: ["wasm"] }),
        ort.InferenceSession.create(new Uint8Array(data.rec), { executionProviders: ["wasm"] }),
      ]).then(([det, rec]) => {
        detSession = det;
        recSession = rec;
      });
      charDict = data.dict.slice();
      opts = { detLimitSideLen: data.detLimitSideLen, detThresh: data.detThresh, detBoxThresh: data.detBoxThresh, maxRotDeg: data.maxRotDeg, cropMode: data.cropMode };
      self.postMessage({ type: "ready" });
      return;
    }
    if (data.type === "page") {
      const boxes = await runPage(data);
      self.postMessage({ type: "pageResult", pageIndex: data.pageIndex, boxes });
      return;
    }
    if (data.type === "det") {
      const boxes = await detOnly(new Uint8ClampedArray(data.rgba), data.width, data.height);
      self.postMessage({ type: "detResult", id: data.id, boxes });
      return;
    }
    if (data.type === "recBatch") {
      const pixels = new Uint8ClampedArray(data.rgba);
      const boxes = await recBoxes(pixels, data.width, data.height, data.boxes);
      self.postMessage({ type: "recResult", id: data.id, boxes });
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message: msg });
  }
};

/** Tilt below this (in degrees) → hybrid mode uses a sharp direct copy. */
const CROP_AUTO_TILT_DEG = 1.5;

/** Axis-aligned bounds of a quad [TL,TR,BR,BL] in pixel coords. */
function aabbOfQuad(q: number[]): { x: number; y: number; w: number; h: number } {
  let minX = q[0], minY = q[1], maxX = q[0], maxY = q[1];
  for (let i = 2; i < q.length; i += 2) {
    if (q[i] < minX) minX = q[i];
    if (q[i] > maxX) maxX = q[i];
    if (q[i + 1] < minY) minY = q[i + 1];
    if (q[i + 1] > maxY) maxY = q[i + 1];
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Acute angle (0..90°) of the quad's long axis from horizontal. */
function longAxisTiltDeg(q: number[]): number {
  const l1 = Math.hypot(q[2] - q[0], q[3] - q[1]); // TL→TR
  const l2 = Math.hypot(q[6] - q[0], q[7] - q[1]); // TL→BL
  const lx = l1 >= l2 ? 2 : 6; // long-axis end point index (x/y pair)
  const deg = Math.abs(Math.atan2(q[lx + 1] - q[1], q[lx] - q[0])) * 180 / Math.PI;
  return Math.min(deg, 180 - deg);
}

async function runPage(msg: WorkerPage): Promise<OCRBox[]> {
  const pixels = new Uint8ClampedArray(msg.rgba);
  const raw = await detOnly(pixels, msg.width, msg.height);
  return recBoxes(pixels, msg.width, msg.height, raw);
}

/** 整页检测 → 返回带几何的框（text 为空），并做 nms 去重。单页并行第一阶段用。 */
async function detOnly(pixels: Uint8ClampedArray, w: number, h: number): Promise<OCRBox[]> {
  const pre = detPreprocess(pixels, w, h, opts.detLimitSideLen);
  const inputName = detSession!.inputNames[0];
  const detFeed = {
    [inputName]: new ort.Tensor("float32", pre.tensor, [1, 3, pre.resizedHeight, pre.resizedWidth]),
  };
  const detOut = await detSession!.run(detFeed);
  const outName = detSession!.outputNames[0];
  const t = detOut[outName];
  const [, , mapH, mapW] = t.dims as number[];
  const probMap = t.data as Float32Array;

  const detRes = detPostprocess(probMap, mapW, mapH, w, h, pre.scaleX, pre.scaleY, {
    thresh: opts.detThresh,
    boxThresh: opts.detBoxThresh,
    maxRotDeg: opts.maxRotDeg,
    cropMode: opts.cropMode,
  });

  return nmsBoxes(detRes.boxes.map((b) => ({ points: b.points.slice(), raw: b.raw, score: b.score, text: "" })));
}

/** 对给定框列表逐个裁剪+识别（不再 nms——detOnly 已做过）。单页并行第二阶段用。 */
async function recBoxes(pixels: Uint8ClampedArray, w: number, h: number, rawBoxes: OCRBox[]): Promise<OCRBox[]> {
  const boxes: OCRBox[] = [];
  const recName = recSession!.inputNames[0];
  for (const box of rawBoxes) {
    const q = box.points; // [TL, TR, BR, BL] — AABB (mode 0) or rotated quad (mode 1/2)
    const outW = Math.round(Math.hypot(q[2] - q[0], q[3] - q[1])); // TL→TR
    const outH = Math.round(Math.hypot(q[6] - q[0], q[7] - q[1])); // TL→BL
    if (outW < 2 || outH < 2) continue;

    // Pick the crop by cropMode:
    //   0 直立正文 — always AABB direct copy (sharp, 1.7.2); points ARE the AABB.
    //   1 倾斜正文 — always rectified cropQuad.
    //   2 复合方法 — axis-aligned → direct copy (sharp); genuinely tilted → rectify.
    let crop: Uint8ClampedArray, cw: number, ch: number;
    if (opts.cropMode === 0) {
      crop = cropRGBA(pixels, w, h, q[0], q[1], outW, outH);
      cw = outW; ch = outH;
    } else if (opts.cropMode === 1) {
      crop = cropQuad(pixels, w, h, q, outW, outH);
      cw = outW; ch = outH;
    } else {
      if (longAxisTiltDeg(q) <= CROP_AUTO_TILT_DEG) {
        const aabb = aabbOfQuad(q);
        if (aabb.w < 2 || aabb.h < 2) continue;
        crop = cropRGBA(pixels, w, h, aabb.x, aabb.y, aabb.w, aabb.h);
        cw = aabb.w; ch = aabb.h;
      } else {
        crop = cropQuad(pixels, w, h, q, outW, outH);
        cw = outW; ch = outH;
      }
    }

    const rp = recPreprocess(crop, cw, ch);
    const recFeed = {
      [recName]: new ort.Tensor("float32", rp.tensor, [1, 3, rp.height, rp.width]),
    };
    const recOut = await recSession!.run(recFeed);
    const ro = recSession!.outputNames[0];
    const rt = recOut[ro];
    const dims = rt.dims as number[];
    const text = recDecode(rt.data as Float32Array, dims[1], dims[2], charDict.slice());
    if (isGarbageText(text)) continue;
    boxes.push({ points: box.points.slice(), raw: box.raw, score: box.score, text });
  }
  return boxes;
}