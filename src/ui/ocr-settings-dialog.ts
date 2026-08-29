/**
 * Pre-run settings dialog for the library "OCR PDF" menu action.
 *
 * Opens a small chrome window prefilled with the current preferences; the
 * user may fine-tune values for THIS run only — nothing writes back to
 * prefs. Resolves with the chosen settings, or null when cancelled/closed.
 *
 * Mirrors ocr-dialog.ts: HTML embedded, window via Services.ww.openWindow.
 * NOTE: native <select> dropdowns do NOT open in an about:blank chrome
 * window, so resolution / crop-mode are radio groups (native inputs, reliable).
 */

import { t } from "../locale";

export type OcrRunSettings = {
  detLimitSideLen: number;
  detThresh: number; // 0~1
  detBoxThresh: number; // 0~1
  detMaxRotDeg: number;
  cropMode: number;
  ocrWorkers: number;
};

/** Re-evaluated per open() so a locale change is picked up. */
const settingsHtml = () => `<!DOCTYPE html>
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
  h1 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  #file-label { font-size: 12px; color: #6c7086; margin-bottom: 16px; word-break: break-all; }
  .row { margin-bottom: 10px; }
  .lbl { display: block; font-size: 13px; color: #bac2de; margin-bottom: 4px; }
  .row input[type="number"] {
    width: 130px; padding: 4px 6px; border: 1px solid #45475a; border-radius: 6px;
    background: #313244; color: #cdd6f4; font-size: 13px;
  }
  .radios { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #bac2de; }
  .radios label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  #actions { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
  button {
    padding: 8px 20px; border: 1px solid #45475a; border-radius: 6px;
    background: #313244; color: #cdd6f4; cursor: pointer; font-size: 13px;
  }
  button:hover { background: #45475a; }
  button.primary { background: #89b4fa; color: #1e1e2e; border-color: #89b4fa; }
  button.primary:hover { background: #74c7ec; }
</style>
</head>
<body>
  <h1>${t("settings.title")}</h1>
  <div id="file-label"></div>
  <div class="row">
    <span class="lbl">${t("settings.res")}</span>
    <div class="radios" id="s-limit">
      <label><input type="radio" name="s-limit" value="512">512</label>
      <label><input type="radio" name="s-limit" value="768">768</label>
      <label><input type="radio" name="s-limit" value="960">960</label>
      <label><input type="radio" name="s-limit" value="1024">1024</label>
      <label><input type="radio" name="s-limit" value="1280">1280</label>
      <label><input type="radio" name="s-limit" value="1366">1366</label>
      <label><input type="radio" name="s-limit" value="1536">1536${t("toolbar.recommended")}</label>
      <label><input type="radio" name="s-limit" value="1920">1920</label>
    </div>
  </div>
  <div class="row"><span class="lbl">${t("settings.thresh")}</span><input type="number" id="s-thresh" min="0" max="1" step="0.05"/></div>
  <div class="row"><span class="lbl">${t("settings.box")}</span><input type="number" id="s-box" min="0" max="1" step="0.05"/></div>
  <div class="row"><span class="lbl">${t("settings.tilt")}</span><input type="number" id="s-maxrot" min="0" max="90" step="5"/></div>
  <div class="row">
    <span class="lbl">${t("settings.crop")}</span>
    <div class="radios" id="s-crop">
      <label><input type="radio" name="s-crop" value="0">${t("settings.crop0")}</label>
      <label><input type="radio" name="s-crop" value="1">${t("settings.crop1")}</label>
      <label><input type="radio" name="s-crop" value="2">${t("settings.crop2")}</label>
    </div>
  </div>
  <div class="row"><span class="lbl">${t("settings.workers")}</span><input type="number" id="s-workers" min="1" max="8" step="1"/></div>
  <div id="actions">
    <button id="s-cancel">${t("common.cancel")}</button>
    <button id="s-run" class="primary">${t("settings.run")}</button>
  </div>
</body>
</html>`;

/** Open the settings panel; resolve with settings on 运行, null on 取消/关闭. */
export function showOcrSettingsDialog(
  initial: OcrRunSettings,
  fileLabel: string,
): Promise<OcrRunSettings | null> {
  return new Promise((resolve) => {
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
      "ocr-pdf-settings",
      "chrome,resizable,centerscreen,width=520,height=430",
      null,
    );
    if (!win) {
      resolve(null);
      return;
    }

    win.document.open();
    win.document.write(settingsHtml());
    win.document.close();
    win.focus();

    const el = (id: string): HTMLInputElement | null =>
      win.document.getElementById(id) as HTMLInputElement | null;

    const setRadio = (name: string, value: string | number): void => {
      const r = win.document.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null;
      if (r) r.checked = true;
    };
    setRadio("s-limit", initial.detLimitSideLen);
    setRadio("s-crop", initial.cropMode);
    const setNum = (id: string, v: string): void => {
      const e = el(id);
      if (e) e.value = v;
    };
    setNum("s-thresh", String(initial.detThresh));
    setNum("s-box", String(initial.detBoxThresh));
    setNum("s-maxrot", String(initial.detMaxRotDeg));
    setNum("s-workers", String(initial.ocrWorkers));
    const label = win.document.getElementById("file-label");
    if (label) label.textContent = fileLabel;

    const num = (id: string, fallback: number, min = -Infinity, max = Infinity): number => {
      const e = el(id);
      const n = e ? parseFloat(e.value) : NaN;
      if (Number.isNaN(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    const radio = (name: string, fallback: number): number => {
      const r = win.document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null;
      const n = r ? Number(r.value) : NaN;
      return Number.isNaN(n) ? fallback : n;
    };

    let settled = false;
    const finish = (settings: OcrRunSettings | null): void => {
      if (settled) return;
      settled = true;
      resolve(settings);
      try { win.close(); } catch { /* already closed */ }
    };

    el("s-run")?.addEventListener("click", () => {
      finish({
        detLimitSideLen: Math.round(radio("s-limit", initial.detLimitSideLen)),
        detThresh: num("s-thresh", initial.detThresh, 0, 1),
        detBoxThresh: num("s-box", initial.detBoxThresh, 0, 1),
        detMaxRotDeg: Math.round(num("s-maxrot", initial.detMaxRotDeg, 0, 90)),
        cropMode: Math.round(radio("s-crop", initial.cropMode)),
        ocrWorkers: Math.round(num("s-workers", initial.ocrWorkers, 1, 8)),
      });
    });
    el("s-cancel")?.addEventListener("click", () => finish(null));
    win.addEventListener("beforeunload", () => finish(null));
  });
}
