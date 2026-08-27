/**
 * OCR engine — the execution layer that runs the PP-OCRv4 det+rec pipeline
 * over a PDF's rendered pages.
 *
 * The heavy inference runs in a pool of Web Workers (WorkerClient), one per
 * partition of pages. Each worker is a single-threaded WASM instance, so
 * running several in parallel uses multiple cores WITHOUT needing
 * SharedArrayBuffer (which Zotero's sandbox does not provide). The main
 * thread only renders pages (pdfjs) and reassembles the PDF.
 */
import { fetchModelAssets } from "./models";
import { WorkerClient } from "./worker-client";
import { OCRResult, OCRPageResult, PageRenderer, OCRBox } from "./types";

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
  /** 长轴与水平夹角超过该角度的框（斜水印/旋转文字）直接丢弃（默认 30） */
  maxRotDeg?: number;
  /** 0=直立正文(1.7.2直接裁剪) 1=倾斜正文(恒旋转矫正) 2=复合方法(默认) */
  cropMode?: number;
  /** 并行 worker 数（默认 4）。多页→页级并行；单页→页内按文本框并行。 */
  workers?: number;
  /** abort when this becomes true */
  isCancelled?: () => boolean;
  /** progress callback */
  onProgress?: OcrProgressSink;
  /** 0-based page indexes; omit = all pages */
  pageIndexes?: number[];
};

export class OcrEngine {
  private renderer: PageRenderer;
  private options: OcrOptions;
  private clients: WorkerClient[] = [];
  private aborted = false;

  constructor(renderer: PageRenderer, options: OcrOptions = {}) {
    this.renderer = renderer;
    this.options = options;
  }

  private cancelled(): boolean {
    return this.aborted || !!this.options.isCancelled?.();
  }

  /** Run OCR on selected pages of `renderer` (all pages if `pageIndexes` omitted). */
  async run(): Promise<OCRResult> {
    const { detThresh = 0.3, detBoxThresh = 0.4, detLimitSideLen = 1536, maxRotDeg = 30, cropMode = 2, workers = 4, onProgress, pageIndexes } = this.options;
    const pageCount = this.renderer.pageCount;
    const indexes = resolvePageIndexes(pageCount, pageIndexes);
    if (!indexes.length) throw new Error("No pages to OCR");
    if (this.cancelled()) throw new Error("OCR cancelled");

    const workerUrl = "resource://pdfocrforzotero/content/scripts/ocr-worker.js";
    const targetN = Math.max(1, workers | 0);
    // 单页 → 页内按文本框并行（det 单核出框 → rec 多核并行，每核 ⌈x/n⌉ 个框）；
    // 多页 → 页级并行（worker 数不超过页数）。
    const singlePage = indexes.length === 1;
    const n = singlePage ? Math.min(targetN, 8) : Math.min(targetN, indexes.length);
    const chunks = singlePage ? [] : partitionChunks(indexes, n);

    if (!this.cancelled()) {
      // 前置阶段：先报页数与核数分配，再进逐页进度。计时器(1) 从 alloc 起算。
      onProgress?.({ stage: "parse", percent: 0, message: `解析PDF页数为 ${pageCount} 页` });
      if (!singlePage) {
        onProgress?.({ stage: "alloc", percent: 0, message: `已分配 ${n} 核数，每核OCR数为 ${Math.ceil(indexes.length / n)}（向上取整）` });
      }
    }

    try {
      // 并行打开并初始化所有 worker：模型编译在各 worker 自己的线程里同时进行。
      // （串行初始化会让 N 个 worker 的编译时间线性叠加，吃掉小文档的并行收益）
      await Promise.all(Array.from({ length: n }, async () => {
        if (this.cancelled()) throw new Error("OCR cancelled");
        const client = WorkerClient.open(workerUrl);
        this.clients.push(client); // 同步 push，顺序与 worker 下标一致
        // 每个 worker 各自 fetch 模型字节：init 会 transfer（detach 主线程那份），不能共用
        const assets = await fetchModelAssets();
        await client.init(assets, { detLimitSideLen, detThresh, detBoxThresh, maxRotDeg, cropMode });
        client.onError((message) => onProgress?.({ stage: "worker-error", percent: -1, message }));
      }));
      if (this.cancelled()) throw new Error("OCR cancelled");

      if (singlePage) {
        return await this.runSinglePage(indexes[0], n, onProgress);
      }

      const total = indexes.length;
      let done = 0;
      const results: OCRPageResult[] = [];
      // 各 chunk 并发跑：主线程渲染在 await 间隙交错喂页，推理在 N 个 worker 里并行
      await Promise.all(chunks.map((chunk, k) =>
        this.runChunk(this.clients[k], chunk, onProgress, total, () => ++done, results),
      ));
      results.sort((a, b) => a.pageIndex - b.pageIndex);
      return { pages: results };
    } finally {
      for (const c of this.clients) c.terminate();
      this.clients = [];
    }
  }

