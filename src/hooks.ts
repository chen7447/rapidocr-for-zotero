import { ContextMenuController, MenuManagerLike } from "./ui/context-menu";
import { JobManager } from "./jobs/job-manager";
import { OcrProgressDialog } from "./ui/ocr-dialog";
import { createOCRAttachment, createParentAndAttachOCR } from "./zotero/attachment-service";
import { registerPrefs, unregisterPrefs, PreferencePanesLike } from "./ui/preferences";
import {
  SelectionItem,
  SelectionResolution,
  SelectionResolver,
  isDerivedOCRAttachment,
} from "./zotero/selection-resolver";
import { Job } from "./domain/job";
import { registerReaderToolbar, unregisterReaderToolbar, PageOcrRequest, StripRequest } from "./ui/reader-toolbar";
import { toPageIndexes } from "./ocr/page-spec";

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

function createJob(jobIndex: number, item: SelectionItem, path: string, extra: Partial<Job> = {}): Job {
  return {
    jobId: `job-${Date.now()}-${jobIndex}`,
    attachmentID: item.id,
    path,
    title: item.getDisplayTitle?.() || path.split(/[\\/]/).pop() || path,
    status: "queued",
    percent: 0,
    stage: "queued",
    ...extra,
  };
}

function readOcrPrefs(): { detLimitSideLen: number; detThresh: number; detBoxThresh: number; autoOpen: boolean } {
  const PREFIX = "pdfocrforzotero";
  const detLimitSideLen = Number(Zotero.Prefs.get(PREFIX + ".detLimitSideLen")) || 1536;
  const detThreshRaw = Number(Zotero.Prefs.get(PREFIX + ".detThresh")) || 0;
  const detThreshPct = detThreshRaw >= 1 ? detThreshRaw : (detThreshRaw > 0 && detThreshRaw < 1 ? Math.round(detThreshRaw * 100) : 30);
  const detBoxThreshRaw = Number(Zotero.Prefs.get(PREFIX + ".detBoxThresh")) || 0;
  const detBoxThreshPct = detBoxThreshRaw >= 1 ? detBoxThreshRaw : (detBoxThreshRaw > 0 && detBoxThreshRaw < 1 ? Math.round(detBoxThreshRaw * 100) : 40);
  return {
    detLimitSideLen,
    detThresh: detThreshPct / 100,
    detBoxThresh: detBoxThreshPct / 100,
    autoOpen: !!Zotero.Prefs.get(PREFIX + ".autoOpenAfterSuccess"),
  };
}

function siblingAttachments(item: SelectionItem): SelectionItem[] {
  const parentID = item.parentItemID;
  if (!parentID) return [];
  const parent = zoteroItemsByID([parentID])[0];
  const ids = parent?.getAttachments?.() || [];
  return zoteroItemsByID(ids).filter((a) => a.id !== item.id);
}

function findOcrSibling(item: SelectionItem): SelectionItem | undefined {
  return siblingAttachments(item).find(isDerivedOCRAttachment);
}

