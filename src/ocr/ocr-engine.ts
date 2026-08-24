/**
 * OCR engine — the execution layer that runs the PP-OCRv4 det+rec pipeline
 * over a PDF's rendered pages.
 *
 * The heavy inference is executed inside a Web Worker (WorkerClient) so the
 * Zotero main thread stays responsive while a page is being processed —
 * the main thread only renders pages (pdfjs) and reassembles the PDF.
 */
import { fetchModelAssets } from "./models";
import { WorkerClient } from "./worker-client";
import { OCRResult, OCRPageResult, PageRenderer } from "./types";

export interface OcrProgressSink {
  (info: { stage: string; percent: number; message?: string }): void;
}

export type OcrOptions = {
  /** det probability threshold (default 0.3) */
  detThresh?: number;
  /** det box score threshold (default 0.4) */
  detBoxThresh?: number;
  /**
   * Max det side length (default 1536). 512 在 A4@144DPI 下把正文压到 ~6px，
   * 检测框回原图后错位；1536 保小字（脚注/斜体），WASM 下再高收益变薄。
   */
  detLimitSideLen?: number;
  /** abort when this becomes true */
  isCancelled?: () => boolean;
  /** progress callback */
  onProgress?: OcrProgressSink;
};

export class OcrEngine {
  private renderer: PageRenderer;
  private options: OcrOptions;
  private client: WorkerClient | null = null;
  private aborted = false;

  constructor(renderer: PageRenderer, options: OcrOptions = {}) {
    this.renderer = renderer;
    this.options = options;
  }

  private cancelled(): boolean {
    return this.aborted || !!this.options.isCancelled?.();
  }

  /** Run OCR on every page of `renderer`. Returns the page results. */
  async run(): Promise<OCRResult> {
    const { detThresh = 0.3, detBoxThresh = 0.4, detLimitSideLen = 1536, onProgress } = this.options;
    const pageCount = this.renderer.pageCount;
    const pages: OCRPageResult[] = [];
    if (this.cancelled()) throw new Error("OCR cancelled");

    // 1. Fetch model bytes and spin up the worker (model compile happens
    //    inside the worker thread — the UI stays responsive).
    const assets = await fetchModelAssets();
    if (this.cancelled()) throw new Error("OCR cancelled");
    // Firefox 不支持 `new Worker("jar:...")`；bootstrap.js 已注册
    // resource://pdfocrforzotero/ → rootURI，worker 脚本从这个 URL 加载。
    const workerUrl = "resource://pdfocrforzotero/content/scripts/ocr-worker.js";
    this.client = WorkerClient.open(workerUrl);
    try {
      if (this.cancelled()) throw new Error("OCR cancelled");
      await this.client.init(assets, { detLimitSideLen, detThresh, detBoxThresh });
      if (this.cancelled()) throw new Error("OCR cancelled");
      this.client.onError((message) => {
        // surface async worker errors (e.g. mid-run crash) via progress/log
        onProgress?.({ stage: "worker-error", percent: -1, message });
      });

      // 2. Per-page loop: render on main thread (fast), infer in worker.
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        if (this.cancelled()) throw new Error("OCR cancelled");
        const pagePct = (pageIndex / pageCount) * 100;

        onProgress?.({ stage: "render", percent: pagePct, message: `OCR 第 ${pageIndex + 1}/${pageCount} 页…` });

        const img = await this.renderer.renderPage(pageIndex);
        if (this.cancelled()) throw new Error("OCR cancelled");

        // Transfer the rendered RGBA buffer to the worker (zero-copy).
        const boxes = await this.client.processPage(pageIndex, img.width, img.height, img.data.buffer as ArrayBuffer);
        if (this.cancelled()) throw new Error("OCR cancelled");

        pages.push({
          pageIndex,
          pageWidth: img.width,
          pageHeight: img.height,
          pageWidthPoints: img.widthPoints,
          pageHeightPoints: img.heightPoints,
          boxes,
        });

        onProgress?.({
          stage: "done-page",
          percent: ((pageIndex + 1) / pageCount) * 100,
          message: `第 ${pageIndex + 1} 页完成 (${boxes.length} 个文本框)`,
        });
      }
    } finally {
      this.client?.terminate();
      this.client = null;
    }

    return { pages };
  }

  /** Abort the in-flight page (unblocks processPage; worker is killed). */
  cancel(): void {
    this.aborted = true;
    this.client?.cancel();
  }

  /** Release resources. */
  dispose(): void {
    this.renderer.dispose();
    if (this.client) {
      this.client.terminate();
      this.client = null;
    }
  }
}