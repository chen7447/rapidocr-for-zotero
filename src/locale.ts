// src/locale.ts
// Tiny i18n for our custom chrome windows (queue/progress/settings dialogs,
// reader toolbar popup, hooks messages).
//
// Language rule: Zotero.locale starting with "zh" → the zh-CN table;
// everything else falls back to English. No pref, no switching — "简单适配".
//
// NOTE: the preferences pane does NOT go through this module — it is a main-
// window fragment and uses Fluent (data-l10n-id + pdfocrforzotero-mainWindow
// .ftl), which is unavailable inside our document.write windows.
//
// Size note: the two tables add a few KB to the bundle — noise next to the
// 36 MB font+model assets. Do NOT add binary assets per language.

type Table = Record<string, string>;

const ZH: Table = {
  "common.cancel": "取消",
  "common.close": "关闭",

  // queue dialog
  "queue.cancelAll": "全部取消",
  "queue.cancel": "取消",
  "queue.preparing": "正在准备…",
  "queue.processing": "处理中…",
  "queue.waiting": "等待中…",
  "queue.waitingFor": "等待中…（等待《{name}》完成）",
  "status.queued": "… 等待",
  "status.running": "▶ 运行中",
  "status.completed": "✓ 完成",
  "status.failed": "✗ 失败",
  "status.cancelled": "⊘ 已取消",
  "status.cancelledShort": "已取消",

  // strip/progress dialog
  "strip.title": "删除 OCR 文字层",
  "progress.initializing": "正在初始化...",
  "progress.totalTime": "总用时",
  "progress.ocrTime": "RapidOCR 已运行",

  // settings dialog
  "settings.title": "OCR PDF 设置",
  "settings.res": "检测分辨率",
  "settings.thresh": "检测灵敏度",
  "settings.box": "文本框过滤",
  "settings.tilt": "倾斜文字过滤",
  "settings.crop": "识别模式",
  "settings.workers": "并行核心数",
  "settings.run": "运行",
  "settings.crop0": "直立正文",
  "settings.crop1": "倾斜正文",
  "settings.crop2": "复合（推荐）",
  "settings.batchLabel": "将对 {count} 个 PDF 应用以下设置（仅本次生效）",

  // reader toolbar
  "toolbar.pageOcr": "OCR 当前页（已有 OCR 文字层会被自动替换）",
  "toolbar.pages": "页码",
  "toolbar.pagesHint": "3 或 3,5,7-9",
  "toolbar.res": "检测分辨率",
  "toolbar.thresh": "检测灵敏度",
  "toolbar.box": "文本框过滤",
  "toolbar.tilt": "倾斜过滤（度）",
  "toolbar.crop": "识别模式",
  "toolbar.workers": "并行核心数",
  "toolbar.recommended": "（推荐）",
  "toolbar.largeScan": "（大版面/扫描件）",
  "toolbar.crop0": "直立正文（AABB 直接裁剪）",
  "toolbar.crop1": "倾斜正文（旋转矫正）",
  "toolbar.crop2": "复合方法（推荐）",
  "toolbar.coresUnit": "核",
  "toolbar.strip": "删除 OCR 文字层",
  "toolbar.stripTip": "删除当前页的 OCR 文字层（可从原件恢复）",
  "toolbar.errPages": "页码无效",
  "toolbar.errCount": "无法读取页数",
  "toolbar.errItem": "无法确定当前附件",

  // hooks user-facing messages
  "hooks.nonePdf": "当前选择中没有可处理的 PDF 附件。",
  "hooks.unavailable": "检测到 {n} 个 PDF 附件，但本地文件不可用。",
  "hooks.confirmParent":
    "“{title}” 是独立附件，没有父条目。是否创建同名父条目，把该 PDF 挂载到父条目下，然后创建 [OCR] 兄弟附件？",
  "hooks.skipped": "{n} 个附件已在队列中，已跳过。",
  "hooks.noAttachment": "找不到当前附件。",
  "hooks.fileUnavailable": "当前附件文件不可用。",
  "hooks.closingReaders": "关闭阅读器…",
  "hooks.parsing": "解析 PDF…",
  "hooks.ocrRunning": "OCR 处理中…",
  "hooks.rebuilding": "重建 PDF…",
  "hooks.readingPdf": "读取 PDF…",
  "hooks.restoring": "从原件恢复页面…",
  "hooks.stripping": "删除文字层…",
  "hooks.writing": "写入 PDF…",
  "hooks.reindexing": "重建全文索引…",
  "hooks.stripped": "已从第 {pages} 页去掉文字层。",
  "hooks.nothingToStrip": "指定页没有可删除的 OCR 文字层。",
  "hooks.done": "OCR 完成 — {n} 个文本框",
  "hooks.unsafePath": "无法为 {path} 推导安全的 OCR 输出路径，已中止（不会覆盖源文件）",

  // engine progress (main-thread composed, shown in the dialogs)
  "engine.pages": "解析PDF页数为 {n} 页",
  "engine.allocPages": "已分配 {n} 核数，每核OCR数为 {k}（向上取整）",
  "engine.detPage": "整页检测文本框…",
  "engine.allocBoxes": "已分配 {n} 核数，每核识别 {k} 个文本框（共 {x} 个，向上取整）",
  "engine.recBox": "识别第 {done}/{x} 个文本框…",
  "engine.pageDone": "第 {page} 页完成 ({boxes} 个文本框)（{done}/{total}）",
};

