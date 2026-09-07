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

/** Zotero 原生「选择区域」按钮图标(res/icons/20/annotate-area.svg,currentColor)。 */
const AREA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none">
  <path d="M12 1.75H8V3H12V1.75Z" fill="currentColor"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M4 4V16H16V4H4ZM14.75 5.25H5.25V14.75H14.75V5.25Z" fill="currentColor"/>
  <path d="M17 14H18.25V18.25H14V17H17V14Z" fill="currentColor"/>
  <path d="M18.25 8H17V12H18.25V8Z" fill="currentColor"/>
  <path d="M1.75 8H3V12H1.75V8Z" fill="currentColor"/>
  <path d="M8 17H12V18.25H8V17Z" fill="currentColor"/>
  <path d="M14 3H17V6H18.25V1.75H14V3Z" fill="currentColor"/>
  <path d="M3 3V6H1.75L1.75 1.75H6V3H3Z" fill="currentColor"/>
  <path d="M6 17H3L3 14L1.75 14V18.25H6V17Z" fill="currentColor"/>
</svg>`;

/** OCR 主按钮「扫描文本」图标:四角扫描框 + 文字行,语义即 OCR。 */
const SCAN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 6V4.5A1.5 1.5 0 0 1 4.5 3H6"/>
  <path d="M10 3h1.5A1.5 1.5 0 0 1 13 4.5V6"/>
  <path d="M13 10v1.5a1.5 1.5 0 0 1-1.5 1.5H10"/>
  <path d="M6 13H4.5A1.5 1.5 0 0 1 3 11.5V10"/>
  <path d="M6 6.5h4"/>
  <path d="M6 9.5h4"/>
</svg>`;

/** 橡皮擦图标(Lucide eraser 24→16 等比缩放,「擦除」语义)。 */
const ERASER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="m4.67 14-2.87-2.87c-.67-.67-.67-1.67 0-2.27l6.4-6.4c1.33-1.33 3.33-1.33 4.67 0l2.27 2.27c1.33 1.33 1.33 3.33 0 4.67l-4.4 4.4c-.33.33-.8.53-1.33.53H4.67Z"/>
  <path d="m3.33 7.33 6 6"/>