  /**
   * 单页 OCR：整页 det 一次（1 核）得 x 个框，再按 k=⌈x/n⌉ 连续分组，
   * n 个 worker 并行 rec。进度按「文本框」计。
   */
  private async runSinglePage(pageIndex: number, n: number, onProgress?: OcrProgressSink): Promise<OCRResult> {
    const img = await this.renderer.renderPage(pageIndex);
    if (this.cancelled()) throw new Error("OCR cancelled");

    onProgress?.({ stage: "det", percent: 0, message: "整页检测文本框…" });

    // det 会 transfer 主线程的 buffer，故先为每个 worker 复制一份 rec 用像素
    const detBuf = img.data.buffer as ArrayBuffer;
    const recBufs = this.clients.map(() => new Uint8Array(img.data).buffer as ArrayBuffer);
    const raw = await this.clients[0].detPage(img.width, img.height, detBuf);
    if (this.cancelled()) throw new Error("OCR cancelled");

    const page = {
      pageIndex,
      pageWidth: img.width,
      pageHeight: img.height,
      pageWidthPoints: img.widthPoints,
      pageHeightPoints: img.heightPoints,
    };
    const x = raw.length;
    if (x === 0) {
      return { pages: [{ ...page, boxes: [] }] };
    }

    const k = Math.ceil(x / n); // 每核框数（向上取整）
    onProgress?.({ stage: "alloc", percent: 0, message: `已分配 ${n} 核数，每核识别 ${k} 个文本框（共 ${x} 个，向上取整）` });

    // 连续分组：核 g 负责 [g*k, min((g+1)*k, x))，末核可能更少
    const groups: OCRBox[][] = [];
    for (let g = 0; g < n; g++) groups.push(raw.slice(g * k, Math.min((g + 1) * k, x)));

    let done = 0;
    const recChunks = await Promise.all(groups.map(async (group, g) => {
      if (group.length === 0) return [] as OCRBox[];
      if (this.cancelled()) throw new Error("OCR cancelled");
      const boxes = await this.clients[g].recBatch(img.width, img.height, recBufs[g], group);
      done += group.length;
      onProgress?.({ stage: "done-box", percent: (done / x) * 100, message: `识别第 ${done}/${x} 个文本框…` });
      return boxes;
    }));

    // 连续分组 → 按组序拼接即还原阅读顺序（nms 已在 detOnly 做过）
    const boxes: OCRBox[] = [];
    for (const c of recChunks) boxes.push(...c);
    return { pages: [{ ...page, boxes }] };
  }

  private async runChunk(
    client: WorkerClient,
    chunk: number[],
    onProgress: OcrProgressSink | undefined,
    total: number,
    bumpDone: () => number,
    results: OCRPageResult[],
  ): Promise<void> {
    for (const pageIndex of chunk) {
      if (this.cancelled()) throw new Error("OCR cancelled");
      const img = await this.renderer.renderPage(pageIndex);
      if (this.cancelled()) throw new Error("OCR cancelled");
      // Transfer the rendered RGBA buffer to the worker (zero-copy).
      const boxes = await client.processPage(pageIndex, img.width, img.height, img.data.buffer as ArrayBuffer);
      if (this.cancelled()) throw new Error("OCR cancelled");
      results.push({
        pageIndex,
        pageWidth: img.width,
        pageHeight: img.height,
        pageWidthPoints: img.widthPoints,
        pageHeightPoints: img.heightPoints,
        boxes,
      });
      const done = bumpDone();
      onProgress?.({
        stage: "done-page",
        percent: (done / total) * 100,
        message: `第 ${pageIndex + 1} 页完成 (${boxes.length} 个文本框)（${done}/${total}）`,
      });
    }
  }

  /** Abort all in-flight workers (unblocks processPage; workers are killed). */
  cancel(): void {
    this.aborted = true;
    for (const c of this.clients) c.cancel();
  }

  /** Release resources. */
  dispose(): void {
    this.renderer.dispose();
    for (const c of this.clients) c.terminate();
    this.clients = [];
  }
}

/** Unique sorted 0-based indexes in range. Empty `pageIndexes` = all pages. */
export function resolvePageIndexes(pageCount: number, pageIndexes?: number[]): number[] {
  if (!pageIndexes) return Array.from({ length: pageCount }, (_, i) => i);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of pageIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount || seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Round-robin the sorted indexes across n buckets (balances load by page). */
function partitionChunks(indexes: number[], n: number): number[][] {
  const chunks: number[][] = Array.from({ length: n }, () => []);
  indexes.forEach((p, i) => chunks[i % n].push(p));
  return chunks.filter((c) => c.length > 0);
}
