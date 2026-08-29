/**
 * Queue-aware OCR progress window ("RapidOCR for Zotero").
 *
 * ONE window embeds ONE CARD per OCR job (用户要求的大窗套小窗布局):
 * every enqueued PDF gets its own card with an independent progress bar,
 * status, message and dual timers — all cards visible at once, no tabs.
 * A queued card shows 等待中…（等待《运行中文件》完成）. Every ACTIVE card
 * carries its own 取消 button (bottom-right): it cancels that job — running
 * or queued. 全部取消 clears current + queue; closing the window while tasks
 * are active counts as 全部取消.
 *
 * Rendering constraint (learned the hard way): in this chrome about:blank
 * window, innerHTML injection silently produced nothing — while every
 * getElementById + textContent / className update worked. So ALL dynamic
 * content is built with createElement / appendChild / textContent only,
 * the same DOM APIs as the parts that demonstrably work.
 *
 * Lifecycle: hooks.ts keeps ONE instance for the whole session (see
 * ensureQueueDialog) and re-opens it when closed — task history survives a
 * window close, and the instance↔window pairing is guarded by an open
 * token. Every mutation logs behind the pdfocrforzotero.debug pref
 * ("queue-dialog:" prefix) so a rendering report comes with evidence.
 */

import { formatElapsed } from "./ocr-dialog";

function qdbg(msg: string): void {
  try {
    if (!Zotero.Prefs.get("pdfocrforzotero.debug")) return;
  } catch {
    return;
  }
  Zotero.debug(`PDF OCR v3 queue-dialog: ${msg}`);
}

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** DOM handles for one card — all created via createElement (never innerHTML). */
type TaskRefs = {
  root: HTMLDivElement;
  state: HTMLSpanElement;
  bar: HTMLProgressElement;
  msg: HTMLSpanElement;
  pct: HTMLSpanElement;
  total: HTMLSpanElement;
  ocr: HTMLSpanElement;
  cancel: HTMLButtonElement;
};

type QueueTask = {
  title: string;
  status: TaskStatus;
  percent: number;
  message: string;
  /** Date.now when the job started running (0 = never started). */
  totalStart: number;
  /** Date.now when the job hit the "alloc" stage (pure OCR time). */
  ocrStart: number | null;
  totalEnd: number | null;
  ocrEnd: number | null;
  refs: TaskRefs | null;
};

