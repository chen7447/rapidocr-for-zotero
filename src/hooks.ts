import { ContextMenuController, MenuManagerLike } from "./ui/context-menu";
import { JobManager } from "./jobs/job-manager";
import { OcrProgressDialog } from "./ui/ocr-dialog";
import { createOCRAttachment, createParentAndAttachOCR } from "./zotero/attachment-service";
import { registerPrefs, unregisterPrefs, PreferencePanesLike } from "./ui/preferences";
import {
  SelectionItem,
  SelectionResolution,
  SelectionResolver,
} from "./zotero/selection-resolver";
import { Job } from "./domain/job";

const initializedWindows = new WeakSet<Window>();
let contextMenuController: ContextMenuController | null = null;
let jobManager: JobManager | null = null;
let ocrDialog: OcrProgressDialog | null = null;
let activeEngine: { cancel(): void } | null = null;
let prefsRegistered = false;

// ─── dev log helper — mirrors to Zotero debug pane ─────────────────

function log(msg: string): void {
  Zotero.debug(`PDF OCR For Zotero v3: ${msg}`);
}

// ─── Zotero helpers ─────────────────────────────────────────────────

function zoteroItemsByID(ids: number[]): SelectionItem[] {
  const get = (Zotero.Items as unknown as { get(ids: number[]): unknown[] }).get;
  const items = get.call(Zotero.Items, ids);
  return (Array.isArray(items) ? items : [items]).filter(Boolean) as SelectionItem[];
}

function getMenuManager(): MenuManagerLike {
  return (Zotero as unknown as { MenuManager: MenuManagerLike }).MenuManager;
}

function getPreferencePanes(): PreferencePanesLike {
  return (Zotero as unknown as { PreferencePanes: PreferencePanesLike }).PreferencePanes;
}

function getFallbackSelection(): SelectionItem[] {
  const pane = (Zotero as unknown as {
    getActiveZoteroPane?: () => { getSelectedItems(): unknown[] } | null;
  }).getActiveZoteroPane?.();
  return (pane?.getSelectedItems?.() || []) as SelectionItem[];
}

function createJob(jobIndex: number, item: SelectionItem, path: string): Job {
  return {
    jobId: `job-${Date.now()}-${jobIndex}`,
    attachmentID: item.id,
    path,
    title: item.getDisplayTitle?.() || path.split(/[\\/]/).pop() || path,
    status: "queued",
    percent: 0,
    stage: "queued",
  };
}

function confirmCreateParent(title: string): boolean {
  const window = Zotero.getMainWindow();
  return (Services.prompt as { confirm: (win: unknown, title: string, msg: string) => boolean }).confirm(
    window,
    "PDF OCR For Zotero v3",
    `“${title}” 是独立附件，没有父条目。是否创建同名父条目“${title}”，把该 PDF 挂载到父条目下，然后创建 [OCR] 兄弟附件？`,
  );
}

// ─── Job manager ───

