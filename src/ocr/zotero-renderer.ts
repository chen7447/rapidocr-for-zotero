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

/** Web/JS globals pdfjs-dist operates with (its legacy build also runs in Node). */
const PDFJS_GLOBALS = [
  "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams",
  "Blob", "File",
  "Headers", "Request", "Response", "fetch", "FormData",
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

/** Copy the fixed white-list from the main window into the sandbox (once). */
function ensurePDFjsGlobals(): void {
  if (typeof (globalThis as any).DOMMatrix !== "undefined") return;
  const win = Zotero.getMainWindow();
  const sandbox = globalThis as any;
  for (const name of PDFJS_GLOBALS) {
    if (sandbox[name] !== undefined) continue; // already available
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
    Zotero.debug("PDF OCR: load() start");
    ensurePDFjsGlobals();
    Zotero.debug("PDF OCR: globals ok");
    // Both imports are bundled by esbuild (no runtime module loader — the
    // sandbox has no ScriptLoader for jar: URLs). The worker module sets
    // globalThis.pdfjsWorker as a side effect; pdfjs's fake-worker setup
    // finds it there and never attempts a runtime import(workerSrc).
    await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    Zotero.debug("PDF OCR: imports ok");
    const pdfjsLib = (globalThis as any).pdfjsLib;
    Zotero.debug("PDF OCR: pdfjsLib getter ok");
    // Safety net: set the worker URL to the bundled worker file in the XPI
    // (only used if the main-thread WorkerMessageHandler is unavailable).
    pdfjsLib.GlobalWorkerOptions.workerSrc = addonRoot + "content/scripts/pdf.worker.mjs";
    Zotero.debug("PDF OCR: workerSrc set, typeof IOUtils=" + typeof IOUtils);
    // 读文件用 IOUtils.read（异步，不阻塞主线程）
    let data: Uint8Array;
    try {
      Zotero.debug("PDF OCR: IOUtils.read path=" + path);
      data = await IOUtils.read(path);
      Zotero.debug("PDF OCR: IOUtils.read ok, len=" + data.length);
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      Zotero.debug("PDF OCR: IOUtils.read FAILED: " + msg);
      throw readErr;
    }
    // pdfjs's FontLoader and CanvasFactory need a document to create
    // style elements and canvases. Use the main window's document.
    const win = Zotero.getMainWindow();
    Zotero.debug("PDF OCR: getDocument...");
    const loadingTask = pdfjsLib.getDocument({ data, ownerDocument: win.document });
    Zotero.debug("PDF OCR: waiting for loadingTask.promise...");
    this.doc = await loadingTask.promise;
    Zotero.debug("PDF OCR: loaded, numPages=" + this.doc.numPages);
    this.pageCount = this.doc.numPages;
  }

  async renderPage(index: number): Promise<PageImage> {
    if (!this.doc) throw new Error("No PDF loaded — call load() first");
    Zotero.debug("PDF OCR: renderPage(" + index + ") start");

    const page = await this.doc.getPage(index + 1); // pdf.js is 1-based
    Zotero.debug("PDF OCR: getPage ok");
    const viewport = page.getViewport({ scale: 2.0 }); // 144 DPI (2×72)
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const widthPoints = viewport.viewBox?.[2] ?? page.getViewport({ scale: 1.0 }).width;
    const heightPoints = viewport.viewBox?.[3] ?? page.getViewport({ scale: 1.0 }).height;
    Zotero.debug("PDF OCR: viewport " + w + "x" + h);

    // Use the main window's document for canvas creation
    const win = Zotero.getMainWindow();
    const canvas: any = win.document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d") as any;
    Zotero.debug("PDF OCR: canvas created, page.render...");
    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    Zotero.debug("PDF OCR: render done");

    const imageData = ctx.getImageData(0, 0, w, h);
    // Copy out of the window's DOM into our sandbox
    const data = new Uint8ClampedArray(imageData.data);
    Zotero.debug("PDF OCR: imageData copied");

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