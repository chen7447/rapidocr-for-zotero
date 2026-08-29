import { ContextMenuController, MenuManagerLike } from "./ui/context-menu";
import { JobManager } from "./jobs/job-manager";
import { OcrProgressDialog } from "./ui/ocr-dialog";
import { OcrQueueDialog } from "./ui/ocr-queue-dialog";
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
import { parseOcrPrefs, RawPrefValue } from "./ocr/prefs";

const initializedWindows = new WeakSet<Window>();
let contextMenuController: ContextMenuController | null = null;
let jobManager: JobManager | null = null;
let ocrDialog: OcrProgressDialog | null = null;
let queueDialog: OcrQueueDialog | null = null;
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

/**
 * 兜底：手动触发 MenuManager 重建「主条目」右键菜单。
 * 缓解 Zotero 已知 bug——注销插件菜单后主条目右键菜单打不开。
 * 加载时执行可修复被其它插件搞坏的菜单；注销后执行是尽力而为的缓解。
 */
function rebuildLibraryItemMenu(): void {
  try {
    const mm = (Zotero as unknown as {
      MenuManager?: { updateMenuPopup?: (popup: unknown, target: string) => void };
    }).MenuManager;
    const popup = Zotero.getMainWindow()?.document?.getElementById("zotero-itemmenu");
    if (mm?.updateMenuPopup && popup) mm.updateMenuPopup(popup, "main/library/item");
  } catch { /* best-effort */ }
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

function readOcrPrefs(): ReturnType<typeof parseOcrPrefs> {
  const PREFIX = "pdfocrforzotero";
  // 未注册的键读起来可能抛错；null/undefined 一律交由 parseOcrPrefs 当"未设置"处理
  const get = (key: string): RawPrefValue => {
    try {
      return Zotero.Prefs.get(PREFIX + "." + key) as RawPrefValue;
    } catch {
      return undefined;
    }
  };
  return parseOcrPrefs({
    detLimitSideLen: get("detLimitSideLen"),
    detThresh: get("detThresh"),
    detBoxThresh: get("detBoxThresh"),
    detMaxRotDeg: get("detMaxRotDeg"),
    cropMode: get("cropMode"),
    ocrWorkers: get("ocrWorkers"),
    autoOpenAfterSuccess: get("autoOpenAfterSuccess"),
  });
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

/**
 * 队列进度窗：整个 JobManager 生命周期共用一个窗口，任务以标签页呈现。
 * 用户手关窗口 = 全部取消（沿用旧单任务窗语义）。
 */
function ensureQueueDialog(): OcrQueueDialog {
  if (!queueDialog || queueDialog.isClosed()) {
    queueDialog = new OcrQueueDialog();
    queueDialog.open();
    queueDialog.setOnCancelCurrent(() => jobManager?.cancelCurrent());
    queueDialog.setOnCancelAll(() => {
      jobManager?.cancelCurrent();
      jobManager?.cancelRemaining();
    });
  }
  return queueDialog;
}

/** 入队即出标签：批量选择时 PDF1..N 立刻出现在进度窗（等待中）。 */
function registerQueuedJobTab(job: Job): void {
  try {
    ensureQueueDialog().addTask(job.jobId, job.title);
  } catch (err) {
    log(`queue dialog open failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureJobManager(): JobManager {
  if (!jobManager) {
    jobManager = new JobManager({
      async execute(job) {
        const dlg = queueDialog;
        // 取消不再轮询对话框窗口——JobManager 的任务状态是唯一事实来源
        //（cancelCurrent 先置 cancelled 再 kill，引擎每步都能看到）
        const jobCancelled = () => jobManager?.get(job.jobId)?.status === "cancelled";

        try {
          if (job.inPlace) {
            const closeIDs = [job.attachmentID];
            if (job.writeAttachmentID && job.writeAttachmentID !== job.attachmentID) {
              closeIDs.push(job.writeAttachmentID);
            }
            dlg?.updateTask(job.jobId, 0, "v3", "关闭阅读器…");
            for (const id of closeIDs) closeReadersFor(id);
            for (const id of closeIDs) await waitReadersClosed(id);
            await sleep(200);
          }

          // 1. Load PDF via Zotero's built-in pdf.js (解析约几十毫秒)
          dlg?.updateTask(job.jobId, 0, "v3", "解析 PDF…");
          const { ZoteroPageRenderer } = await import("./ocr/zotero-renderer");
          const renderer = new ZoteroPageRenderer();
          await renderer.load(job.path);
          if (jobCancelled()) throw new Error("OCR cancelled");

          const prefs = readOcrPrefs();
          const detLimitSideLen = job.detLimitSideLen ?? prefs.detLimitSideLen;
          const detThresh = job.detThresh ?? prefs.detThresh;
          const detBoxThresh = job.detBoxThresh ?? prefs.detBoxThresh;
          const detMaxRotDeg = job.detMaxRotDeg ?? prefs.detMaxRotDeg;
          const cropMode = job.cropMode ?? prefs.cropMode;
          const ocrWorkers = job.ocrWorkers ?? prefs.ocrWorkers;
          const autoOpen = prefs.autoOpen;

          dlg?.updateTask(job.jobId, 0, "v3", "OCR 处理中…");
          const { OcrEngine } = await import("./ocr/ocr-engine");
          const engine = new OcrEngine(renderer, {
            detLimitSideLen,
            detThresh,
            detBoxThresh,
            maxRotDeg: detMaxRotDeg,
            cropMode,
            workers: ocrWorkers,
            pageIndexes: job.pageIndexes,
            isCancelled: jobCancelled,
            onProgress: (info) => queueDialog?.updateTask(job.jobId, Math.round(info.percent), info.stage, info.message),
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

          dlg?.updateTask(job.jobId, 90, "v3", "重建 PDF…");

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
            dlg?.finishTask(job.jobId, "completed", `OCR 完成 — ${result.pages.reduce((s, p) => s + p.boxes.length, 0)} 个文本框`);
            try { await reopenAttachment(indexedID, job.pageIndexes?.[0]); }
            catch (openErr) { log(`reopen after page OCR: ${openErr instanceof Error ? openErr.message : String(openErr)}`); }
            return;
          }

          const { createOCRAttachment, createParentAndAttachOCR, deriveOcrOutputPath } = await import("./zotero/attachment-service");
          const outputPath = deriveOcrOutputPath(job.path);
          if (outputPath.toLowerCase() === job.path.toLowerCase()) {
            throw new Error(`无法为 ${job.path} 推导安全的 OCR 输出路径，已中止（不会覆盖源文件）`);
          }
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

          dlg?.finishTask(job.jobId, "completed", `OCR 完成 — ${result.pages.reduce((s, p) => s + p.boxes.length, 0)} 个文本框`);

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
            queueDialog?.finishTask(job.jobId, "cancelled", "已取消");
          } else {
            log(`job ${job.jobId} — FAILED: ${msg}`);
            queueDialog?.finishTask(job.jobId, "failed", msg);
          }
          throw err;
        }
      },
      kill() {
        activeEngine?.cancel();
      },
    });
    // JobManager 事件 → 队列窗。onJobStarted 负责把标签切到运行态；
    // 被「全部取消」干掉的排队任务不会进入 execute，只能从这里收尾。
    jobManager.addListener({
      onJobStarted: (started) => {
        try { ensureQueueDialog().markRunning(started.jobId, started.title); }
        catch (err) { log(`queue dialog open failed: ${err instanceof Error ? err.message : String(err)}`); }
      },
      onJobProgress: () => {},
      onJobCompleted: () => {},
      onJobFailed: () => {},
      onJobCancelled: (cancelledJob) => {
        queueDialog?.finishTask(cancelledJob.jobId, "cancelled", "已取消");
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

  // 右键 OCR PDF：先弹设置面板（预填偏好，仅本次生效），点「运行」才入队；
  // 「取消」或关闭面板则不执行本次操作。
  const { showOcrSettingsDialog } = await import("./ui/ocr-settings-dialog");
  const p = readOcrPrefs();
  const settings = await showOcrSettingsDialog(
    {
      detLimitSideLen: p.detLimitSideLen,
      detThresh: p.detThresh,
      detBoxThresh: p.detBoxThresh,
      detMaxRotDeg: p.detMaxRotDeg,
      cropMode: p.cropMode,
      ocrWorkers: p.ocrWorkers,
    },
    count === 1
      ? (resolution.jobs[0].attachment.getDisplayTitle?.() || "OCR PDF 设置")
      : `将对 ${count} 个 PDF 应用以下设置（仅本次生效）`,
  );
  if (!settings) {
    log("OCR PDF cancelled by user (settings dialog)");
    return;
  }

  const manager = ensureJobManager();
  // JobManager 对"已在队列/处理中"的附件 enqueue 会 throw——收集跳过数而不是
  // 让 forEach 中途炸断，静默丢掉剩余任务
  let skipped = 0;
  resolution.jobs.forEach((job, index) => {
    const queued = createJob(index, job.attachment, job.path, settings);
    try {
      manager.enqueue(queued);
      registerQueuedJobTab(queued);
    } catch {
      skipped++;
    }
  });
  if (skipped > 0) {
    OcrProgressDialog.notify("OCR PDF", `${skipped} 个附件已在队列中，已跳过。`);
  }
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
    detMaxRotDeg: req.detMaxRotDeg,
    cropMode: req.cropMode,
    ocrWorkers: req.ocrWorkers,
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
    const queued = createJob(0, renderItem, renderPath, extra);
    ensureJobManager().enqueue(queued);
    registerQueuedJobTab(queued);
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

  // 队列窗：显式取消进行中/排队的 OCR 任务（沿用旧"关窗即取消"语义），再关窗
  if (queueDialog) {
    queueDialog.requestCancelAll();
    queueDialog.close();
    queueDialog = null;
  }
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
    try {
      contextMenuController.register();
    } catch {
      // MenuManager 不可用时不崩溃，降级为无右键菜单
      contextMenuController = null;
    }
    // 兜底：加载时强制重建主条目右键菜单（修复被其它插件禁用搞坏的菜单）
    rebuildLibraryItemMenu();
  }
  unregisterReaderToolbar();
  registerReaderToolbar((req) => {
    void handlePageOcr(req).catch((err) => log(`page OCR: ${err instanceof Error ? err.message : String(err)}`));
  }, () => {
    const p = readOcrPrefs();
    return { detLimitSideLen: p.detLimitSideLen, detThresh: p.detThresh, detBoxThresh: p.detBoxThresh, detMaxRotDeg: p.detMaxRotDeg, cropMode: p.cropMode, ocrWorkers: p.ocrWorkers };
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
  queueDialog?.close();
  queueDialog = null;
  if (contextMenuController) {
    try { contextMenuController.unregister(); } catch { /* best-effort */ }
    contextMenuController = null;
    // 兜底：注销后强制重建菜单（实测压不住 shutdown 之后的破坏，尽力而为）
    rebuildLibraryItemMenu();
  }
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