function findSourceSibling(item: SelectionItem): SelectionItem | undefined {
  return siblingAttachments(item).find((a) => !isDerivedOCRAttachment(a) && (
    a.attachmentContentType === "application/pdf"
    || /\.pdf$/i.test(a.getFilePath?.() || "")
  ));
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
          if (job.inPlace) {
            const closeIDs = [job.attachmentID];
            if (job.writeAttachmentID && job.writeAttachmentID !== job.attachmentID) {
              closeIDs.push(job.writeAttachmentID);
            }
            ocrDialog.updateProgress(0, "v3", "关闭阅读器…");
            for (const id of closeIDs) closeReadersFor(id);
            for (const id of closeIDs) await waitReadersClosed(id);
            await sleep(200);
          }

          // 1. Load PDF via Zotero's built-in pdf.js (解析约几十毫秒)
          ocrDialog.updateProgress(0, "v3", "解析 PDF…");
          const { ZoteroPageRenderer } = await import("./ocr/zotero-renderer");
          const renderer = new ZoteroPageRenderer();
          await renderer.load(job.path);
          if (ocrDialog.isCancelled) throw new Error("OCR cancelled");

          const prefs = readOcrPrefs();
          const detLimitSideLen = job.detLimitSideLen ?? prefs.detLimitSideLen;
          const detThresh = job.detThresh ?? prefs.detThresh;
          const detBoxThresh = job.detBoxThresh ?? prefs.detBoxThresh;
          const autoOpen = prefs.autoOpen;

          ocrDialog.updateProgress(0, "v3", "OCR 处理中…");
          const { OcrEngine } = await import("./ocr/ocr-engine");
          const engine = new OcrEngine(renderer, {
            detLimitSideLen,
            detThresh,
            detBoxThresh,
            pageIndexes: job.pageIndexes,
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
          const overlayPath = job.writePath || job.path;
          const originalBytes = new Uint8Array(await IOUtils.read(overlayPath));
          const outputPdf = await addOcrLayerToPdf(originalBytes, result);

          if (job.inPlace) {
            await writePdf(overlayPath, outputPdf);
            const indexedID = job.writeAttachmentID ?? job.attachmentID;
            await Zotero.Fulltext.indexItems([indexedID], { complete: true, ignoreErrors: false });
            ocrDialog.complete(`OCR 完成 — ${result.pages.reduce((s, p) => s + p.boxes.length, 0)} 个文本框`);
            try { await reopenAttachment(indexedID, job.pageIndexes?.[0]); }
            catch (openErr) { log(`reopen after page OCR: ${openErr instanceof Error ? openErr.message : String(openErr)}`); }
            return;
          }

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

async function handlePageOcr(req: PageOcrRequest): Promise<void> {
  const item = zoteroItemsByID([req.itemID])[0];
  if (!item) {
    log(`page OCR: item ${req.itemID} not found`);
    return;
  }
  const path = await item.getFilePathAsync?.() || item.getFilePath?.() || false;
  if (!path) {
    log(`page OCR: file unavailable for ${req.itemID}`);
    return;
  }
  const extra: Partial<Job> = {
    pageIndexes: toPageIndexes(req.pages1),
    detLimitSideLen: req.detLimitSideLen,
    detThresh: req.detThresh,
    detBoxThresh: req.detBoxThresh,
  };
  let renderItem = item;
  let renderPath = path;
  if (isDerivedOCRAttachment(item)) {
    extra.inPlace = true;
    extra.writePath = path;
    extra.writeAttachmentID = item.id;
    const source = findSourceSibling(item);
    const srcPath = source
      ? await source.getFilePathAsync?.() || source.getFilePath?.() || false
      : false;
    if (source && srcPath) {
      renderItem = source;
      renderPath = srcPath;
    }
  } else {
    const sibling = findOcrSibling(item);
    const sibPath = sibling
      ? await sibling.getFilePathAsync?.() || sibling.getFilePath?.() || false
      : false;
    if (sibling && sibPath) {
      extra.inPlace = true;
      extra.writePath = sibPath;
      extra.writeAttachmentID = sibling.id;
    }
  }
  try {
    ensureJobManager().enqueue(createJob(0, renderItem, renderPath, extra));
  } catch (err) {
    log(`page OCR enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function itemPath(item: SelectionItem): Promise<string | false> {
  return await item.getFilePathAsync?.() || item.getFilePath?.() || false;
}

function readerList(): Array<{ itemID?: number; close?: () => void; navigate?: (loc: { pageIndex: number }) => Promise<void> }> {
  return (Zotero as unknown as { Reader?: { _readers?: Array<{ itemID?: number; close?: () => void; navigate?: (loc: { pageIndex: number }) => Promise<void> }> } }).Reader?._readers || [];
}

function closeReadersFor(itemID: number): void {
  const tabs = (Zotero.getMainWindow() as unknown as { Zotero_Tabs?: { getTabIDByItemID?: (id: number) => string; close: (id: string) => void } }).Zotero_Tabs;
  const tabID = tabs?.getTabIDByItemID?.(itemID);
  if (tabID) tabs?.close(tabID);
  for (const r of readerList()) {
    if (r.itemID === itemID) r.close?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReadersClosed(itemID: number): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (!readerList().some((r) => r.itemID === itemID)) return;
    await sleep(100);
  }
}

async function writePdf(path: string, bytes: Uint8Array): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      await IOUtils.write(path, bytes);
      return;
    } catch (err) {
      last = err;
      await sleep(150 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function reopenAttachment(itemID: number, pageIndex?: number): Promise<void> {
  const { openAttachment } = await import("./zotero/open-file");
  await openAttachment(itemID, pageIndex);
}

async function handleStripOcr(req: StripRequest): Promise<void> {
  log(`strip OCR: item ${req.itemID} pages ${req.pages1.join(",")}`);
  const item = zoteroItemsByID([req.itemID])[0];
  if (!item) {
    OcrProgressDialog.notify("删除 OCR 文字层", "找不到当前附件。");
    return;
  }
  const ocrItem = isDerivedOCRAttachment(item) ? item : (findOcrSibling(item) || item);
  const ocrPath = await itemPath(ocrItem);
  if (!ocrPath) {
    OcrProgressDialog.notify("删除 OCR 文字层", "当前附件文件不可用。");
    return;
  }
  const sourceItem = isDerivedOCRAttachment(ocrItem)
    ? (isDerivedOCRAttachment(item) ? findSourceSibling(item) : item)
    : undefined;
  const sourcePath = sourceItem && sourceItem.id !== ocrItem.id ? await itemPath(sourceItem) : false;
  const pageIndexes = toPageIndexes(req.pages1);

  closeReadersFor(req.itemID);
  if (ocrItem.id !== req.itemID) closeReadersFor(ocrItem.id);

  if (ocrDialog) { ocrDialog.close(); ocrDialog = null; }
  ocrDialog = new OcrProgressDialog();
  ocrDialog.open(ocrItem.getDisplayTitle?.() || "", "删除 OCR 文字层");
  ocrDialog.updateProgress(5, "v3", "关闭阅读器…");

  try {
    await waitReadersClosed(req.itemID);
    if (ocrItem.id !== req.itemID) await waitReadersClosed(ocrItem.id);
    await sleep(200);

    ocrDialog.updateProgress(20, "v3", "读取 PDF…");
    const { stripAllOcrOverlays, restorePagesFromSource } = await import("./ocr/pdf-builder");
    const ocrBytes = new Uint8Array(await IOUtils.read(ocrPath));
    let bytes: Uint8Array;
    let n = 0;
    if (sourcePath) {
      ocrDialog.updateProgress(45, "v3", "从原件恢复页面…");
      const restored = await restorePagesFromSource(ocrBytes, new Uint8Array(await IOUtils.read(sourcePath)), pageIndexes);
      bytes = restored.bytes;
      n = restored.pagesRestored;
    } else {
      ocrDialog.updateProgress(45, "v3", "删除文字层…");
      const stripped = await stripAllOcrOverlays(ocrBytes, pageIndexes);
      bytes = stripped.bytes;
      n = stripped.pagesStripped;
    }
    if (!n) {
      ocrDialog.fail("指定页没有可删除的 OCR 文字层。");
      await reopenAttachment(ocrItem.id, pageIndexes[0]);
      return;
    }
    ocrDialog.updateProgress(80, "v3", "写入 PDF…");
    await writePdf(ocrPath, bytes);
    ocrDialog.updateProgress(90, "v3", "重建全文索引…");
    await Zotero.Fulltext.indexItems([ocrItem.id], { complete: true, ignoreErrors: false });
    ocrDialog.complete(`已从第 ${req.pages1.join("、")} 页去掉文字层。`);
    try { await reopenAttachment(ocrItem.id, pageIndexes[0]); }
    catch (err) { log(`reopen after strip: ${err instanceof Error ? err.message : String(err)}`); }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`strip OCR failed: ${msg}`);
    ocrDialog?.fail(msg);
    try { await reopenAttachment(ocrItem.id, pageIndexes[0]); } catch {}
  }
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
  unregisterReaderToolbar();
  registerReaderToolbar((req) => {
    void handlePageOcr(req).catch((err) => log(`page OCR: ${err instanceof Error ? err.message : String(err)}`));
  }, () => {
    const p = readOcrPrefs();
    return { detLimitSideLen: p.detLimitSideLen, detThresh: p.detThresh, detBoxThresh: p.detBoxThresh };
  }, (req) => {
    void handleStripOcr(req).catch((err) => log(`strip OCR: ${err instanceof Error ? err.message : String(err)}`));
  });
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
  unregisterReaderToolbar();
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