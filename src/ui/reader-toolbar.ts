import { PLUGIN_ID } from "./context-menu";
import { parsePageSpec } from "../ocr/page-spec";
import { debugLog } from "../debug-log";
import { t } from "../locale";

export type OcrRegion = {
  /** 0-based page index this region belongs to. */
  pageIndex: number;
  /** PDF points (top-left origin, y-down), from annotation position. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PageOcrRequest = {
  itemID: number;
  pages1: number[];
  detLimitSideLen: number;
  detThresh: number;
  detBoxThresh: number;
  detMaxRotDeg: number;
  cropMode: number;
  ocrWorkers: number;
  twoColumn: boolean;
  /** Hand-drawn (Ink) region boxes: OCR writes region by region in draw order. */
  regions?: OcrRegion[];
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
    _state?: {
      primaryViewStats?: { pageIndex?: number; pagesCount?: number };
      /** Live annotations incl. unsaved hand-drawn Ink strokes. */
      annotations?: Array<{
        type?: string;
        position?: { pageIndex?: number; rects?: number[][]; paths?: number[][][] };
      }>;
    };
    _primaryView?: { _iframeWindow?: { PDFViewerApplication?: { page?: number; pagesCount?: number } } };
  };
};

const BTN_ID = "pdfocr-toolbar-btn";
const POP_ID = "pdfocr-toolbar-pop";
const PLACEHOLDER = 32;

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
  btn.title = t("toolbar.pageOcr");
  btn.setAttribute("aria-label", t("toolbar.pageOcr"));
  // 图标用 data URI 内联 SVG + currentColor:pdf.js iframe 沙箱内
  // chrome:// 与 context-fill 均无法解析,data URI 最可靠且跟随主题色。
  // 复用插件同一份 pdf-ocr.svg 的路径,仅把 context-fill 换成 currentColor。
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
  const s = `PDF OCR For Zotero v3: ${msg}`;
  debugLog.log(s);
  try { Zotero.debug(s); } catch {}
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

/** Any-shape bbox (PDF points) from an annotation position: rects/paths, nested arrays, or {lines/points} objects. */
export function regionBBox(pos: { rects?: unknown; paths?: unknown } | null | undefined): { x1: number; y1: number; x2: number; y2: number } | null {
  const pts: Array<[number, number]> = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || pts.length > 5000) return;
    if (Array.isArray(v)) {
      if (v.length >= 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i] as number, v[i + 1] as number]);
        return;
      }
      for (const c of v) walk(c, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of ["paths", "lines", "points", "rects"]) walk((v as Record<string, unknown>)[k], depth + 1);
    }
  };
  walk(pos?.rects, 0);
  walk(pos?.paths, 0);
  if (pts.length < 2) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  return { x1, y1, x2, y2 };
}

type RegionAnn = { type?: string; position?: { pageIndex?: number; rects?: unknown; paths?: unknown } };

/** Hand-drawn-like annotations (Select Area = image / pen = ink) on the current page, live state falling back to the DB. */
async function collectRegions(reader: ReaderLike): Promise<OcrRegion[]> {
  const page0 = currentPage(reader) - 1;
  let anns: RegionAnn[] = [];
  let src = "live";
  try {
    anns = reader._internalReader?._state?.annotations ?? [];
  } catch { /* fall through to db */ }
  if (!anns.length && reader.itemID) {
    try {
            const item = Zotero.Items.get(reader.itemID);
      const db = item ? await item.getAnnotations?.() : undefined;
      anns = (Array.isArray(db) ? db : []).map((a) => {
        let position: unknown;
        try { position = JSON.parse(a.annotationPosition); } catch { return null; }
        return { type: a.annotationType, position } as RegionAnn;
      }).filter((a): a is RegionAnn => a !== null);
      src = "db";
    } catch { /* best-effort */ }
  }
  const regions: OcrRegion[] = [];
  const srcs: string[] = [];
  for (const a of anns) {
        // Zotero 10 的「选择区域」工具实际生成 type=image 标注（rects）；兼容画笔 ink。
    if (a.type !== "image" && a.type !== "ink") continue;
    const pos = a.position;
    if (!pos || pos.pageIndex !== page0) continue;
    const bb = regionBBox(pos);
    if (bb) {
      regions.push({ pageIndex: page0, ...bb });
      const k = (a as unknown as { annotationKey?: string }).annotationKey ?? "?";
      srcs.push(`${k}[${Math.round(bb.x1)},${Math.round(bb.y1)}~${Math.round(bb.x2)},${Math.round(bb.y2)}]`);
    }
  }
  dbg(`regions(${src}) page=${page0} anns=${anns.length} kept=${regions.length} ${srcs.join(" ")}`);
  return regions;
}

function dismissPop(doc: Document): void {
  doc.getElementById(POP_ID)?.remove();
  doc.getElementById(SHIELD_ID)?.remove();
}

