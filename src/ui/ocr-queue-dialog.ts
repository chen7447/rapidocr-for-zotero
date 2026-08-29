/**
 * Queue-aware OCR progress window ("RapidOCR for Zotero").
 *
 * One window tracks the WHOLE JobManager queue: every enqueued job gets a
 * clickable tab (PDF1, PDF2, …); clicking a tab shows that task's progress,
 * timers and status. A queued task shows "等待中…（等待 PDFx 完成）" while
 * another task runs. "取消当前任务" aborts the running job only; "全部取消"
 * also clears the queue. Closing the window while tasks are active counts as
 * 全部取消 (same semantic as the old single-task dialog).
 *
 * Mirrors ocr-dialog.ts: HTML embedded, window via Services.ww.openWindow.
 * Lifecycle is driven from two places:
 *   - hooks.ts enqueues → addTask(jobId, title) so the tab appears at once
 *   - JobManager listener: onJobStarted → markRunning, onJobCancelled →
 *     finishTask (queued jobs killed by 全部取消 never reach the executor);
 *     the executor itself drives updateTask / finishTask(completed|failed).
 */

import { formatElapsed } from "./ocr-dialog";

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
  h1 { font-size: 16px; font-weight: 600; }
  #author { font-size: 11px; color: #6c7086; }
  #task-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; min-height: 26px; }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: 1px solid #45475a; border-radius: 14px;
    background: #313244; color: #cdd6f4; cursor: pointer; font-size: 12px;
  }
  .tab:hover { background: #45475a; }
  .tab.selected { border-color: #89b4fa; box-shadow: 0 0 0 1px #89b4fa inset; }
  .tab .st { font-size: 11px; }
  .st.queued { color: #f9e2af; }
  .st.running { color: #89b4fa; }
  .st.completed { color: #a6e3a1; }
  .st.failed { color: #f38ba8; }
  .st.cancelled { color: #6c7086; }
  progress {
    width: 100%; height: 8px; border: none; border-radius: 4px;
    appearance: none; -webkit-appearance: none;
  }
  progress::-webkit-progress-bar { background: #313244; border-radius: 4px; }
  progress::-webkit-progress-value { background: #89b4fa; border-radius: 4px; transition: width 0.3s ease; }
  progress::-moz-progress-bar { background: #89b4fa; border-radius: 4px; }
  #progress-text { font-size: 12px; color: #6c7086; margin-top: 6px; text-align: right; }
  #command-text {
    margin-top: 14px; font-size: 13px; color: #bac2de;
    line-height: 1.5; min-height: 40px; word-break: break-all;
  }
  .timer-line { margin-top: 6px; font-size: 12px; color: #6c7086; }
  #timer-total-val, #timer-ocr-val { font-weight: 600; }
  #timer-ocr-val { color: #a6e3a1; }
  #status-text { margin-top: 8px; font-size: 12px; color: #6c7086; min-height: 1.2em; }
  #status-text.error { color: #f38ba8; }
  #status-text.success { color: #a6e3a1; }
  #actions { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
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
  <div class="header">
    <h1>RapidOCR for Zotero</h1>
    <span id="author">--Chen7447</span>
  </div>
  <div id="task-tabs"></div>
  <progress id="progress-bar" value="0" max="100"></progress>
  <div id="progress-text">0%</div>
  <div id="command-text">正在初始化...</div>
  <div id="timer-total" class="timer-line">总用时 <span id="timer-total-val">0 s</span></div>
  <div id="timer-ocr" class="timer-line">RapidOCR 已运行 <span id="timer-ocr-val">0 s</span></div>
  <div id="status-text"></div>
  <div id="actions">
    <button id="cancel-current-btn" class="primary">取消当前任务</button>
    <button id="cancel-all-btn">全部取消</button>
    <button id="close-btn" class="hidden">关闭</button>
  </div>
</body>
</html>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string),
  );
}

export class OcrQueueDialog {
  private win: Window | null = null;
  private readonly tasks = new Map<string, QueueTask>();
  private readonly order: string[] = [];
  private selectedId: string | null = null;
  private runningId: string | null = null;
  /** Programmatic close (strip flow / shutdown) must NOT trigger cancel. */
  private detached = false;
  private tick: number | null = null;
  private onCancelCurrentCb: (() => void) | null = null;
  private onCancelAllCb: (() => void) | null = null;

  // ── lifecycle ───────────────────────────────────────────────────────

  open(): void {
    const win = (Services as unknown as {
      ww: { openWindow(parent: unknown, url: string, name: string, features: string, args: unknown): Window };
    }).ww.openWindow(null, "about:blank", "ocr-pdf-queue", "chrome,resizable,centerscreen,width=560,height=500", null);
    if (!win) throw new Error("无法打开 OCR 队列窗口");

    win.document.open();
    win.document.write(QUEUE_HTML);
    win.document.close();
    this.win = win;
    this.detached = false;

    win.document.getElementById("cancel-current-btn")?.addEventListener("click", () => {
      this.onCancelCurrentCb?.();
    });
    win.document.getElementById("cancel-all-btn")?.addEventListener("click", () => {
      this.requestCancelAll();
    });
    win.document.getElementById("close-btn")?.addEventListener("click", () => this.close());

    // User closes the window manually while tasks are active → 全部取消
    const winRef = win;
    win.addEventListener("beforeunload", () => {
      if (this.win !== winRef) return;
      this.win = null;
      if (this.tick !== null) { clearInterval(this.tick); this.tick = null; }
      if (!this.detached) this.requestCancelAll();
    });

    this.tick = setInterval(() => this.renderTimers(), 1000) as unknown as number;
  }

  setOnCancelCurrent(cb: () => void): void { this.onCancelCurrentCb = cb; }
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
  }

  // ── task model ──────────────────────────────────────────────────────

  /** Register a job as a tab (queued). Called right after enqueue. */
  addTask(id: string, title: string): void {
    if (this.tasks.has(id) || !this.win) return;
    this.tasks.set(id, {
      title, status: "queued", percent: 0, message: "",
      totalStart: 0, ocrStart: null, totalEnd: null, ocrEnd: null,
    });
    this.order.push(id);
    if (!this.selectedId) this.selectedId = id;
    this.renderTabs();
    this.renderDetail();
    this.renderButtons();
  }

  /** Job started running (JobManager onJobStarted). Auto-selects its tab. */
  markRunning(id: string, title: string): void {
    let t = this.tasks.get(id);
    if (!t) {
      if (!this.win) return;
      t = {
        title, status: "queued", percent: 0, message: "",
        totalStart: 0, ocrStart: null, totalEnd: null, ocrEnd: null,
      };
      this.tasks.set(id, t);
      this.order.push(id);
    }
    t.status = "running";
    t.totalStart = Date.now();
    t.ocrStart = null;
    t.totalEnd = null;
    t.ocrEnd = null;
    t.message = "正在准备…";
    this.runningId = id;
    this.selectedId = id;
    this.renderTabs();
    this.renderDetail();
    this.renderButtons();
  }

  /** Progress from the executor. percent < 0 updates the message only. */
  updateTask(id: string, percent: number, stage?: string, message?: string): void {
    const t = this.tasks.get(id);
    if (!t || !this.win) return;
    if (percent >= 0) t.percent = Math.min(100, Math.max(0, percent));
    if (stage === "alloc" && t.ocrStart === null) t.ocrStart = Date.now();
    if (message) t.message = message;
    if (id === this.selectedId) this.renderDetail();
  }

  /** Terminal state. Idempotent — cancelCurrent emits before the executor's catch. */
  finishTask(id: string, status: "completed" | "failed" | "cancelled", message: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return;
    t.status = status;
    t.totalEnd = Date.now();
    if (t.ocrStart !== null) t.ocrEnd = Date.now();
    t.message = message;
    const wasSelectedRunning = this.selectedId === id && this.runningId === id;
    if (this.runningId === id) this.runningId = null;
    if (wasSelectedRunning) {
      const nextId = this.order.find((k) => this.tasks.get(k)!.status === "running");
      if (nextId) { this.selectedId = nextId; this.runningId = nextId; }
    }
    if (this.win) {
      this.renderTabs();
      this.renderDetail();
      this.renderButtons();
    }
  }

  selectTask(id: string): void {
    if (!this.tasks.has(id)) return;
    this.selectedId = id;
    this.renderTabs();
    this.renderDetail();
  }

  // ── rendering ───────────────────────────────────────────────────────

  private tabLabel(id: string): string {
    return `PDF${this.order.indexOf(id) + 1}`;
  }

  private renderTabs(): void {
    const host = this.win?.document.getElementById("task-tabs");
    if (!host) return;
    host.innerHTML = this.order.map((id) => {
      const t = this.tasks.get(id)!;
      const sel = id === this.selectedId ? " selected" : "";
      return `<button type="button" class="tab${sel}" data-id="${esc(id)}" ` +
        `title="${esc(t.title)}（${STATUS_TEXT[t.status]}）">` +
        `<span>${this.tabLabel(id)}</span><span class="st ${t.status}">${STATUS_GLYPH[t.status]}</span></button>`;
    }).join("");
    host.querySelectorAll("button.tab").forEach((btn: Element) => {
      btn.addEventListener("click", (ev: Event) => {
        ev.preventDefault();
        const id = (ev.currentTarget as HTMLElement).dataset.id;
        if (id) this.selectTask(id);
      });
    });
  }

  private renderDetail(): void {
    const w = this.win;
    if (!w) return;
    const bar = w.document.getElementById("progress-bar") as HTMLProgressElement | null;
    const pct = w.document.getElementById("progress-text");
    const cmd = w.document.getElementById("command-text");
    const status = w.document.getElementById("status-text");
    const t = this.selectedId ? this.tasks.get(this.selectedId) : undefined;
    if (!t || !bar || !pct || !cmd || !status) return;

    if (t.status === "queued") {
      bar.value = 0;
      pct.textContent = "0%";
      const runningId = this.runningId;
      cmd.textContent = runningId
        ? `等待中…（等待 ${this.tabLabel(runningId)} 完成）`
        : "等待中…";
      status.textContent = "⏳ 等待中";
      status.className = "";
    } else if (t.status === "running") {
      bar.value = t.percent;
      pct.textContent = `${Math.round(t.percent)}%`;
      cmd.textContent = t.message || "处理中…";
      status.textContent = "";
      status.className = "";
    } else if (t.status === "completed") {
      bar.value = 100;
      pct.textContent = "100%";
      cmd.textContent = t.message;
      status.textContent = "✓ 完成";
      status.className = "success";
    } else if (t.status === "failed") {
      cmd.textContent = t.message;
      status.textContent = "✗ 失败";
      status.className = "error";
    } else {
      cmd.textContent = t.message;
      status.textContent = "已取消";
      status.className = "";
    }
    this.renderTimers();
  }

  private renderTimers(): void {
    const w = this.win;
    if (!w) return;
    const totalEl = w.document.getElementById("timer-total-val");
    const ocrEl = w.document.getElementById("timer-ocr-val");
    const t = this.selectedId ? this.tasks.get(this.selectedId) : undefined;
    if (!t || !totalEl || !ocrEl) return;
    const now = Date.now();
    const totalMs = t.totalStart > 0 ? (t.totalEnd ?? now) - t.totalStart : 0;
    const ocrMs = t.ocrStart !== null ? (t.ocrEnd ?? now) - t.ocrStart : 0;
    totalEl.textContent = formatElapsed(totalMs);
    ocrEl.textContent = formatElapsed(ocrMs);
  }

  private renderButtons(): void {
    const w = this.win;
    if (!w) return;
    const cancelCurrent = w.document.getElementById("cancel-current-btn") as HTMLButtonElement | null;
    const cancelAll = w.document.getElementById("cancel-all-btn") as HTMLButtonElement | null;
    const closeBtn = w.document.getElementById("close-btn");
    const anyActive = [...this.tasks.values()].some((t) => t.status === "queued" || t.status === "running");
    if (cancelCurrent) cancelCurrent.disabled = !this.runningId;
    if (cancelAll) cancelAll.disabled = !anyActive;
    if (closeBtn) closeBtn.classList.toggle("hidden", anyActive);
  }
}
