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

const DIALOG_HTML = `<!DOCTYPE html>
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
  <h1>Create Searchable PDF</h1>
  <div id="file-name"></div>
  <progress id="progress-bar" value="0" max="100"></progress>
  <div id="progress-text">0%</div>
  <div id="command-text">正在初始化...</div>
  <div id="status-text"></div>
  <div id="actions">
    <button id="cancel-btn" class="primary">取消</button>
    <button id="close-btn" class="hidden">关闭</button>
  </div>
</body>
</html>`;

export class OcrProgressDialog {
  private win: Window | null = null;
  private cancelled = false;
  private onCancelCallback: (() => void) | null = null;

  // ── lifecycle ───────────────────────────────────────────────────────

  /** Open the dialog window and populate it with the embedded HTML. */
  open(fileName: string): void {
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
    win.document.write(DIALOG_HTML);
    win.document.close();

    // Set the file name
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
  updateProgress(percent: number, _stage: string, command?: string): void {
    const w = this.win;
    if (!w) return;
    const bar = w.document.getElementById("progress-bar") as HTMLProgressElement | null;
    const pct = w.document.getElementById("progress-text");
    const cmd = w.document.getElementById("command-text");
    if (bar) bar.value = percent;
    if (pct) pct.textContent = `${percent}%`;
    if (cmd) cmd.textContent = command || `${percent}%`;
  }

  /** Show completion state — progress bar → 100%, status → "✓ 完成". */
  complete(message: string): void {
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
    if (status) { status.textContent = "✓ 完成"; status.className = "success"; }
    if (cancelBtn) cancelBtn.classList.add("hidden");
    if (closeBtn) closeBtn.classList.remove("hidden");
  }

  /** Show failure state with the error message. */
  fail(message: string): void {
    const w = this.win;
    if (!w) return;
    const cmd = w.document.getElementById("command-text");
    const status = w.document.getElementById("status-text");
    const cancelBtn = w.document.getElementById("cancel-btn");
    const closeBtn = w.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (cmd) cmd.textContent = message;
    if (status) { status.textContent = "✗ 失败"; status.className = "error"; }
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
    this.onCancelCallback?.();
    const w = this.win;
    if (!w) return;
    const status = w.document.getElementById("status-text");
    const cancelBtn = w.document.getElementById("cancel-btn");
    const closeBtn = w.document.getElementById("close-btn") as HTMLButtonElement | null;
    if (status) { status.textContent = "已取消"; status.className = ""; }
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

  /** Force-close the window. */
  close(): void {
    this.onCancelCallback = null;
    if (this.win) {
      try { this.win.close(); } catch {}
      this.win = null;
    }
  }
}