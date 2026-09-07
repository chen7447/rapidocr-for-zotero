/**
 * PageRenderer using the bundled pdfjs-dist (legacy build).
 *
 * The bootstrap sandbox (a plain loadSubScript scope) lacks EVERY Web/JS
 * global except what bootstrap.js explicitly injects — DOMMatrix,
 * DOMException, structuredClone, ReadableStream, ... pdfjs needs them all.
 * We copy the ones pdfjs actually uses from the main window via a FIXED
 * white-list. NEVER probe the window object dynamically: reading arbitrary
 * window property values (e.g. ZoteroPane, messageManager) can block the
 * main thread and freeze the whole app.
 */
import { PageRenderer, PageImage } from "./types";
import { debugLog } from "../debug-log";

/**
 * 逐句排查日志,默认关闭(extensions.zotero.pdfocrforzotero.debug)。
 * 动态读 pref:改动立即生效,无需重启。错误路径日志不走这里,始终输出。
 */
function dbg(msg: string): void {
  try {
    if (!Zotero.Prefs.get("pdfocrforzotero.debug")) return;
  } catch {
    return;
  }
  const s = `PDF OCR v3 renderer: ${msg}`;
  debugLog.log(s);
  Zotero.debug(s);
}

/** Web/JS globals pdfjs-dist operates with (its legacy build also runs in Node). */
const PDFJS_GLOBALS = [
  "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams",
  "Blob", "File",
  "Headers", "Request", "Response", "fetch", "FormData",
  "XMLHttpRequest",
  "AbortController", "AbortSignal",
  "ReadableStream", "WritableStream", "TransformStream",
  "ByteLengthQueuingStrategy", "CountQueuingStrategy",
  "Event", "CustomEvent", "EventTarget",
  "MessageChannel", "MessagePort", "MessageEvent",
  "BroadcastChannel",
  "DOMException",
  "DOMMatrix", "DOMPoint", "DOMRect", "DOMQuad",
  "Path2D", "OffscreenCanvas", "ImageData", "ImageBitmap",
  "DOMParser", "XMLSerializer",
  "structuredClone", "atob", "btoa", "queueMicrotask",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "crypto",
  "CompressionStream", "DecompressionStream",
] as const;

/** Copy the fixed white-list from the main window into the sandbox. */
function ensurePDFjsGlobals(): void {
  const win = Zotero.getMainWindow();
  const sandbox = globalThis as any;
  for (const name of PDFJS_GLOBALS) {
    if (sandbox[name] !== undefined) continue;
    try {
      const value = (win as any)[name];
      if (value !== undefined) sandbox[name] = value;
    } catch {
      /* skip unavailable globals */
    }
  }
}

export class ZoteroPageRenderer implements PageRenderer {
  private doc: any = null;
  pageCount = 0;