const STATUS_GLYPH: Record<TaskStatus, string> = {
  queued: "…",
  running: "▶",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "等待",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const QUEUE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #1e1e2e; color: #cdd6f4;
    padding: 20px; height: 100vh; display: flex; flex-direction: column;
    user-select: none;
  }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 14px; flex: none; }
  #task-list {
    flex: 1 1 auto; overflow-y: auto;
    display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 14px;
  }
  .ocr-card {
    border: 1px solid #45475a; border-left: 4px solid #6c7086;
    border-radius: 8px; padding: 10px 12px; background: #181825;
    flex: none;
  }
  .ocr-card.st-queued    { border-left-color: #f9e2af; }
  .ocr-card.st-running   { border-left-color: #89b4fa; }
  .ocr-card.st-completed { border-left-color: #a6e3a1; }
  .ocr-card.st-failed    { border-left-color: #f38ba8; }
  .ocr-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .ocr-name {
    font-size: 13px; font-weight: 600; color: #cdd6f4;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ocr-state { font-size: 11px; flex: none; }
  .ocr-state.st-queued    { color: #f9e2af; }
  .ocr-state.st-running   { color: #89b4fa; }
  .ocr-state.st-completed { color: #a6e3a1; }
  .ocr-state.st-failed    { color: #f38ba8; }
  .ocr-state.st-cancelled { color: #6c7086; }
  progress {
    width: 100%; height: 6px; border: none; border-radius: 3px;
    appearance: none; -webkit-appearance: none;
  }
  progress::-webkit-progress-bar { background: #313244; border-radius: 3px; }
  progress::-webkit-progress-value { background: #89b4fa; border-radius: 3px; transition: width 0.3s ease; }
  progress::-moz-progress-bar { background: #89b4fa; border-radius: 3px; }
  .ocr-row {
    display: flex; justify-content: space-between; gap: 8px;
    margin-top: 6px; font-size: 12px; color: #bac2de;
  }
  .ocr-msg { word-break: break-all; }
  .ocr-pct { flex: none; color: #6c7086; }
  .ocr-timers { margin-top: 4px; font-size: 11px; color: #6c7086; }
  .ocr-foot { display: flex; justify-content: flex-end; margin-top: 8px; }
  .ocr-cancel {
    padding: 2px 12px; font-size: 11px; border-radius: 4px;
  }
  #actions { flex: none; display: flex; gap: 8px; justify-content: flex-end; }
  button {
    padding: 8px 16px; border: 1px solid #45475a; border-radius: 6px;
    background: #313244; color: #cdd6f4; cursor: pointer; font-size: 13px;
  }
  button:hover:not(:disabled) { background: #45475a; }
  button:disabled { opacity: 0.35; cursor: default; }
  button.primary { background: #89b4fa; color: #1e1e2e; border-color: #89b4fa; }
  button.primary:hover:not(:disabled) { background: #74c7ec; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <h1>RapidOCR for Zotero</h1>
  <div id="task-list"></div>
  <div id="actions">
    <button id="cancel-all-btn">全部取消</button>
    <button id="close-btn" class="hidden">关闭</button>
  </div>
</body>
</html>`;

export class OcrQueueDialog {
  private win: Window | null = null;
  private readonly tasks = new Map<string, QueueTask>();
  private readonly order: string[] = [];
  private runningId: string | null = null;
  /** Programmatic close (strip flow / shutdown) must NOT trigger cancel. */
  private detached = false;
  /** Guards the window-level beforeunload handler against stale reuse. */
  private openToken = 0;
  private tick: number | null = null;
  private onCancelTaskCb: ((jobId: string) => void) | null = null;
  private onCancelAllCb: (() => void) | null = null;

  // ── lifecycle ───────────────────────────────────────────────────────

  /**
   * Open (or re-open) the window. Task history is kept across re-opens —
   * hooks reuses one instance for the whole session, so the cards can never
   * end up in a different instance than the visible window.
   */
  open(): void {
    const token = ++this.openToken;
    const win = (Services as unknown as {
      ww: { openWindow(parent: unknown, url: string, name: string, features: string, args: unknown): Window };
    }).ww.openWindow(null, "about:blank", "ocr-pdf-queue", "chrome,resizable,centerscreen,width=560,height=520", null);
    if (!win) throw new Error("无法打开 OCR 队列窗口");

    win.document.open();
    win.document.write(QUEUE_HTML);
    win.document.close();
    this.win = win;
    this.detached = false;

    win.document.getElementById("cancel-all-btn")?.addEventListener("click", () => {
      this.requestCancelAll();
    });
    win.document.getElementById("close-btn")?.addEventListener("click", () => this.close());

    // User closes the window manually while tasks are active → 全部取消.
    // The token makes a listener left over from a previous open a no-op.
    const winRef = win;
    win.addEventListener("beforeunload", () => {
      if (this.openToken !== token || this.win !== winRef) return;
      this.win = null;
      if (this.tick !== null) { clearInterval(this.tick); this.tick = null; }
      if (!this.detached) {
        qdbg("window closed by user while tasks active → requestCancelAll");
        this.requestCancelAll();
      }
    });

    if (this.tick !== null) clearInterval(this.tick);
    // 每秒对账：卡片丢失/挂在旧文档上（环境原因可能发生）就重建，并刷新全部
    // 状态——窗口状态在 1 秒内自愈，不依赖单次渲染是否成功。
    this.tick = setInterval(() => {
      try { this.reconcile(); } catch (err) { qdbg(`reconcile failed: ${err}`); }
    }, 1000) as unknown as number;

    // Re-opened after a close: redraw the retained history.
    if (this.tasks.size) {
      qdbg(`re-opened with ${this.tasks.size} retained task(s)`);
      this.rebuildCards();
      this.renderButtons();
    }
    qdbg(`open: token=${token}`);
  }

  setOnCancelTask(cb: (jobId: string) => void): void { this.onCancelTaskCb = cb; }
  setOnCancelAll(cb: () => void): void { this.onCancelAllCb = cb; }

  isClosed(): boolean {
    return this.win === null || this.win.closed;
  }

  /** Fire 全部取消 (window X while active, cancel-all button, strip flow). */
  requestCancelAll(): void {
    this.onCancelAllCb?.();
  }

  /** Detach and close without cancelling anything. */
  close(): void {
    this.detached = true;
    if (this.tick !== null) { clearInterval(this.tick); this.tick = null; }
    const w = this.win;
    this.win = null;
    try { w?.close(); } catch { /* already closed */ }
    qdbg("close (detached)");
  }

  // ── task model ──────────────────────────────────────────────────────

  /** Register a job as a card (queued). Called right after enqueue. */
  addTask(id: string, title: string): void {
    if (this.tasks.has(id)) return;
    if (!this.win) {
      qdbg(`addTask(${id}) skipped: no window`);
      return;
    }
    this.tasks.set(id, {
      title, status: "queued", percent: 0, message: "",
      totalStart: 0, ocrStart: null, totalEnd: null, ocrEnd: null,
      refs: null,
    });
    this.order.push(id);
    qdbg(`addTask(${id}) "${title}" — tasks=${this.tasks.size}`);
    this.buildCard(id);
    this.renderButtons();
  }

  /** Job started running (JobManager onJobStarted). */
  markRunning(id: string, title: string): void {
    let t = this.tasks.get(id);
    if (!t) {
      if (!this.win) {
        qdbg(`markRunning(${id}) skipped: no window, no task`);
        return;
      }
      t = {
        title, status: "queued", percent: 0, message: "",
        totalStart: 0, ocrStart: null, totalEnd: null, ocrEnd: null,
        refs: null,
      };
      this.tasks.set(id, t);
      this.order.push(id);
    }
    // 新一批开始时清掉上一批的遗留卡片：没有其他进行中/排队任务，
    // 而窗口里还挂着已终态的旧卡片 → 全部移除（用户要求不保留旧卡）
    const othersActive = [...this.tasks.values()].some(
      (x) => x !== t && (x.status === "queued" || x.status === "running"),
    );
    if (!othersActive) {
      for (const k of [...this.order]) {
        const x = this.tasks.get(k);
        if (x && x !== t && x.status !== "queued" && x.status !== "running") this.removeTask(k);
      }
    }
    t.status = "running";
    t.totalStart = Date.now();
    t.ocrStart = null;
    t.totalEnd = null;
    t.ocrEnd = null;
    t.message = "正在准备…";
    this.runningId = id;
    qdbg(`markRunning(${id}) "${title}" — tasks=${this.tasks.size}`);
    this.paint(t);
    this.renderButtons();
  }

  /** Progress from the executor. percent < 0 updates the message only. */
  updateTask(id: string, percent: number, stage?: string, message?: string): void {
    const t = this.tasks.get(id);
    if (!t || !this.win) return;
    if (percent >= 0) t.percent = Math.min(100, Math.max(0, percent));
    if (stage === "alloc" && t.ocrStart === null) t.ocrStart = Date.now();
    if (message) t.message = message;
    this.paint(t);
  }

  /** Terminal state. Idempotent — cancelCurrent emits before the executor's catch. */
  finishTask(id: string, status: "completed" | "failed" | "cancelled", message: string): void {
    const t = this.tasks.get(id);
    if (!t) {
      qdbg(`finishTask(${id}) ignored: unknown task`);
      return;
    }
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return;
    t.status = status;
    t.totalEnd = Date.now();
    if (t.ocrStart !== null) t.ocrEnd = Date.now();
    t.message = message;
    if (this.runningId === id) this.runningId = null;
    qdbg(`finishTask(${id}) → ${status} — tasks=${this.tasks.size}`);
    this.paint(t);
    this.renderButtons();
    if (status === "completed" || status === "cancelled") {
      // 完成/取消的卡片 8 秒后自动移除——窗口只留进行中的任务
      setTimeout(() => this.removeTask(id), 8000);
    }
  }

  /** Drop a task and its card entirely (auto-cleanup / next-batch purge). */
  private removeTask(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    try { t.refs?.root.remove(); } catch { /* detached */ }
    this.tasks.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    qdbg(`removeTask(${id}) — tasks=${this.tasks.size}`);
    this.renderButtons();
  }

  // ── card rendering (createElement only — innerHTML is a proven no-op here) ──

  /**
   * 每秒对账自愈：
   * 1) 任务没有卡片、或卡片挂在旧文档/已断连 → 就地重建；
   * 2) 强制 DOM 卡片顺序 === 模型顺序（模型顺序 = 入队顺序，运行中的在前）——
   *    补建的卡片总是追加到末尾，若创建时序出过岔子，这里把它搬回正确位置；
   * 3) 重画全部状态。1 秒内收敛。
   */
  private reconcile(): void {
    const w = this.win;
    if (!w) return;
    const list = w.document.getElementById("task-list");
    if (!list) return;
    let rebuilt = 0;
    for (const id of [...this.order]) {
      const t = this.tasks.get(id);
      if (!t) continue;
      const stale = !t.refs
        || !t.refs.root.isConnected
        || t.refs.root.ownerDocument !== w.document;
      if (stale) {
        t.refs = null;
        this.buildCard(id);
        rebuilt++;
      }
    }
    let prev: Element | null = null;
    for (const id of this.order) {
      const node = this.tasks.get(id)?.refs?.root;
      if (!node) continue;
      if (node.previousElementSibling !== prev) {
        list.insertBefore(node, prev ? prev.nextSibling : list.firstElementChild);
      }
      prev = node;
    }
    for (const t of this.tasks.values()) this.paint(t);
    if (rebuilt) qdbg(`reconcile rebuilt ${rebuilt} card(s) — tasks=${this.tasks.size}`);
  }

  /** Rebuild every card from retained state (window re-open). */
  private rebuildCards(): void {
    const w = this.win;
    if (!w) return;
    const list = w.document.getElementById("task-list");
    if (!list) {
      qdbg("rebuildCards: #task-list not found");
      return;
    }
    list.textContent = ""; // drop stale children
    for (const t of this.tasks.values()) t.refs = null;
    for (const id of this.order) {
      if (this.tasks.has(id)) this.buildCard(id);
    }
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    parent: Element | null,
  ): HTMLElementTagNameMap[K] {
    const node = this.win!.document.createElement(tag);
    if (cls) node.className = cls;
    parent?.append(node);
    return node;
  }

  private buildCard(id: string): void {
    const w = this.win;
    const t = this.tasks.get(id);
    if (!w || !t || t.refs) return;
    const list = w.document.getElementById("task-list");
    if (!list) {
      qdbg(`buildCard(${id}): #task-list not found`);
      return;
    }
    const root = this.el("div", `ocr-card st-${t.status}`, list);
    const head = this.el("div", "ocr-head", root);
    const name = this.el("span", "ocr-name", head);
    name.textContent = t.title;
    name.title = t.title;
    const state = this.el("span", "ocr-state", head);
    const bar = this.el("progress", "", root) as HTMLProgressElement;
    bar.max = 100;
    const row = this.el("div", "ocr-row", root);
    const msg = this.el("span", "ocr-msg", row);
    const pct = this.el("span", "ocr-pct", row);
    const timers = this.el("div", "ocr-timers", root);
    timers.append("总用时 ");
    const total = this.el("span", "", timers);
    timers.append(" · RapidOCR ");
    const ocr = this.el("span", "", timers);
    const foot = this.el("div", "ocr-foot", root);
    const cancel = this.el("button", "ocr-cancel", foot) as HTMLButtonElement;
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", (ev: Event) => {
      ev.preventDefault();
      this.onCancelTaskCb?.(id);
    });

    t.refs = { root, state, bar, msg, pct, total, ocr, cancel };
    this.paint(t);
  }

  /** Push one task's state into its card. */
  private paint(t: QueueTask): void {
    const r = t.refs;
    if (!r) return;
    r.root.className = `ocr-card st-${t.status}`;
    r.state.textContent = `${STATUS_GLYPH[t.status]} ${STATUS_TEXT[t.status]}`;
    r.state.className = `ocr-state st-${t.status}`;
    if (t.status === "queued") {
      r.bar.value = 0;
      r.pct.textContent = "0%";
      const running = this.runningId ? this.tasks.get(this.runningId) : undefined;
      r.msg.textContent = running && running.status === "running"
        ? `等待中…（等待《${running.title}》完成）`
        : "等待中…";
    } else if (t.status === "running") {
      r.bar.value = t.percent;
      r.pct.textContent = `${Math.round(t.percent)}%`;
      r.msg.textContent = t.message || "处理中…";
    } else {
      if (t.status === "completed") {
        r.bar.value = 100;
        r.pct.textContent = "100%";
      }
      r.msg.textContent = t.message;
    }
    // 终态卡片不再提供取消入口
    r.cancel.classList.toggle("hidden", t.status !== "queued" && t.status !== "running");
    this.paintTimers(t);
  }

  private paintTimers(t: QueueTask): void {
    const r = t.refs;
    if (!r) return;
    const now = Date.now();
    const totalMs = t.totalStart > 0 ? (t.totalEnd ?? now) - t.totalStart : 0;
    const ocrMs = t.ocrStart !== null ? (t.ocrEnd ?? now) - t.ocrStart : 0;
    r.total.textContent = formatElapsed(totalMs);
    r.ocr.textContent = formatElapsed(ocrMs);
  }

  private renderButtons(): void {
    const w = this.win;
    if (!w) return;
    const cancelAll = w.document.getElementById("cancel-all-btn") as HTMLButtonElement | null;
    const closeBtn = w.document.getElementById("close-btn");
    const anyActive = [...this.tasks.values()].some((t) => t.status === "queued" || t.status === "running");
    if (cancelAll) cancelAll.disabled = !anyActive;
    if (closeBtn) closeBtn.classList.toggle("hidden", anyActive);
  }
}
