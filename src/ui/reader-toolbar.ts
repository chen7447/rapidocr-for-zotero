import { PLUGIN_ID } from "./context-menu";
import { parsePageSpec } from "../ocr/page-spec";

export type PageOcrRequest = {
  itemID: number;
  pages1: number[];
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
  detMaxRotDeg: number;
  cropMode: number;
  ocrWorkers: number;
};

export type StripRequest = {
  itemID: number;
  pages1: number[];
};

export type OcrPrefValues = {
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
  detMaxRotDeg: number;
  cropMode: number;
  ocrWorkers: number;
};

type ReaderLike = {
  type?: string;
  itemID?: number;
  state?: { pageIndex?: number };
  setToolbarPlaceholderWidth?: (w: number) => Promise<void> | void;
  _internalReader?: {
    _state?: { primaryViewStats?: { pageIndex?: number; pagesCount?: number } };
    _primaryView?: { _iframeWindow?: { PDFViewerApplication?: { page?: number; pagesCount?: number } } };
  };
};

const BTN_ID = "pdfocr-toolbar-btn";
const POP_ID = "pdfocr-toolbar-pop";
const PLACEHOLDER = 32;
const STRIP_TIP = "删除 OCR 文字层（该按钮测试使用，不影响 OCR 正常进行）";

let onSubmit: ((req: PageOcrRequest) => void) | null = null;
let onStrip: ((req: StripRequest) => void) | null = null;
let prefs: () => OcrPrefValues = () => ({ detLimitSideLen: 1536, detThresh: 0.3, detBoxThresh: 0.4, detMaxRotDeg: 30, cropMode: 2, ocrWorkers: 4 });