/** 「双栏版面」不跨次记忆:每次弹窗都从不勾选开始(旧版按 itemID 记住上次状态,
 *  会让一次普通整页 OCR 悄悄走双栏顺序 —— 用户报告"我没选却被影响")。 */
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
    <label style="display:block;margin-bottom:8px">${t("toolbar.pages")}
      <input id="pdfocr-pages" type="text" style="width:100%;margin-top:2px;box-sizing:border-box"
        value="${currentPage(reader)}" placeholder="${t("toolbar.pagesHint")}">
    </label>
    <label style="display:block;margin-bottom:6px">${t("toolbar.res")}
      <select id="pdfocr-limit" style="width:100%;margin-top:2px">
        ${[512, 768, 960, 1024, 1280, 1366, 1536, 1920].map((n) =>
          `<option value="${n}"${n === p.detLimitSideLen ? " selected" : ""}>${n}${n === 1536 ? t("toolbar.recommended") : ""}${n === 1920 ? t("toolbar.largeScan") : ""}</option>`,
        ).join("")}
      </select>
    </label>
    <label style="display:block;margin-bottom:6px">${t("toolbar.thresh")}
      <input id="pdfocr-thresh" type="number" min="0" max="1" step="0.05" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detThresh}">
    </label>
    <label style="display:block;margin-bottom:6px">${t("toolbar.box")}
      <input id="pdfocr-box" type="number" min="0" max="1" step="0.05" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detBoxThresh}">
    </label>
    <label style="display:block;margin-bottom:10px">${t("toolbar.tilt")}
      <input id="pdfocr-maxrot" type="number" min="0" max="90" step="5" style="width:100%;margin-top:2px;box-sizing:border-box" value="${p.detMaxRotDeg}">
    </label>
    <label style="display:block;margin-bottom:10px">${t("toolbar.crop")}
      <select id="pdfocr-cropmode" style="width:100%;margin-top:2px">
        <option value="0"${p.cropMode === 0 ? " selected" : ""}>${t("toolbar.crop0")}</option>
        <option value="1"${p.cropMode === 1 ? " selected" : ""}>${t("toolbar.crop1")}</option>
        <option value="2"${p.cropMode === 2 ? " selected" : ""}>${t("toolbar.crop2")}</option>
      </select>
    </label>
    <label style="display:block;margin-bottom:10px">${t("toolbar.workers")}
      <select id="pdfocr-workers" style="width:100%;margin-top:2px">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
          `<option value="${n}"${n === p.ocrWorkers ? " selected" : ""}>${n} ${t("toolbar.coresUnit")}${n === 4 ? t("toolbar.recommended") : ""}</option>`,
        ).join("")}
      </select>
    </label>
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer">
      <input id="pdfocr-twocol" type="checkbox">${t("toolbar.twoColumn")}
    </label>
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer" title="${t("toolbar.regionsTip")}">
      <input id="pdfocr-regions" type="checkbox" checked>${t("toolbar.regions")} <span id="pdfocr-regionn" style="opacity:.55"></span>
    </label>
    <button id="pdfocr-go" type="button" style="width:100%;padding:6px 0;border:0;border-radius:6px;background:#89b4fa;color:#1e1e2e;font-weight:600;cursor:pointer">OCR</button>
    <button id="pdfocr-strip" type="button" title="${t("toolbar.stripTip")}" style="width:100%;margin-top:6px;padding:6px 0;border:1px solid #45475a;border-radius:6px;background:#313244;color:#cdd6f4;cursor:pointer">${t("toolbar.strip")}</button>
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
      err.textContent = n > 0 ? t("toolbar.errPages") : t("toolbar.errCount");
      return null;
    }
    if (!reader.itemID) {
      err.textContent = t("toolbar.errItem");
      return null;
    }
    return pages1;
  };

  const run = async (kind: "ocr" | "strip") => {
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
            twoColumn: !!(pop.querySelector("#pdfocr-twocol") as HTMLInputElement)?.checked,
            regions: !!(pop.querySelector("#pdfocr-regions") as HTMLInputElement)?.checked
              ? await collectRegions(reader)
              : undefined,
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
    void run(el.id === "pdfocr-strip" ? "strip" : "ocr");
  });

  const refreshRegionCount = (): void => {
    const el = pop.querySelector("#pdfocr-regionn");
    if (!el) return;
    if (!(pop.querySelector("#pdfocr-regions") as HTMLInputElement | null)?.checked) { el.textContent = ""; return; }
    void collectRegions(reader).then((rs) => {
      // 圈没被吃到时必须说话:标注是按附件存的,画在原件上的圈不会跟到 [OCR] 派生文件,
      // 于是这一轮其实走了整页识别(实测用户因此以为"识别结果和圈的内容不一致")。
      el.textContent = rs.length ? `— 本页 ${rs.length} 个圈,只识别圈内的整行` : `— 本页没有圈,将识别整页!`;
      (el as unknown as { style: { color: string } }).style.color = rs.length ? "" : "#f38ba8";
    });
  };
  pop.querySelector("#pdfocr-regions")?.addEventListener("change", refreshRegionCount);
  refreshRegionCount();
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