const EN: Table = {
  "common.cancel": "Cancel",
  "common.close": "Close",

  "queue.cancelAll": "Cancel all",
  "queue.cancel": "Cancel",
  "queue.preparing": "Preparing…",
  "queue.processing": "Working…",
  "queue.waiting": "Waiting…",
  "queue.waitingFor": "Waiting… (for “{name}”)",
  "status.queued": "… Waiting",
  "status.running": "▶ Running",
  "status.completed": "✓ Done",
  "status.failed": "✗ Failed",
  "status.cancelled": "⊘ Cancelled",
  "status.cancelledShort": "Cancelled",

  "strip.title": "Remove OCR text layer",
  "progress.initializing": "Initializing...",
  "progress.totalTime": "Total time",
  "progress.ocrTime": "RapidOCR time",

  "settings.title": "OCR PDF Settings",
  "settings.res": "Detection resolution",
  "settings.thresh": "Detection sensitivity",
  "settings.box": "Box filter",
  "settings.tilt": "Tilt filter",
  "settings.crop": "Crop mode",
  "settings.workers": "Parallel workers",
  "settings.run": "Run",
  "settings.crop0": "Upright text",
  "settings.crop1": "Tilted text",
  "settings.crop2": "Hybrid (recommended)",
  "settings.batchLabel": "The settings below apply to {count} PDF(s), this run only",

  "toolbar.pageOcr": "OCR current page (existing OCR text layer is replaced)",
  "toolbar.pages": "Pages",
  "toolbar.pagesHint": "3 or 3,5,7-9",
  "toolbar.res": "Detection resolution",
  "toolbar.thresh": "Detection sensitivity",
  "toolbar.box": "Box filter",
  "toolbar.tilt": "Tilt filter (°)",
  "toolbar.crop": "Crop mode",
  "toolbar.workers": "Parallel workers",
  "toolbar.recommended": " (recommended)",
  "toolbar.largeScan": " (large/scanned pages)",
  "toolbar.crop0": "Upright text (direct AABB crop)",
  "toolbar.crop1": "Tilted text (rectified)",
  "toolbar.crop2": "Hybrid (recommended)",
  "toolbar.coresUnit": "worker(s)",
  "toolbar.strip": "Remove OCR text layer",
  "toolbar.stripTip": "Remove the OCR text layer of the selected pages (restorable from the source file)",
  "toolbar.errPages": "Invalid page numbers",
  "toolbar.errCount": "Unable to read the page count",
  "toolbar.errItem": "Unable to determine the attachment",

  "hooks.nonePdf": "No processable PDF attachments in the current selection.",
  "hooks.unavailable": "{n} PDF attachment(s) found, but the local files are unavailable.",
  "hooks.confirmParent":
    "“{title}” is a standalone attachment without a parent item. Create a parent item named “{title}”, move the PDF under it, and add an [OCR] sibling attachment?",
  "hooks.skipped": "{n} attachment(s) already queued — skipped.",
  "hooks.noAttachment": "The current attachment could not be found.",
  "hooks.fileUnavailable": "The attachment file is unavailable.",
  "hooks.closingReaders": "Closing reader…",
  "hooks.parsing": "Parsing PDF…",
  "hooks.ocrRunning": "Running OCR…",
  "hooks.rebuilding": "Rebuilding PDF…",
  "hooks.readingPdf": "Reading PDF…",
  "hooks.restoring": "Restoring pages from source…",
  "hooks.stripping": "Removing text layer…",
  "hooks.writing": "Writing PDF…",
  "hooks.reindexing": "Rebuilding fulltext index…",
  "hooks.stripped": "Text layer removed from page(s) {pages}.",
  "hooks.nothingToStrip": "The selected pages have no removable OCR text layer.",
  "hooks.done": "OCR complete — {n} text box(es)",
  "hooks.unsafePath": "Cannot derive a safe OCR output path for {path}; aborted (the source file will not be overwritten)",

  "engine.pages": "PDF parsed: {n} page(s)",
  "engine.allocPages": "Allocated {n} workers, {k} pages each",
  "engine.detPage": "Detecting text boxes on the full page…",
  "engine.allocBoxes": "Allocated {n} workers, {k} boxes each ({x} total)",
  "engine.recBox": "Recognizing box {done}/{x}…",
  "engine.pageDone": "Page {page} done ({boxes} boxes) ({done}/{total})",
};

let cached: Table | null = null;

function table(): Table {
  if (cached) return cached;
  let zh = false;
  try {
    zh = String((Zotero as unknown as { locale?: string }).locale || "")
      .toLowerCase()
      .startsWith("zh");
  } catch {
    zh = false; // no Zotero global (unit tests / non-Zotero) → English
  }
  cached = zh ? ZH : EN;
  return cached;
}

/** Translate `key`, interpolating `{name}` placeholders from `args`. */
export function t(key: string, args?: Record<string, string | number>): string {
  let s = table()[key] ?? EN[key] ?? key;
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** Test hook: drop the cached locale table so the next t() re-detects. */
export function resetLocaleCacheForTests(): void {
  cached = null;
}
