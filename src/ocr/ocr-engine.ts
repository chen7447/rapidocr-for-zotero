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
import { frameClaimingLine, frameReadingOrder, lowDensityLine, orderBoxes, readingOrder, scaleBox, stackedOrder } from "./postprocess";
import { showStageOverlay, type StageMark } from "./stage-overlay";
import { debugLog } from "../debug-log";
import { WorkerClient } from "./worker-client";
import { OCRResult, OCRPageResult, PageRenderer, OCRBox } from "./types";
import { t } from "../locale";

export interface OcrProgressSink {
  (info: { stage: string; percent: number; message?: string }): void;
}

export type OcrOptions = {
  /** det probability threshold (default 0.3) */
  detThresh?: number;
  /** det box score threshold (default 0.4) */
  detBoxThresh?: number;
  /**
   * Max det side length (default 1536). 512 在 A4@144DPI 下把正文压到 ~6px,
   * 检测框回原图后错位;1536 保小字(脚注/斜体),WASM 下再高收益变薄。
   */
  detLimitSideLen?: number;
  /** 长轴与水平夹角超过该角度的框(斜水印/旋转文字)直接丢弃(默认 30) */
  maxRotDeg?: number;
  /** 0=直立正文(1.7.2直接裁剪) 1=倾斜正文(恒旋转矫正) 2=复合方法(默认) */
  cropMode?: number;
  /** 并行 worker 数(默认 4)。多页→页级并行;单页→页内按文本框并行。 */
  workers?: number;
  /** abort when this becomes true */
  isCancelled?: () => boolean;
  /** progress callback */
  onProgress?: OcrProgressSink;
  /** 0-based page indexes; omit = all pages */
  pageIndexes?: number[];
  /** 手绘框(选择区域)区域,PDF points,top-left/y-down/scale-1。命中某页时改为按框裁剪独立 OCR。 */
  regions?: Array<{ pageIndex: number; x1: number; y1: number; x2: number; y2: number }>;
  /** 双栏版面:b56 起同时决定圈间阅读序(横贯带切区,区内先左栏后右栏);不勾=圈按 y→x。 */
  twoColumn?: boolean;
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
    const { detThresh = 0.3, detBoxThresh = 0.4, detLimitSideLen = 1536, maxRotDeg = 30, cropMode = 2, workers = 4, onProgress, pageIndexes, regions, twoColumn } = this.options;
    const pageCount = this.renderer.pageCount;
    const indexes = resolvePageIndexes(pageCount, pageIndexes);
    if (!indexes.length) throw new Error("No pages to OCR");
    if (this.cancelled()) throw new Error("OCR cancelled");

    const workerUrl = "resource://pdfocrforzotero/content/scripts/ocr-worker.js";
    const targetN = Math.max(1, workers | 0);
    // 单页 → 页内按文本框并行(det 单核出框 → rec 多核并行,每核 ⌈x/n⌉ 个框);
    // 多页 → 页级并行(worker 数不超过页数)。
    const singlePage = indexes.length === 1;
    const n = singlePage ? Math.min(targetN, 8) : Math.min(targetN, indexes.length);
    const chunks = singlePage ? [] : partitionChunks(indexes, n);

    if (!this.cancelled()) {
      // 前置阶段:先报页数与核数分配,再进逐页进度。计时器(1) 从 alloc 起算。
      onProgress?.({ stage: "parse", percent: 0, message: t("engine.pages", { n: pageCount }) });
      if (!singlePage) {
        onProgress?.({ stage: "alloc", percent: 0, message: t("engine.allocPages", { n, k: Math.ceil(indexes.length / n) }) });
      }
    }

    try {
      // 模型字节只取一次(原来每个 worker 各 fetch 一遍 ~28MB);
      // init 会 transfer(detach 主线程那份),所以每个 worker 发独立副本。
      // 母本留在本次 run 的作用域内 —— 跨任务缓存留给 v1.10 的常驻池决策。
      const assets = await fetchModelAssets();
      // 并行打开并初始化所有 worker:模型编译在各 worker 自己的线程里同时进行。
      // (串行初始化会让 N 个 worker 的编译时间线性叠加,吃掉小文档的并行收益)
      await Promise.all(Array.from({ length: n }, async () => {
        if (this.cancelled()) throw new Error("OCR cancelled");
        const client = WorkerClient.open(workerUrl);
        this.clients.push(client); // 同步 push,顺序与 worker 下标一致
        await client.init(
          {
            wasm: assets.wasm.slice(0),
            det: assets.det.slice(0),
            rec: assets.rec.slice(0),
            dict: assets.dict, // 结构化克隆本身拷贝;worker 侧还有 slice()
          },
          { detLimitSideLen, detThresh, detBoxThresh, maxRotDeg, cropMode },
        );
        client.onError((message) => onProgress?.({ stage: "worker-error", percent: -1, message }));
      }));
      if (this.cancelled()) throw new Error("OCR cancelled");

      if (singlePage) {
        return await this.runSinglePage(indexes[0], n, onProgress, regions, twoColumn);
      }

      const total = indexes.length;
      let done = 0;
      const results: OCRPageResult[] = [];
      // 各 chunk 并发跑:主线程渲染在 await 间隙交错喂页,推理在 N 个 worker 里并行
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
   * 单页 OCR:整页 det 一次(1 核)得 x 个框,再按 k=⌈x/n⌉ 连续分组,
   * n 个 worker 并行 rec。进度按「文本框」计。
   */
  private async runSinglePage(
    pageIndex: number,
    n: number,
    onProgress?: OcrProgressSink,
    regions?: Array<{ pageIndex: number; x1: number; y1: number; x2: number; y2: number }>,
    twoColumn?: boolean,
  ): Promise<OCRResult> {
    const img = await this.renderer.renderPage(pageIndex);
    if (this.cancelled()) throw new Error("OCR cancelled");

    // (b48 重构)圈选 = **先 det,再做减法**:整页 det 恰一次 → 被圈盖住≥一半长度的行留下 → 只 rec 留下的行
    // → 圈内按实测栏沟分堆、圈间按 y→x 排 → 写层。判定与写层共用 frameClaimingLine。
    // 旧写法另有一条「圈内裁图再 det+rec」的补漏通道(b27~b47):b46 实测它一页净新增 **0 行**
    // (输出全是 重复/被圈切/替换残行),只烧时间、只给顺序添噪,整条删除。
    const pageRegions = (regions ?? []).filter((r) => r.pageIndex === pageIndex);
    if ((regions ?? []).length && !pageRegions.length) {
      // 页级分治(b54):有圈的批次里,没画框的页不再是"跳过",而是落回整页识别,
      // 阅读序交给「双栏版面」(pdf-builder 的 hasRegions 按页判断,已天然支持)。
      debugLog.log(`region mode page ${pageIndex + 1}: no frames on this page → whole-page (双栏按选项)`);
    }
    if ((regions ?? []).length && pageRegions.length) {
      onProgress?.({ stage: "det", percent: 0, message: t("engine.detPage") });
      const scaleX = img.width / (img.widthPoints || img.width || 1);
      const scaleY = img.height / (img.heightPoints || img.height || 1);
      const pageHpt = img.heightPoints || img.height || 1; // 标注 y 用页底原点,翻转要页高_pt
      // 「选择区域」标注的 rects 是 **PDF 原生坐标:原点在页面左下角,y 向上**(b53 实证:
      // 同一框按"左上原点"解释会落在摘要下方第 2 节,按"左下原点"翻上去才是用户真画的
      // ABSTRACT+摘要+版权行,x 轴不需翻)。渲染像素从页顶往下量 → y' = 页高_pt − y。
      const rects = pageRegions.map((r) => ({
        x1: Math.max(0, Math.round(r.x1 * scaleX)),
        y1: Math.max(0, Math.round((pageHpt - r.y2) * scaleY)),
        x2: Math.min(img.width, Math.round(r.x2 * scaleX)),
        y2: Math.min(img.height, Math.round((pageHpt - r.y1) * scaleY)),
      })).filter((q) => q.x2 > q.x1 && q.y2 > q.y1);

      const src = new Uint8ClampedArray(img.data); // det 会 transfer 掉 img.data.buffer,rec 用这份源像素

      // 通道一:整页 det 恰一次。圈内行(≥半行覆盖)优先 rec+写;圈外行 b58 起同样 rec,
      // 按双栏/单栏序接在圈内后(补足)。圈只决定优先级,不再一刀切丢掉圈外。
      const raw = await this.clients[0].detPage(img.width, img.height, img.data.buffer as ArrayBuffer);
      if (this.cancelled()) throw new Error("OCR cancelled");
      const inAny = (b: OCRBox) => frameClaimingLine(b, rects);
      // 分阶段诊断(弹窗可读):det 归类 → 减法留下的行 → 最终写序
      const stage: string[] = [];
      const bb = (b: OCRBox): string => `${b.raw.x1},${b.raw.y1}~${b.raw.x2},${b.raw.y2}`;
      const keptDet: OCRBox[] = [];
      const outDet: OCRBox[] = []; // b58:圈外行不再丢弃——圈选=优先级,圈外整页补足接在圈内后
      const marks: StageMark[] = [];
      raw.forEach((b, i) => {
        const fi = inAny(b);
        if (fi >= 0) { keptDet.push(b); marks.push({ raw: b.raw, cls: "in" }); stage.push(`[det#${i}] ${bb(b)} →F${fi}`); return; }
        outDet.push(b);
        marks.push({ raw: b.raw, cls: "out" });
        stage.push(`[det#${i}] ${bb(b)} 圈外 → 补足(${twoColumn ? "双栏" : "单栏"}序)`);
      });
      const kept = keptDet.length;
      let recdAll: OCRBox[] = [];
      const recRun = async (boxes: OCRBox[]): Promise<OCRBox[]> => {
        if (!boxes.length) return [];
        const k = Math.ceil(boxes.length / n);
        const groups: OCRBox[][] = [];
        for (let g = 0; g < n; g++) groups.push(boxes.slice(g * k, Math.min((g + 1) * k, boxes.length)));
        const recChunks = await Promise.all(groups.map(async (group, g) => {
          if (group.length === 0) return [] as OCRBox[];
          if (this.cancelled()) throw new Error("OCR cancelled");
          return this.clients[g].recBatch(img.width, img.height, src.slice().buffer as ArrayBuffer, group);
        }));
        return recChunks.flat();
      };
      if (kept > 0) recdAll = await recRun(keptDet);
      let outBoxes: OCRBox[] = [];
      if (outDet.length) {
        outBoxes = await recRun(outDet);
        stage.push(`[补足] 圈外 ${outBoxes.length}/${outDet.length} 行已识别,按${twoColumn ? "双栏" : "单栏"}序接在圈内后`);
      }
      // 补读(b49):文本字符数明显撑不满框宽的行,99% 是 det 给的 quad 歪了/把行裁扁(实测
      // "Article history:" 出成 "e:";recBoxes 每框独立 batch=1,所以不是批内拉伸)。**候选行集合
      // 不变** —— 整页 det 仍只跑一次、圈仍是唯一减法,这里只把可疑框的 points 换成 AABB 重 rec,
      // 谁认出的字符多留谁;det 认领但 rec 交白卷的行也走这条路捞。ponytail: 每页最多 8 框。
      const recdBy = new Map<string, OCRBox>(recdAll.map((b) => [`${b.raw.x1},${b.raw.y1}`, b] as const));
      const suspect = keptDet.filter((b) => lowDensityLine(recdBy.get(`${b.raw.x1},${b.raw.y1}`) ?? b)).slice(0, 8);
      if (suspect.length) {
        if (this.cancelled()) throw new Error("OCR cancelled");
        const redo = suspect.map((b) => ({
          ...b, text: "",
          points: [b.raw.x1, b.raw.y1, b.raw.x2, b.raw.y1, b.raw.x2, b.raw.y2, b.raw.x1, b.raw.y2],
        }));
        const fixed = await this.clients[0].recBatch(img.width, img.height, src.slice().buffer as ArrayBuffer, redo);
        for (const f of fixed) {
          const want = (f.text || "").trim();
          if (!want) continue;
          const s = recdBy.get(`${f.raw.x1},${f.raw.y1}`);
          if (s) {
            if (want.length > (s.text || "").trim().length) {
              stage.push(`[补读] ${bb(f)} "${(s.text || "").trim()}"→"${want}"`);
              s.text = f.text;
            }
          } else {
            recdAll.push(f);
            stage.push(`[补读·捞回] ${bb(f)} "${want}"`);
          }
        }
      }
      // b59 高分辨率抢救:rec 交白卷的行多数是 ~8px 小字(斜体邮箱/DOI/脚注),6× 拉伸后
      // CTC 塌缩 —— 补读救不了"信息量不足"。这里按 4× 重渲染整页一次,未返回框 ×2 重裁
      // 重 rec(字形 16-18px,够读)。每页上限 8 框,仅当存在未返回行时才多渲一次。
      const missedKept = keptDet.filter((b) => !recdBy.has(`${b.raw.x1},${b.raw.y1}`));
      const outKeys = new Set<string>(outBoxes.map((b) => `${b.raw.x1},${b.raw.y1}`));
      const missedOut = outDet.filter((b) => !outKeys.has(`${b.raw.x1},${b.raw.y1}`));
      const rescue = [...missedKept, ...missedOut].slice(0, 8);
      if (rescue.length) {
        try {
          const hi = await this.renderer.renderPage(pageIndex, 4);
          const ratio = hi.width / img.width;
          // det 小框常切掉字母上下伸部:裁剪外扩(高±25%/宽±10%,夹页界),rec 自己会剪空白
          const pad = (b: OCRBox): OCRBox => {
            const mx = (b.raw.x2 - b.raw.x1) * 0.1, my = (b.raw.y2 - b.raw.y1) * 0.25;
            const x1 = Math.max(0, Math.round(b.raw.x1 - mx)), y1 = Math.max(0, Math.round(b.raw.y1 - my));
            const x2 = Math.min(img.width, Math.round(b.raw.x2 + mx)), y2 = Math.min(img.height, Math.round(b.raw.y2 + my));
            return { ...b, points: [x1, y1, x2, y1, x2, y2, x1, y2], raw: { x1, y1, x2, y2 } };
          };
          const padded = rescue.map(pad);
          const scaled = padded.map((b) => scaleBox(b, ratio));
          const fixed = await this.clients[0].recBatch(hi.width, hi.height, hi.data.buffer as ArrayBuffer, scaled);
          let saved = 0;
          for (const f of fixed) {
            // recBoxes 原样带回 box.raw → 用精确整数坐标回配,不吃浮点舍入
            const idx = scaled.findIndex((s) => s.raw.x1 === f.raw.x1 && s.raw.y1 === f.raw.y1);
            if (idx < 0) continue;
            const orig = rescue[idx];
            if (!(f.text || "").trim()) continue;
            const s = recdBy.get(`${orig.raw.x1},${orig.raw.y1}`);
            if (s) { s.text = f.text; } // 幸存但文本更差的圈内行:直接换更好的
            else {
              const restored: OCRBox = { points: orig.points.slice(), raw: orig.raw, score: orig.score, text: f.text };
              if (missedKept.includes(orig)) recdAll.push(restored); // fullBlocks 随后拾起
              else outBoxes.push(restored);
            }
            saved++;
            stage.push(`[抢救×4] ${bb(orig)} "${f.text}"`);
          }
          stage.push(`[抢救×4] ${saved}/${rescue.length} 行救回`);
        } catch (e) {
          stage.push(`[抢救×4] 失败:${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const fullBlocks: OCRBox[][] = rects.map(() => []);
      for (const b of recdAll) {
        const fi = inAny(b);
        if (fi >= 0) fullBlocks[fi].push(b);
      }
      // det 找到、rec(含抢救)仍交白卷的行 = 真识别不了,圈内圈外分开量出来
      const recdKeys = new Set<string>(recdAll.map((r) => `${r.raw.x1},${r.raw.y1}`)); // ponytail: 坐标当身份够用,rec 不改 raw
      const outKeys2 = new Set<string>(outBoxes.map((r) => `${r.raw.x1},${r.raw.y1}`));
      let missed = 0;
      let missedOutN = 0;
      fullBlocks.forEach((blk, fi) => {
        for (const b of blk) stage.push(`[写 F${fi}] ${bb(b)} "${b.text || ""}"`);
      });
      for (const d of keptDet) {
        if (recdKeys.has(`${d.raw.x1},${d.raw.y1}`)) continue;
        missed++;
        marks.push({ raw: d.raw, cls: "norec" });
        stage.push(`[未返回] ${bb(d)} rec 空/垃圾文本`);
      }
      for (const d of outDet) {
        if (outKeys2.has(`${d.raw.x1},${d.raw.y1}`)) continue;
        missedOutN++;
        marks.push({ raw: d.raw, cls: "norec" });
        stage.push(`[未返回·补足] ${bb(d)} rec 空/垃圾文本`);
      }
      const frameOrder = frameReadingOrder(rects, img.width, twoColumn);
      stage.push(`[写序] ${twoColumn ? "双栏:横贯带→左栏→右栏" : "圈按 y→x"} 排: ${frameOrder.map((i) => "F" + i).join(" > ")}`);
      const out = frameOrder.map((fi) => stackedOrder(fullBlocks[fi])).flat();
      if (outBoxes.length) out.push(...(twoColumn ? orderBoxes(outBoxes, img.width, true) : readingOrder(outBoxes))); // b58 圈外补足:圈内永远在前
      // 分堆效果只能量最终序:同一行带内大幅向左回跳 = 还在左右逐行交错;正常量级 ≈ 圈数
      // (每个圈到下一个圈的边界各一次)。
      let crossBack = 0;
      for (let i = 1; i < out.length; i++) {
        const p = out[i - 1].raw;
        const c = out[i].raw;
        if ((c.y1 + c.y2) / 2 >= (p.y1 + p.y2) / 2 - 2 && (c.x1 + c.x2) / 2 < (p.x1 + p.x2) / 2 - (c.x2 - c.x1)) crossBack++;
      }
      stage.push(`[最终写序] ${out.length} 行,跨栏回跳 ${crossBack} 次(≈圈数=${rects.length} 才算分堆生效;远大于则是还在逐行交错)`);
      const keptLines = fullBlocks.reduce((s, b) => s + b.length, 0);
      debugLog.log(`region diag page ${pageIndex + 1} — 整页det=${raw.length} → 圈内=${keptLines}(未返回=${missed}) = ${out.length} 行\n${stage.join("\n")}`);
      // 一份证据同时进日志和弹窗「复制文字」:标注原始 pt → 页 pt 尺寸 → 缩放 → 引擎吃的 px
      const head = `rects=${rects.length} 标注pts[${pageRegions.map((r) => `${r.x1.toFixed(1)},${r.y1.toFixed(1)}~${r.x2.toFixed(1)},${r.y2.toFixed(1)}`).join(" ")}] 页=${img.widthPoints}x${img.heightPoints}pt scale=${scaleX.toFixed(2)} → px[${rects.map((r) => `${r.x1},${r.y1}~${r.x2},${r.y2}`).join(" ")}]`;
      debugLog.log(`region mode page ${pageIndex + 1} det-then-subtract: ${head} whole=${raw.length} kept=${keptLines} norec=${missed} total=${out.length}`);
      showStageOverlay(`page ${pageIndex + 1}`, { width: img.width, height: img.height, rgba: src }, rects, marks,
        `${head} 整页det=${raw.length} 写入=${out.length}\n` + stage.join("\n"));
      return {
        pages: [{
          pageIndex,
          pageWidth: img.width,
          pageHeight: img.height,
          pageWidthPoints: img.widthPoints,
          pageHeightPoints: img.heightPoints,
          boxes: out,
        }],
      };
    }

    onProgress?.({ stage: "det", percent: 0, message: t("engine.detPage") });

    // det 会 transfer 主线程的 buffer,故先为每个 worker 复制一份 rec 用像素
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

    const k = Math.ceil(x / n); // 每核框数(向上取整)
    onProgress?.({ stage: "alloc", percent: 0, message: t("engine.allocBoxes", { n, k, x }) });

    // 连续分组:核 g 负责 [g*k, min((g+1)*k, x)),末核可能更少
    const groups: OCRBox[][] = [];
    for (let g = 0; g < n; g++) groups.push(raw.slice(g * k, Math.min((g + 1) * k, x)));

    let done = 0;
    const recChunks = await Promise.all(groups.map(async (group, g) => {
      if (group.length === 0) return [] as OCRBox[];
      if (this.cancelled()) throw new Error("OCR cancelled");
      const boxes = await this.clients[g].recBatch(img.width, img.height, recBufs[g], group);
      done += group.length;
      onProgress?.({ stage: "done-box", percent: (done / x) * 100, message: t("engine.recBox", { done, x }) });
      return boxes;
    }));

    // 连续分组 → 按组序拼接即还原阅读顺序(nms 已在 detOnly 做过)
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
        message: t("engine.pageDone", { page: pageIndex + 1, boxes: boxes.length, done, total }),
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