function onRenderToolbar(event: {
  reader: ReaderLike;
  doc: Document;
  append: (...nodes: Array<Node | string>) => void;
}): void {
  const { reader, doc, append } = event;
  if (reader.type && reader.type !== "pdf") return;
  if (doc.getElementById(BTN_ID)) return;

  const wrap = doc.createElement("div");
  wrap.style.cssText = "position:relative;display:flex;align-items:center;";

  const btn = doc.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.className = "toolbar-button";
  btn.title = "OCR 当前页";
  btn.setAttribute("aria-label", "OCR 当前页");
  // 图标用 data URI 内联 SVG + currentColor：pdf.js iframe 沙箱内
  // chrome:// 与 context-fill 均无法解析，data URI 最可靠且跟随主题色。
  // 复用插件同一份 pdf-ocr.svg 的路径，仅把 context-fill 换成 currentColor。
  const ICON_DATA_URI =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path fill="currentColor" d="M2.5 1A1.5 1.5 0 0 0 1 2.5v9A1.5 1.5 0 0 0 2.5 13h4.1A4.5 4.5 0 0 1 7 11.5H2.5a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H7v3h3.5V7c.52 0 1.02.07 1.5.2V4.5L8.5 1H2.5zm6 .8L10.7 4H8.5V1.8zM4 6.5h4.5V8H4V6.5zM4 9h3v1.5H4V9z"/>
  <path fill="currentColor" fill-rule="evenodd" d="M11.5 8a3.5 3.5 0 1 0 2.12 6.28l1.55 1.55a.75.75 0 1 0 1.06-1.06l-1.55-1.55A3.5 3.5 0 0 0 11.5 8zM9.5 11.5a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/>
</svg>`);
  btn.style.backgroundImage = `url('${ICON_DATA_URI}')`;
  btn.style.backgroundSize = "16px 16px";
  btn.style.backgroundPosition = "center";
  btn.style.backgroundRepeat = "no-repeat";
  btn.style.color = "currentColor";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    togglePop(doc, reader, btn);
  });
  wrap.append(btn);
  append(wrap);
  void reader.setToolbarPlaceholderWidth?.(PLACEHOLDER);
}

function dbg(msg: string): void {
  try { Zotero.debug(`PDF OCR For Zotero v3: ${msg}`); } catch {}
}

function pdfApp(reader: ReaderLike) {
  try {
    return reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication;
  } catch {
    return undefined;
  }
}

function pageCount(reader: ReaderLike): number {
  try {
    return pdfApp(reader)?.pagesCount
      || reader._internalReader?._state?.primaryViewStats?.pagesCount
      || 0;
  } catch {
    return 0;
  }
}

/** Live page: pdf.js viewer (same number as the thumbnail sidebar), not saved reader.state. */
function currentPage(reader: ReaderLike): number {
  try {
    const live = pdfApp(reader)?.page;
    if (typeof live === "number" && live >= 1) return live;
    const stats = reader._internalReader?._state?.primaryViewStats?.pageIndex;
    if (typeof stats === "number" && stats >= 0) return stats + 1;
    return (reader.state?.pageIndex ?? 0) + 1;
  } catch {
    return 1;
  }
}

const SHIELD_ID = POP_ID + "-shield";

function dismissPop(doc: Document): void {
  doc.getElementById(POP_ID)?.remove();
  doc.getElementById(SHIELD_ID)?.remove();
}

function togglePop(doc: Document, reader: ReaderLike, btn: HTMLElement): void {
  if (doc.getElementById(POP_ID)) {
    dismissPop(doc);
    return;
  }
  const p = prefs();
  const r = btn.getBoundingClientRect();
  const pop = doc.createElement("div");
  pop.id = POP_ID;
  pop.style.cssText = [
    "position:fixed",
    `top:${Math.round(r.bottom + 6)}px`,
    `left:${Math.round(Math.max(8, r.right - 240))}px`,
    "z-index:2147483647",
    "pointer-events:auto",
    "width:240px",
    "padding:10px",
    "border-radius:8px",
    "background:#1e1e2e",
    "color:#cdd6f4",
    "font:12px/1.4 system-ui,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.4)",
  ].join(";");
  pop.innerHTML = `
    <label style="display:block;margin-bottom:8px">页码
      <input id="pdfocr-pages" type="text" style="width:100%;margin-top:2px;box-sizing:border-box"
        value="${currentPage(reader)}" placeholder="3 或 3,5,7-9">
    </label>
    <label style="display:block;margin-bottom:6px">检测分辨率
      <select id="pdfocr-limit" style="width:100%;margin-top:2px">
        ${[512, 768, 960, 1024, 1280, 1366, 1536, 1920].map((n) =>
          `<option value="${n}"${n === p.detLimitSideLen ? " selected" : ""}>${n}${n === 1536 ? "（推荐）" : ""}${n === 1920 ? "（大版面/扫描件）" : ""}</option>`,
        ).join("")}
      </select>
    </label>
    <label style="display:block;margin-bottom:6px">检测灵敏度
      <input id="pdfocr-thresh" type="number" min="0" max="1" step="0.05" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detThresh}">
    </label>
    <label style="display:block;margin-bottom:6px">文本框过滤
      <input id="pdfocr-box" type="number" min="0" max="1" step="0.05" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detBoxThresh}">
    </label>
    <label style="display:block;margin-bottom:10px">倾斜过滤（度）
      <input id="pdfocr-maxrot" type="number" min="0" max="90" step="5" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detMaxRotDeg}">
    </label>
    <label style="display:block;margin-bottom:10px">识别模式
      <select id="pdfocr-cropmode" style="width:100%;margin-top:2px">
        <option value="0"${p.cropMode === 0 ? " selected" : ""}>直立正文（AABB 直接裁剪）</option>
        <option value="1"${p.cropMode === 1 ? " selected" : ""}>倾斜正文（旋转矫正）</option>
        <option value="2"${p.cropMode === 2 ? " selected" : ""}>复合方法（推荐）</option>
      </select>
    </label>
    <label style="display:block;margin-bottom:10px">并行核心数
      <select id="pdfocr-workers" style="width:100%;margin-top:2px">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
          `<option value="${n}"${n === p.ocrWorkers ? " selected" : ""}>${n} 核${n === 4 ? "（推荐）" : ""}</option>`,
        ).join("")}
      </select>
    </label>
    <button id="pdfocr-go" type="button" style="width:100%;padding:6px 0;border:0;border-radius:6px;background:#89b4fa;color:#1e1e2e;font-weight:600;cursor:pointer">OCR</button>
    <button id="pdfocr-strip" type="button" title="${STRIP_TIP}" style="width:100%;margin-top:6px;padding:6px 0;border:1px solid #45475a;border-radius:6px;background:#313244;color:#cdd6f4;cursor:pointer">删除 OCR 文字层</button>
    <div id="pdfocr-err" style="color:#f38ba8;margin-top:6px;min-height:1em"></div>
  `;
  const host = doc.body ?? doc.documentElement;
  if (!host) return;
  const shield = doc.createElement("div");
  shield.id = SHIELD_ID;
  shield.style.cssText = "position:fixed;inset:0;z-index:2147483646";
  host.append(shield, pop);
  shield.addEventListener("click", (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
    dismissPop(doc);
  });

  const readPages = (): number[] | null => {
    const spec = (pop.querySelector("#pdfocr-pages") as HTMLInputElement).value;
    const n = pageCount(reader);
    const pages1 = parsePageSpec(spec, n, currentPage(reader));
    const err = pop.querySelector("#pdfocr-err") as HTMLElement;
    if (!pages1.length) {
      err.textContent = n > 0 ? "页码无效" : "无法读取页数";
      return null;
    }
    if (!reader.itemID) {
      err.textContent = "无法确定当前附件";
      return null;
    }
    return pages1;
  };

  const run = (kind: "ocr" | "strip") => {
    dbg(`${kind} click item=${reader.itemID} pages=${(pop.querySelector("#pdfocr-pages") as HTMLInputElement)?.value} count=${pageCount(reader)}`);
    try {
      const pages1 = readPages();
      if (!pages1) {
        dbg(`${kind} aborted: invalid pages or item`);
        return;
      }
      const req = kind === "ocr"
        ? {
            itemID: reader.itemID!,
            pages1,
            detLimitSideLen: Number((pop.querySelector("#pdfocr-limit") as HTMLSelectElement).value) || p.detLimitSideLen,
            detThresh: clamp01((pop.querySelector("#pdfocr-thresh") as HTMLInputElement).value, p.detThresh),
            detBoxThresh: clamp01((pop.querySelector("#pdfocr-box") as HTMLInputElement).value, p.detBoxThresh),
            detMaxRotDeg: clampDeg((pop.querySelector("#pdfocr-maxrot") as HTMLInputElement).value, p.detMaxRotDeg),
            cropMode: clampMode((pop.querySelector("#pdfocr-cropmode") as HTMLSelectElement).value, p.cropMode),
            ocrWorkers: Math.max(1, Math.min(8, Number((pop.querySelector("#pdfocr-workers") as HTMLSelectElement).value) || p.ocrWorkers)),
          }
        : { itemID: reader.itemID!, pages1 };
      dismissPop(doc);
      if (kind === "ocr") onSubmit?.(req as PageOcrRequest);
      else onStrip?.(req);
    } catch (err) {
      dbg(`${kind} threw: ${err instanceof Error ? err.message : String(err)}`);
      const errEl = pop.querySelector("#pdfocr-err") as HTMLElement | null;
      if (errEl) errEl.textContent = String(err);
    }
  };

  pop.addEventListener("click", (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest?.("#pdfocr-go, #pdfocr-strip");
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    run(el.id === "pdfocr-strip" ? "strip" : "ocr");
  });
}

function clamp01(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampDeg(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(0, n));
}

function clampMode(raw: string, fallback: number): number {
  const n = Number(raw);
  if (n !== 0 && n !== 1 && n !== 2) return fallback;
  return n;
}

export function registerReaderToolbar(
  submit: (req: PageOcrRequest) => void,
  getPrefs: () => OcrPrefValues,
  strip?: (req: StripRequest) => void,
): void {
  onSubmit = submit;
  prefs = getPrefs;
  onStrip = strip ?? null;
  const Reader = (Zotero as unknown as {
    Reader?: {
      registerEventListener: (type: string, handler: typeof onRenderToolbar, pluginID?: string) => void;
    };
  }).Reader;
  Reader?.registerEventListener("renderToolbar", onRenderToolbar, PLUGIN_ID);
}

export function unregisterReaderToolbar(): void {
  onSubmit = null;
  onStrip = null;
  const Reader = (Zotero as unknown as {
    Reader?: {
      unregisterEventListener: (type: string, handler: typeof onRenderToolbar) => void;
    };
  }).Reader;
  Reader?.unregisterEventListener("renderToolbar", onRenderToolbar);
}
