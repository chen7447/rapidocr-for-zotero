/**
 * Custom progress dialog for the "OCR PDF" right-click action.
 *
 * Opens a standalone chrome window with a progress bar, command text, and
 * cancel/close buttons — replacing Zotero's ProgressWindow notification.
 * A real window survives the context-menu popup lifecycle and gives the
 * user a clear, persistent view of what the worker is doing.
 *
 * The HTML is embedded (not fetched) and the window is opened via
 * Services.ww.openWindow — both avoid the async resource fetch and any
 * popup-blocker behavior that would silently prevent the window.
 */

import { t } from "../locale";

/** Re-evaluated per open() so a locale change is picked up. */
const dialogHtml = () => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #1e1e2e; color: #cdd6f4;
    padding: 24px; height: 100vh; display: flex; flex-direction: column;
    user-select: none;
  }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  #file-name {
    font-size: 12px; color: #6c7086; margin-bottom: 20px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  progress {
    width: 100%; height: 8px; border: none; border-radius: 4px;
    appearance: none; -webkit-appearance: none;
  }
  progress::-webkit-progress-bar { background: #313244; border-radius: 4px; }
  progress::-webkit-progress-value { background: #89b4fa; border-radius: 4px; transition: width 0.3s ease; }
  progress::-moz-progress-bar { background: #89b4fa; border-radius: 4px; }
  #progress-text { font-size: 12px; color: #6c7086; margin-top: 6px; text-align: right; }
  #command-text {
    margin-top: 16px; font-size: 13px; color: #bac2de;
    line-height: 1.5; min-height: 40px; word-break: break-all;
  }
  #status-text { margin-top: 8px; font-size: 12px; color: #6c7086; }
  .timer-line { margin-top: 6px; font-size: 12px; color: #6c7086; }
  #timer-total-val, #timer-ocr-val { font-weight: 600; }
  #timer-ocr-val { color: #a6e3a1; }
  #actions { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
  button {
    padding: 8px 20px; border: 1px solid #45475a; border-radius: 6px;
    background: #313244; color: #cdd6f4; cursor: pointer; font-size: 13px;
  }
  button:hover { background: #45475a; }
  button.primary { background: #89b4fa; color: #1e1e2e; border-color: #89b4fa; }
  button.primary:hover { background: #74c7ec; }
  .hidden { display: none !important; }
  #status-text.error { color: #f38ba8; }
  #status-text.success { color: #a6e3a1; }
</style>
</head>
<body>
  <h1 id="dialog-title">${t("strip.title")}</h1>
  <div id="file-name"></div>
  <progress id="progress-bar" value="0" max="100"></progress>
  <div id="progress-text">0%</div>
  <div id="command-text">${t("progress.initializing")}</div>
  <div id="timer-total" class="timer-line">${t("progress.totalTime")} <span id="timer-total-val">0 s</span></div>
  <div id="timer-ocr" class="timer-line">${t("progress.ocrTime")} <span id="timer-ocr-val">0 s</span></div>
  <div id="status-text"></div>
  <div id="actions">
    <button id="cancel-btn" class="primary">${t("common.cancel")}</button>
    <button id="close-btn" class="hidden">${t("common.close")}</button>
  </div>
</body>
</html>`;

/** "8 s" / "3 min 12 s" / "1 h 5 min 3 s" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min ${sec} s`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

export class OcrProgressDialog {
  private win: Window | null = null;
  private cancelled = false;
  private onCancelCallback: (() => void) | null = null;
  private totalInterval: number | null = null;
  private ocrInterval: number | null = null;
  private totalStart = 0;
  private ocrStart = 0;
  private ocrStarted = false;

  // ── lifecycle ───────────────────────────────────────────────────────

  /** Open the dialog window and populate it with the embedded HTML. */
  open(fileName: string, headline?: string): void {
    const win = (Services as unknown as {
      ww: {
        openWindow(
          parent: unknown,
          url: string,
          name: string,
          features: string,
          args: unknown,
        ): Window;
      };
    }).ww.openWindow(
      null,
      "about:blank",
      "ocr-pdf",
      "chrome,resizable,centerscreen,width=540,height=400",
      null,
    );
    if (!win) {
      throw new Error("无法打开进度窗口");
    }

    win.document.open();
    win.document.write(dialogHtml());
    win.document.close();

    const titleEl = win.document.getElementById("dialog-title");
    if (titleEl && headline) titleEl.textContent = headline;
    const nameEl = win.document.getElementById("file-name");
    if (nameEl) nameEl.textContent = fileName;

    // Wire cancel button
    const cancelBtn = win.document.getElementById("cancel-btn") as HTMLButtonElement | null;
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => this._onCancel());
    }
    const closeBtn = win.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }

    this.win = win;

    // 计时器(2)：总用时，从打开对话框/开始解析 PDF 起算
    this._startTotalTimer();

    // If the user closes the window manually, treat as cancel
    const winRef = win;
    win.addEventListener("beforeunload", () => {
      if (this.win === winRef) this.win = null;
      if (!this.cancelled) {
        this.cancelled = true;
        this.onCancelCallback?.();
      }
    });
  }

  /** Register a callback invoked when the user clicks the cancel button. */
  setOnCancel(callback: () => void): void {
    this.onCancelCallback = callback;
  }

  /** Whether the user has cancelled (or closed the window). */
  get isCancelled(): boolean {
    return this.cancelled || (this.win ? this.win.closed : false);
  }

  // ── updates ─────────────────────────────────────────────────────────

  /** Update the progress bar and the command/instruction text. */
  updateProgress(percent: number, stage?: string, command?: string): void {
    const w = this.win;
    if (!w) return;
    // 计时器(1)：纯 OCR 时间，从「已分配 n 核数」起算
    if (stage === "alloc") this._startOcrTimer();
    const bar = w.document.getElementById("progress-bar") as HTMLProgressElement | null;
    const pct = w.document.getElementById("progress-text");
    const cmd = w.document.getElementById("command-text");
    if (bar) bar.value = percent;
    if (pct) pct.textContent = `${percent}%`;
    if (cmd) cmd.textContent = command || `${percent}%`;
  }

  /** Show completion state — progress bar → 100%, status → "✓ 完成". */
  complete(message: string): void {
    this._stopTimers();
    const w = this.win;
    if (!w) return;
    const bar = w.document.getElementById("progress-bar") as HTMLProgressElement | null;
    const pct = w.document.getElementById("progress-text");
    const cmd = w.document.getElementById("command-text");
    const status = w.document.getElementById("status-text");
    const cancelBtn = w.document.getElementById("cancel-btn");
    const closeBtn = w.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (bar) bar.value = 100;
    if (pct) pct.textContent = "100%";
    if (cmd) cmd.textContent = message;
    if (status) { status.textContent = t("status.completed"); status.className = "success"; }
    if (cancelBtn) cancelBtn.classList.add("hidden");
    if (closeBtn) closeBtn.classList.remove("hidden");
  }

  /** Show failure state with the error message. */
  fail(message: string): void {
    this._stopTimers();
    const w = this.win;
    if (!w) return;
    const cmd = w.document.getElementById("command-text");
    const status = w.document.getElementById("status-text");
    const cancelBtn = w.document.getElementById("cancel-btn");
    const closeBtn = w.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (cmd) cmd.textContent = message;
    if (status) { status.textContent = t("status.failed"); status.className = "error"; }
    if (cancelBtn) cancelBtn.classList.add("hidden");
    if (closeBtn) closeBtn.classList.remove("hidden");
  }

  /** Show a brief notification (e.g. "no jobs") and auto-close after 3 s. */
  static notify(headline: string, message: string): void {
    const dlg = new OcrProgressDialog();
    try {
      dlg.open("");
      dlg._setCommand(headline);
      dlg._setStatus(message);
      const closeBtn = dlg.win?.document.getElementById("close-btn") as HTMLButtonElement | null;
      if (closeBtn) closeBtn.classList.remove("hidden");
      setTimeout(() => { try { dlg.close(); } catch {} }, 3500);
    } catch {
      // Best-effort: if the dialog fails to open, nothing worse than before.
    }
  }

  // ── internal ────────────────────────────────────────────────────────

  private _onCancel(): void {
    this.cancelled = true;
    this._stopTimers();
    this.onCancelCallback?.();
    const w = this.win;
    if (!w) return;
    const status = w.document.getElementById("status-text");
    const cancelBtn = w.document.getElementById("cancel-btn");
    const closeBtn = w.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (status) { status.textContent = t("status.cancelledShort"); status.className = ""; }
    if (cancelBtn) cancelBtn.classList.add("hidden");
    if (closeBtn) closeBtn.classList.remove("hidden");
  }

  private _setCommand(text: string): void {
    const el = this.win?.document.getElementById("command-text");
    if (el) el.textContent = text;
  }

  private _setStatus(text: string): void {
    const el = this.win?.document.getElementById("status-text");
    if (el) { el.textContent = text; el.className = ""; }
  }

  // ── timers ───────────────────────────────────────────────────────────

  private _startTotalTimer(): void {
    this._stopTimers();
    this.totalStart = Date.now();
    this._renderTimer("timer-total-val", 0);
    this.totalInterval = setInterval(() => {
      this._renderTimer("timer-total-val", Date.now() - this.totalStart);
    }, 1000) as unknown as number;
  }

  private _startOcrTimer(): void {
    if (this.ocrStarted) return;
    this.ocrStarted = true;
    this.ocrStart = Date.now();
    this._renderTimer("timer-ocr-val", 0);
    this.ocrInterval = setInterval(() => {
      this._renderTimer("timer-ocr-val", Date.now() - this.ocrStart);
    }, 1000) as unknown as number;
  }

  private _renderTimer(valId: string, ms: number): void {
    const el = this.win?.document.getElementById(valId);
    if (el) el.textContent = formatElapsed(ms);
  }

  private _stopTimers(): void {
    if (this.totalInterval !== null) { clearInterval(this.totalInterval); this.totalInterval = null; }
    if (this.ocrInterval !== null) { clearInterval(this.ocrInterval); this.ocrInterval = null; }
  }

  /** Force-close the window. */
  close(): void {
    this._stopTimers();
    this.onCancelCallback = null;
    if (this.win) {
      try { this.win.close(); } catch {}
      this.win = null;
    }
  }
}