</svg>`;

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
  const wrap = createToolbarButton(doc, reader);
  append(wrap);
  void reader.setToolbarPlaceholderWidth?.(PLACEHOLDER);
}

/** 创建工具栏按钮节点(wrap>btn),与事件路径/补挂路径共用。 */
function createToolbarButton(doc: Document, reader: ReaderLike): HTMLDivElement {
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
  return wrap;
}

/** 补挂路径:直接塞进 toolbar 的 custom-sections 容器(与事件 append 同一容器)。 */
function ensureToolbarButton(doc: Document, reader: ReaderLike, container: Element): void {
  if (doc.getElementById(BTN_ID)) return;
  const wrap = createToolbarButton(doc, reader);
  container.append(wrap);
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
const POP_CSS_ID = POP_ID + "-css";

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
    "background:var(--pdfocr-pop-bg)",
    "color:var(--pdfocr-pop-text)",
    "font:12px/1.4 system-ui,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.4)",
  ].join(";");
  // 主题变量:宿主 reader iframe 随系统亮暗(prefers-color-scheme)切换;
  // Zotero 自身主题独立于系统时退回暗色,可接受(DeepSeek 评审结论)。
  if (!doc.getElementById(POP_CSS_ID)) {
    const st = doc.createElement("style");
    st.id = POP_CSS_ID;
    st.textContent = `#${POP_ID}{
  --pdfocr-pop-bg:#1e1e2e; --pdfocr-pop-text:#cdd6f4;
  --pdfocr-pop-sec:#313244; --pdfocr-pop-border:#45475a;
  --pdfocr-pop-accent:#89b4fa; --pdfocr-pop-onaccent:#1e1e2e;
  --pdfocr-pop-err:#f38ba8;
}
@media (prefers-color-scheme: light){
  #${POP_ID}{
    --pdfocr-pop-bg:#ffffff; --pdfocr-pop-text:#4c4f69;
    --pdfocr-pop-sec:#e6e9ef; --pdfocr-pop-border:#ccd0da;
    --pdfocr-pop-accent:#1e66f5; --pdfocr-pop-onaccent:#ffffff;
    --pdfocr-pop-err:#d20f39;
  }
}
#${POP_ID} input,#${POP_ID} select{width:100%;margin-top:2px;box-sizing:border-box}
#${POP_ID} #pdfocr-go{width:100%;padding:7px 0;border:0;border-radius:6px;background:var(--pdfocr-pop-accent);color:var(--pdfocr-pop-onaccent);font-weight:600;cursor:pointer;text-align:center}
#${POP_ID} #pdfocr-strip,#${POP_ID} #pdfocr-draw{width:100%;padding:5px 8px;border:1px solid var(--pdfocr-pop-border);border-radius:6px;background:var(--pdfocr-pop-sec);color:var(--pdfocr-pop-text);cursor:pointer;font:inherit;text-align:center}
#${POP_ID} #pdfocr-strip{margin-top:6px}
#${POP_ID} #pdfocr-draw{margin:0 0 10px;padding:4px 8px;text-align:center}
#${POP_ID} #pdfocr-draw[hidden]{display:none}
#${POP_ID} #pdfocr-err{color:var(--pdfocr-pop-err);margin-top:6px;min-height:0;word-break:break-all}
#${POP_ID} .pdfocr-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;margin-bottom:10px;cursor:pointer}
#${POP_ID} .pdfocr-row input[type="checkbox"]{width:auto}
#${POP_ID} label.pdfocr-field{display:block;margin-bottom:10px}
#${POP_ID} details.pdfocr-adv{margin-bottom:10px}
#${POP_ID} details.pdfocr-adv>summary{list-style:none;cursor:pointer;padding:5px 8px;border:1px solid var(--pdfocr-pop-border);border-radius:6px;background:var(--pdfocr-pop-sec);color:var(--pdfocr-pop-text);text-align:center;user-select:none}
#${POP_ID} details.pdfocr-adv>summary::-webkit-details-marker{display:none}
#${POP_ID} details.pdfocr-adv[open]>summary{border-bottom-left-radius:0;border-bottom-right-radius:0}
#${POP_ID} details.pdfocr-adv>div{padding:10px 4px 0;border:1px solid var(--pdfocr-pop-border);border-top:0;border-radius:0 0 6px 6px}
#${POP_ID} .pdfocr-hint{display:block;font-size:10px;opacity:.55;margin-top:1px}`;
    doc.head?.append(st);
  }
  pop.innerHTML = `
    <label class="pdfocr-field">${t("toolbar.pages")}
      <input id="pdfocr-pages" type="text" value="${currentPage(reader)}" placeholder="${t("toolbar.pagesHint")}">
    </label>
    <label class="pdfocr-field">${t("toolbar.crop")}
      <select id="pdfocr-cropmode">
        <option value="0"${p.cropMode === 0 ? " selected" : ""}>${t("toolbar.crop0")}</option>
        <option value="1"${p.cropMode === 1 ? " selected" : ""}>${t("toolbar.crop1")}</option>
        <option value="2"${p.cropMode === 2 ? " selected" : ""}>${t("toolbar.crop2")}</option>
      </select>
    </label>
    <details class="pdfocr-adv">
      <summary>${t("toolbar.adv")}</summary>
      <div>
        <label class="pdfocr-field">${t("toolbar.res")}
          <select id="pdfocr-limit">
            ${[512, 768, 960, 1024, 1280, 1366, 1536, 1920].map((n) =>
              `<option value="${n}"${n === p.detLimitSideLen ? " selected" : ""}>${n}${n === 1536 ? t("toolbar.recommended") : ""}${n === 1920 ? t("toolbar.largeScan") : ""}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="pdfocr-field">${t("toolbar.thresh")}
          <input id="pdfocr-thresh" type="number" min="0" max="1" step="0.05" value="${p.detThresh}">
          <span class="pdfocr-hint">${t("toolbar.threshHint")}</span>
        </label>
        <label class="pdfocr-field">${t("toolbar.box")}
          <input id="pdfocr-box" type="number" min="0" max="1" step="0.05" value="${p.detBoxThresh}">
          <span class="pdfocr-hint">${t("toolbar.boxHint")}</span>
        </label>
        <label class="pdfocr-field">${t("toolbar.tilt")}
          <input id="pdfocr-maxrot" type="number" min="0" max="90" step="5" value="${p.detMaxRotDeg}">
          <span class="pdfocr-hint">${t("toolbar.tiltHint")}</span>
        </label>
        <label class="pdfocr-field">${t("toolbar.workers")}
          <select id="pdfocr-workers">
            ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
              `<option value="${n}"${n === p.ocrWorkers ? " selected" : ""}>${n} ${t("toolbar.coresUnit")}${n === 4 ? t("toolbar.recommended") : ""}</option>`,
            ).join("")}
          </select>
        </label>
      </div>
    </details>
    <label class="pdfocr-row">
      <input id="pdfocr-twocol" type="checkbox">${t("toolbar.twoColumn")}
    </label>
    <label class="pdfocr-row" title="${t("toolbar.regionsTip")}">
      <input id="pdfocr-regions" type="checkbox" checked>${t("toolbar.regions")}
    </label>
    <div id="pdfocr-regionn" style="display:block;font-size:10px;opacity:.6;margin:-6px 0 10px 4px"></div>
    <button id="pdfocr-draw" type="button" hidden title="${t("toolbar.drawAreasTip")}">
      <span style="display:inline-block;vertical-align:-3px;width:14px;height:14px;margin-right:6px;background:16% center/14px no-repeat url('data:image/svg+xml;utf8,${encodeURIComponent(AREA_ICON_SVG)}')"></span>${t("toolbar.drawAreas")}
    </button>
    <button id="pdfocr-go" type="button" title="${t("toolbar.pageOcr")}">
      <span class="pdfocr-goi" style="display:inline-block;vertical-align:-3px;width:14px;height:14px;margin-right:5px;background:16% center/14px no-repeat url('data:image/svg+xml;utf8,${encodeURIComponent(SCAN_ICON_SVG)}')"></span>${t("toolbar.go")}
    </button>
    <button id="pdfocr-strip" type="button" title="${t("toolbar.stripTip")}">
      <span class="pdfocr-goi" style="display:inline-block;vertical-align:-3px;width:14px;height:14px;margin-right:5px;background:16% center/14px no-repeat url('data:image/svg+xml;utf8,${encodeURIComponent(ERASER_ICON_SVG)}')"></span>${t("toolbar.strip")}
    </button>
    <div id="pdfocr-err" aria-live="polite"></div>
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

  // 主按钮随页码联动:用户点之前就知道 OCR 哪几页(页码 input 任意输入即更新)。
  const goBtn = pop.querySelector("#pdfocr-go") as HTMLButtonElement | null;
  const goLabel = goBtn?.lastChild as Text | null; // 按钮内最后一个文本节点(图标 span 之后)
  const syncGo = (): void => {
    if (!goBtn || !goLabel) return;
    const spec = (pop.querySelector("#pdfocr-pages") as HTMLInputElement).value.trim();
    if (!spec || spec === String(currentPage(reader))) goLabel.textContent = t("toolbar.go");
    else goLabel.textContent = `${t("toolbar.go")} ${spec}`;
  };
  pop.querySelector("#pdfocr-pages")?.addEventListener("input", syncGo);
  syncGo();

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
    const el = (ev.target as HTMLElement | null)?.closest?.("#pdfocr-go, #pdfocr-strip, #pdfocr-draw");
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (el.id === "pdfocr-draw") {
      // 点击时重新查询:弹窗开着期间 React 可能重渲染换掉节点(评审建议,不缓存)。
      const areaBtn = doc.querySelector<HTMLElement>(".toolbar .center.tools .toolbar-button.area");
      dismissPop(doc);
      // active 防呆:已是 image 工具时再点会切回 pointer。
      if (areaBtn && !areaBtn.classList.contains("active")) areaBtn.click();
      return;
    }
    void run(el.id === "pdfocr-strip" ? "strip" : "ocr");
  });

  const refreshRegionCount = (): void => {
    const el = pop.querySelector("#pdfocr-regionn");
    if (!el) return;
    if (!(pop.querySelector("#pdfocr-regions") as HTMLInputElement | null)?.checked) { el.textContent = ""; return; }
    void collectRegions(reader).then((rs) => {
      // 圈没被吃到时必须说话:标注是按附件存的,画在原件上的圈不会跟到 [OCR] 派生文件,
      // 于是这一轮其实走了整页识别(实测用户因此以为"识别结果和圈的内容不一致")。
      el.textContent = rs.length ? `本页 ${rs.length} 个圈,只识别圈内的整行` : `本页没有圈,将识别整页!`;
      (el as unknown as { style: { color: string } }).style.color = rs.length ? "" : "var(--pdfocr-pop-err)";
    });
  };
  pop.querySelector("#pdfocr-regions")?.addEventListener("change", refreshRegionCount);
  refreshRegionCount();

  // 原生「选择区域」入口:按钮与弹窗同 document,找不到(阅读模式/epub)则不显示。
  if (doc.querySelector(".toolbar .center.tools .toolbar-button.area")) {
    (pop.querySelector("#pdfocr-draw") as HTMLElement | null)?.removeAttribute("hidden");
  }
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

