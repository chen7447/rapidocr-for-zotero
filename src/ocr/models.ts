// src/ocr/models.ts
// Model byte loading for the OCR Web Worker. The worker compiles the ONNX
// models itself; this module only fetches raw bytes from the XPI.
// Character table is loaded from ppocr_keys_v1.txt (PaddleOCR standard).

import type { OCRModelAssets } from "./worker-client";

/**
 * Load a model binary from the XPI via addonRoot URI.
 * fetch() is available in Zotero's bootstrap sandbox (Firefox 128+ chrome context).
 */
async function fetchBytes(name: string): Promise<Uint8Array> {
  const url = addonRoot + "content/models/" + name;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function fetchText(name: string): Promise<string> {
  const url = addonRoot + "content/models/" + name;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return await resp.text();
}

/**
 * Read the character dictionary from the PaddleOCR keys file.
 * The file has 6623 lines; PP-OCR's CTCLabelDecode then inserts "blank" at
 * index 0 and a space at the end → 6625 entries, matching the rec model's
 * output classes (6625). Replicate that so argmax indices map correctly.
 */
async function loadCharacterDict(): Promise<string[]> {
  const text = await fetchText("ppocr_keys_v1.txt");
  const chars = text.split("\n");
  chars.unshift("blank"); // index 0 = CTC blank
  chars.push(" ");        // last index = space
  return chars;
}

/**
 * Fetch all model + wasm bytes WITHOUT compiling them. The OCR engine
 * transfers these bytes into a Web Worker (zero-copy) so inference never
 * blocks the main thread.
 *
 * The character dictionary is prepared exactly like PaddleOCR's CTCLabelDecode
 * (blank prepended, space appended) so worker-side decoding matches.
 */
export async function fetchModelAssets(): Promise<OCRModelAssets> {
  // wasm 二进制打包在 content/scripts/（与主 bundle 同目录）；模型在 content/models/
  const wasmResp = await fetch(addonRoot + "content/scripts/ort-wasm-simd-threaded.jsep.wasm");
  if (!wasmResp.ok) throw new Error(`HTTP ${wasmResp.status}: wasm`);
  const wasm = await wasmResp.arrayBuffer();

  const [det, rec, characterDict] = await Promise.all([
    fetchBytes("ch_PP-OCRv4_det_infer.onnx"),
    fetchBytes("ch_PP-OCRv4_rec_infer.onnx"),
    loadCharacterDict(),
  ]);

  return {
    wasm,
    det: det.buffer as ArrayBuffer,
    rec: rec.buffer as ArrayBuffer,
    dict: characterDict,
  };
}