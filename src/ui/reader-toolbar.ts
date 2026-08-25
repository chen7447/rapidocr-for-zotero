import { PLUGIN_ID } from "./context-menu";
import { parsePageSpec } from "../ocr/page-spec";

export type PageOcrRequest = {
  itemID: number;
  pages1: number[];
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
};

export type StripRequest = {
  itemID: number;
  pages1: number[];
};

export type OcrPrefValues = {
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
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
let prefs: () => OcrPrefValues = () => ({ detLimitSideLen: 1536, detThresh: 0.3, detBoxThresh: 0.4 });

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
  const img = doc.createElement("img");
  img.src = "chrome://pdfocrforzotero/content/icons/pdf-ocr.svg";
  img.width = 16;
  img.height = 16;
  img.alt = "";
  btn.append(img);
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
    <label style="display:block;margin-bottom:10px">文本框过滤
      <input id="pdfocr-box" type="number" min="0" max="1" step="0.05" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detBoxThresh}">
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