/**
 * 补挂:Zotero 重启后,会话恢复的 reader 其 renderToolbar 事件在插件注册
 * 监听器之前就已触发(React CustomSections 的 useEffect 只跑一次,不重放),
 * 事件路径覆盖不到。这里直接遍历已打开 reader,把按钮塞进同一个
 * toolbar 容器(div.custom-sections),插入逻辑与事件回调共用
 * ensureToolbarButton,查重 BTN_ID,幂等安全。
 */
export function retrofitOpenReaders(): void {
  const readers = (Zotero as unknown as { Reader?: { _readers?: unknown[] } }).Reader?._readers;
  if (!Array.isArray(readers)) return;
  for (const reader of readers) {
    if (!reader || typeof reader !== "object") continue;
    const r = reader as ReaderLike & {
      _type?: string;
      _iframeWindow?: { document?: Document };
    };
    if (r._type && r._type !== "pdf") continue;
    if (!r._type && r.type && r.type !== "pdf") continue;
    const doc = r._iframeWindow?.document;
    if (!doc) continue;
    try {
      const container = doc.querySelector(".toolbar .custom-sections");
      if (!container) continue; // toolbar 尚未渲染,等事件
      ensureToolbarButton(doc, r, container);
    } catch {
      // 补挂失败不影响正常功能:新开的 reader 仍走事件路径
    }
  }
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
