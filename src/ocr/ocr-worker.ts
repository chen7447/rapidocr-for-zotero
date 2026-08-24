/**
 * OCR Web Worker — runs the whole PP-OCRv4 det+rec inference off the
 * main thread so the Zotero UI stays responsive while a page is being
 * processed (each page takes seconds on a laptop CPU).
 *
 * Protocol (postMessage):
 *   main → worker:
 *     { type: "init", wasm: ArrayBuffer, det: ArrayBuffer, rec: ArrayBuffer,
 *       dict: string[],
 *       detLimitSideLen: number, detThresh: number, detBoxThresh: number }
 *     { type: "page", pageIndex: number, width: number, height: number,
 *       rgba: ArrayBuffer }   // rgba is transferred (zero-copy)
 *   worker → main:
 *     { type: "ready" }
 *     { type: "pageResult", pageIndex: number, boxes: OCRBox[] }
 *     { type: "error", message: string }
 *
 * This module is bundled into its own iife file (ocr-worker.js) by esbuild;
 * it must not import anything that references Zotero / DOM (it only imports
 * the pure-JS preprocess/postprocess modules and onnxruntime-web).
 */
import * as ort from "onnxruntime-web";
import { detPreprocess, recPreprocess, cropRGBA } from "./preprocess";
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
}

interface WorkerPage {
  type: "page";
  pageIndex: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let charDict: string[] = [];
let opts = { detLimitSideLen: 1536, detThresh: 0.3, detBoxThresh: 0.4 };

self.onmessage = async (ev: MessageEvent) => {
  const data = ev.data as WorkerInit | WorkerPage;
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
      opts = { detLimitSideLen: data.detLimitSideLen, detThresh: data.detThresh, detBoxThresh: data.detBoxThresh };
      self.postMessage({ type: "ready" });
      return;
    }
    if (data.type === "page") {
      const boxes = await runPage(data);
      self.postMessage({ type: "pageResult", pageIndex: data.pageIndex, boxes });
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message: msg });
  }
};

async function runPage(msg: WorkerPage): Promise<OCRBox[]> {
  const pixels = new Uint8ClampedArray(msg.rgba);
  const w = msg.width;
  const h = msg.height;

  // ── det ──
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
  });

  // ── rec ──
  const boxes: OCRBox[] = [];
  const recName = recSession!.inputNames[0];
  for (const box of detRes.boxes) {
    const bx = box.points[0], by = box.points[1];
    const bw = box.points[2] - bx, bh = box.points[5] - by;
    if (bw < 2 || bh < 2) continue;

    const crop = cropRGBA(pixels, w, h, bx, by, bw, bh);
    const rp = recPreprocess(crop, bw, bh);
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
  return nmsBoxes(boxes);
}