function ensureJobManager(): JobManager {
  if (!jobManager) {
    jobManager = new JobManager({
      async execute(job) {
        if (ocrDialog) { ocrDialog.close(); ocrDialog = null; }
        ocrDialog = new OcrProgressDialog();
        ocrDialog.open(job.title);
        ocrDialog.setOnCancel(() => jobManager?.cancelCurrent());

        try {
          // 1. Load PDF via Zotero's built-in pdf.js (解析约几十毫秒)
          ocrDialog.updateProgress(0, "v3", "解析 PDF…");
          const { ZoteroPageRenderer } = await import("./ocr/zotero-renderer");
          const renderer = new ZoteroPageRenderer();
          await renderer.load(job.path);
          if (ocrDialog.isCancelled) throw new Error("OCR cancelled");

          // 2. Read v3 OCR preferences (defaults match prefs.js)
          // 短前缀：Zotero.Prefs 自动加 "extensions.zotero." 前缀，
          // 与 prefs.js 的 pref("extensions.zotero.pdfocrforzotero.*") 完整 key 一致。
          // 注意：Firefox pref 无 float 类型，阈值以 0~100 整数百分比存储，
          // 读取后 ÷100 得到 0~1 小数。兼容旧值（旧版被截断成 0 或残留小数）。
          const PREFIX = "pdfocrforzotero";

          const detLimitSideLen = Number(Zotero.Prefs.get(PREFIX + ".detLimitSideLen")) || 1536;

          const detThreshRaw = Number(Zotero.Prefs.get(PREFIX + ".detThresh")) || 0;
          // 旧值：0（截断）或 0.x（小数）→ 归一化到整数百分比 30, 40
          const detThreshPct = detThreshRaw >= 1 ? detThreshRaw : (detThreshRaw > 0 && detThreshRaw < 1 ? Math.round(detThreshRaw * 100) : 30);
          const detThresh = detThreshPct / 100;

          const detBoxThreshRaw = Number(Zotero.Prefs.get(PREFIX + ".detBoxThresh")) || 0;
          const detBoxThreshPct = detBoxThreshRaw >= 1 ? detBoxThreshRaw : (detBoxThreshRaw > 0 && detBoxThreshRaw < 1 ? Math.round(detBoxThreshRaw * 100) : 40);
          const detBoxThresh = detBoxThreshPct / 100;

          const autoOpen = !!Zotero.Prefs.get(PREFIX + ".autoOpenAfterSuccess");

          // 3. Run OCR engine — 模型加载 + Worker 推理都在引擎内部，不阻塞 UI
          ocrDialog.updateProgress(0, "v3", "OCR 处理中…");
          const { OcrEngine } = await import("./ocr/ocr-engine");
          const engine = new OcrEngine(renderer, {
            detLimitSideLen,
            detThresh,
            detBoxThresh,
            isCancelled: () => ocrDialog?.isCancelled ?? false,
            onProgress: ({ percent, message }) => ocrDialog?.updateProgress(Math.round(percent), "v3", message),
          });
          activeEngine = engine;
          let result;
          try {
            result = await engine.run();
          } finally {
            activeEngine = null;
            engine.dispose();
          }
          log(`job ${job.jobId} — OCR done: ${result.pages.length} pages`);

          ocrDialog.updateProgress(90, "v3", "重建 PDF…");

          // 3. Build searchable PDF with invisible text layer
          const { addOcrLayerToPdf } = await import("./ocr/pdf-builder");
          // IOUtils.read 返回的是 Gecko 主 realm 的 Uint8Array；pdf-lib 用
          // `instanceof Uint8Array`（沙箱 realm）做类型检查会失败（报 "NaN"），
          // 必须 `new Uint8Array(...)` 拷贝成沙箱 realm 的 TypedArray。
          const originalBytes = new Uint8Array(await IOUtils.read(job.path));
          const outputPdf = await addOcrLayerToPdf(originalBytes, result);

          // 4. Write output PDF and create [OCR] attachment
          const { createOCRAttachment, createParentAndAttachOCR } = await import("./zotero/attachment-service");
          const outputPath = job.path.replace(/\.pdf$/i, "-ocr.pdf");
          await IOUtils.write(outputPath, outputPdf);

          let ocrAttachmentID: number | undefined;
          const attachResult = await createOCRAttachment({
            attachmentID: job.attachmentID,
            path: outputPath,
            title: job.title,
            getItems: zoteroItemsByID,
            importFromFile: async (opts) => {
              // Zotero 10 已移除 Zotero.Items.addRaw；用官方 Attachments.importFromFile
              const item = await Zotero.Attachments.importFromFile({
                file: opts.file,
                parentItemID: opts.parentItemID,
                libraryID: opts.libraryID,
                title: opts.title,
              });
              return { id: item.id };
            },
            indexItems: (ids, opts) => Zotero.Fulltext.indexItems(ids, opts),
          });

          if (attachResult.status === "sibling_imported") {
            ocrAttachmentID = attachResult.attachmentID;
          }

          if (attachResult.status === "standalone_attachment") {
            // PDF has no parent — offer to create one
            const confirmed = confirmCreateParent(job.title);
            if (confirmed) {
              const parentResult = await createParentAndAttachOCR({
                attachmentID: job.attachmentID,
                path: outputPath,
                title: job.title,
                getItems: zoteroItemsByID,
                createRegularItem: async (opts) => {
                  // Zotero 10: new Zotero.Item + saveTx() 代替已移除的 Zotero.Items.addRaw
                  const item = new Zotero.Item("journalArticle");
                  item.libraryID = opts.libraryID;
                  item.setField("title", opts.title);
                  await item.saveTx();
                  return { id: item.id };
                },
                setAttachmentParent: (attachID, parentID) =>
                  Zotero.Items.setParent(attachID, parentID),
                importFromFile: async (opts) => {
                  // Zotero 10: Attachments.importFromFile 代替已移除的 addRaw
                  const item = await Zotero.Attachments.importFromFile({
                    file: opts.file,
                    parentItemID: opts.parentItemID,
                    libraryID: opts.libraryID,
                    title: opts.title,
                  });
                  return { id: item.id };
                },
                indexItems: (ids, opts) => Zotero.Fulltext.indexItems(ids, opts),
              });
              if (parentResult.status === "parent_created") {
                ocrAttachmentID = parentResult.attachmentID;
              }
            }
          }

          ocrDialog.complete(`OCR 完成 — ${result.pages.reduce((s, p) => s + p.boxes.length, 0)} 个文本框`);

          // 完成后自动打开 [OCR] 附件（偏好开关，默认关闭）
          if (autoOpen && ocrAttachmentID) {
            try {
              const { openAttachment } = await import("./zotero/open-file");
              await openAttachment(ocrAttachmentID);
            } catch (openErr) {
              log(`auto-open failed: ${String(openErr)}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "OCR cancelled") {
            log(`job ${job.jobId} — cancelled`);
          } else {
            log(`job ${job.jobId} — FAILED: ${msg}`);
            ocrDialog.fail(msg);
          }
          throw err;
        }
      },
      kill() {
        activeEngine?.cancel();
      },
    });
  }
  return jobManager;
}

async function handleSelection(resolution: SelectionResolution): Promise<void> {
  const count = resolution.jobs.length;
  log(`selected ${count} PDF attachment(s)`);
  if (!count) {
    const unavailable = resolution.unavailable.length;
    const message = unavailable
      ? `检测到 ${unavailable} 个 PDF 附件，但本地文件不可用。`
      : "当前选择中没有可处理的 PDF 附件。";
    Zotero.debug(`PDF OCR For Zotero: ${message}`);
    return;
  }
  const manager = ensureJobManager();
  resolution.jobs.forEach((job, index) => {
    manager.enqueue(createJob(index, job.attachment, job.path));
  });
}

async function onStartup(): Promise<void> {
  for (const window of Zotero.getMainWindows()) {
    await onMainWindowLoad(window);
  }
  if (!prefsRegistered) {
    await registerPrefs(getPreferencePanes(), "pdfocrforzotero@example.com", addonRoot);
    prefsRegistered = true;
  }
  if (!contextMenuController) {
    contextMenuController = new ContextMenuController(
      getMenuManager(),
      new SelectionResolver(zoteroItemsByID),
      handleSelection,
      getFallbackSelection,
    );
    contextMenuController.register();
  }
  log("startup complete");
}

async function onMainWindowLoad(window: Window): Promise<void> {
  if (initializedWindows.has(window)) return;
  window.MozXULElement?.insertFTLIfNeeded("pdfocrforzotero-mainWindow.ftl");
  initializedWindows.add(window);
}

async function onMainWindowUnload(window: Window): Promise<void> {
  if (!initializedWindows.has(window)) return;
  initializedWindows.delete(window);
}

async function onShutdown(): Promise<void> {
  if (prefsRegistered) {
    unregisterPrefs(getPreferencePanes());
    prefsRegistered = false;
  }
  jobManager?.shutdown();
  jobManager = null;
  if (ocrDialog) { ocrDialog.close(); ocrDialog = null; }
  contextMenuController?.unregister();
  contextMenuController = null;
  for (const window of Zotero.getMainWindows()) {
    await onMainWindowUnload(window);
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};