  /** Load a PDF from its file path using bundled pdfjs-dist. */
  async load(path: string): Promise<void> {
    dbg("load() start");
    ensurePDFjsGlobals();
    dbg("globals ok");
    // Both imports are bundled by esbuild (no runtime module loader — the
    // sandbox has no ScriptLoader for jar: URLs). The worker module sets
    // globalThis.pdfjsWorker as a side effect; pdfjs's fake-worker setup
    // finds it there and never attempts a runtime import(workerSrc).
    await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    dbg("imports ok");
    const pdfjsLib = (globalThis as any).pdfjsLib;
    dbg("pdfjsLib getter ok");
    // Safety net: set the worker URL to the bundled worker file in the XPI
    // (only used if the main-thread WorkerMessageHandler is unavailable).
    // resource:// 才能被 Worker / fetch 稳定打开;jar: 的 workerSrc 在 Firefox 里会静默掉回假 worker。
    pdfjsLib.GlobalWorkerOptions.workerSrc = "resource://pdfocrforzotero/content/scripts/pdf.worker.mjs";
    dbg("workerSrc set, typeof IOUtils=" + typeof IOUtils);
    // 读文件用 IOUtils.read(异步,不阻塞主线程)
    let data: Uint8Array;
    try {
      dbg("IOUtils.read path=" + path);
      data = await IOUtils.read(path);
      dbg("IOUtils.read ok, len=" + data.length);
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      const s = "PDF OCR: IOUtils.read FAILED: " + msg;
      debugLog.log(s);
      Zotero.debug(s);
      throw readErr;
    }
    // pdfjs's FontLoader and CanvasFactory need a document to create
    // style elements and canvases. Use the main window's document.
    const win = Zotero.getMainWindow();
    // 探测 wasm 解码器是否真正可取到：pdf.js 解码失败只打 console warning,
    // 不报错,白布式失败无声。取不到 wasm 时这里先暴露,而不是等整页 det=0。
    try {
      const r = await fetch("resource://pdfocrforzotero/content/scripts/jbig2.wasm");
      dbg("wasm probe: " + r.status + " bytes=" + ((await r.arrayBuffer()).byteLength));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debugLog.log("PDF OCR v3 renderer: wasm probe FAILED: " + msg);
      Zotero.debug("PDF OCR v3 renderer: wasm probe FAILED: " + msg);
    }
    dbg("getDocument...");
    // 插件其余资源(模型/字体)都用 fetch(resource://) 成功过。pdf.js 默认工厂
    // 对非 http(s) 走 XMLHttpRequest,沙箱原先没有 XHR → CCITT/JBIG2 解码失败、页白。
    const wasmUrl = "resource://pdfocrforzotero/content/scripts/";
    class FetchBinaryDataFactory {
      cMapUrl = "";
      standardFontDataUrl = "";
      wasmUrl = "";
      constructor(opts: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
        this.cMapUrl = opts.cMapUrl ?? "";
        this.standardFontDataUrl = opts.standardFontDataUrl ?? "";
        this.wasmUrl = opts.wasmUrl ?? "";
      }
      async fetch({ kind, filename }: { kind: string; filename: string }) {
        const base = kind === "wasmUrl" ? this.wasmUrl
          : kind === "cMapUrl" ? this.cMapUrl
          : kind === "standardFontDataUrl" ? this.standardFontDataUrl
          : "";
        if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
        const url = `${base}${filename}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Unable to load ${kind} at: ${url} (${resp.status})`);
        return new Uint8Array(await resp.arrayBuffer());
      }
    }
    const loadingTask = pdfjsLib.getDocument({
      data,
      ownerDocument: win.document,
      wasmUrl,
      BinaryDataFactory: FetchBinaryDataFactory,
    });
    dbg("waiting for loadingTask.promise...");
    this.doc = await loadingTask.promise;
    dbg("loaded, numPages=" + this.doc.numPages);
    this.pageCount = this.doc.numPages;
  }

  async renderPage(index: number, scale = 2.0): Promise<PageImage> {
    if (!this.doc) throw new Error("No PDF loaded — call load() first");
    dbg("renderPage(" + index + "," + scale + ") start");

    const page = await this.doc.getPage(index + 1); // pdf.js is 1-based
    dbg("getPage ok");
    const viewport = page.getViewport({ scale }); // 默认 144 DPI (2×72);b59 抢救用 4×
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const widthPoints = viewport.viewBox?.[2] ?? page.getViewport({ scale: 1.0 }).width;
    const heightPoints = viewport.viewBox?.[3] ?? page.getViewport({ scale: 1.0 }).height;
    dbg("viewport " + w + "x" + h);

    // Use the main window's document for canvas creation
    const win = Zotero.getMainWindow();
    const canvas: any = win.document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d") as any;
    dbg("canvas created, page.render...");
    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    dbg("render done");

    const imageData = ctx.getImageData(0, 0, w, h);
    // Copy out of the window's DOM into our sandbox
    const data = new Uint8ClampedArray(imageData.data);
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
    }
    dbg(`imageData copied ${w}x${h} nonWhite=${nonWhite}/${w * h}`);
    if (nonWhite === 0) {
      const s = `PDF OCR v3 renderer: page ${index + 1} render is blank (${w}x${h})`;
      debugLog.log(s);
      Zotero.debug(s);
    }

    canvas.remove();
    page.cleanup();

    return { data, width: w, height: h, widthPoints, heightPoints };
  }

  dispose(): void {
    if (this.doc) {
      try { this.doc.destroy(); } catch {}
      this.doc = null;
    }
  }
}