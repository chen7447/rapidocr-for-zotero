/**
 * 测试期可视化（b37+）：把区域 OCR 的分阶段结果画到页面渲染图上，弹窗显示，
 * 用来回答「每个过程分别框住了哪些行、谁被哪条规则丢掉」。调试完成后按要求整体删除：
 * 删掉本文件 + ocr-engine.ts 里 marks 收集与 showStageOverlay 调用即可，识别链路不依赖它。
 */
import { debugLog } from "../debug-log";

type Rect = { x1: number; y1: number; x2: number; y2: number };
export type StageCls = "in" | "out" | "norec";
export type StageMark = { raw: Rect; cls: StageCls };

const STYLE: Record<StageCls, { color: string; label: string }> = {
  in: { color: "#1b5e20", label: "圈内：整行写入（优先）" },
  out: { color: "#9e9e9e", label: "圈外补足：接在圈内行之后" },
  norec: { color: "#b71c1c", label: "识别未返回（空/垃圾文本）" },
};

/** 本仓库不引 DOM lib,canvas 2D 上下文在类型上只是 nsISupports —— 声明用到的这几个方法即可。 */
type C2 = {
  fillStyle: string; strokeStyle: string; lineWidth: number; globalAlpha: number; font: string;
  putImageData: (d: unknown, x: number, y: number) => void;
  drawImage: (src: unknown, dx: number, dy: number, dw: number, dh: number) => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  strokeRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (s: string, x: number, y: number) => void;
  setLineDash: (a: number[]) => void;
};
type Cvs = {
  width: number; height: number;
  getContext: (k: string) => unknown; toDataURL: (t?: string) => string;
};
const ctx2d = (c: Cvs): C2 => c.getContext("2d") as unknown as C2;

type W0 = Window & {
  document: Document & {
    createElement: (t: string) => Cvs & { [k: string]: unknown };
    body: { insertAdjacentHTML: (pos: string, html: string) => void; [k: string]: unknown } | null;
    querySelectorAll: (sel: string) => { length: number; item: (i: number) => { addEventListener: (t: string, f: () => void) => void } | null };
  };
  atob: (s: string) => string;
  Blob: new (parts: unknown[], opts: { type: string }) => unknown;
  ClipboardItem: new (data: Record<string, unknown>) => unknown;
  navigator: { clipboard?: { write: (items: unknown[]) => Promise<void>; writeText?: (s: string) => Promise<void> } };
};

let win: W0 | null = null;
const pages: { label: string; cv: Cvs }[] = []; // 本次会话各页图,「复制图片」把它们拼成一张
const texts: string[] = []; // 本次会话各页的分阶段文字,「复制文字」一次带走

function ensureWindow(): W0 | null {
  if (win && !(win as unknown as { closed?: boolean }).closed) return win;
  const w = (Services as unknown as {
    ww: { openWindow(p: unknown, u: string, n: string, f: string, a: unknown): Window };
  }).ww.openWindow(null, "about:blank", "pdfocr-stage-overlay", "chrome,resizable,centerscreen,width=1040,height=860", null) as unknown as W0;
  if (!w) return null;
  w.document.open();
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>RapidOCR 分阶段可视化</title></head>`
    + `<body style="background:#fafafa;margin:0">`
    + `<div style="position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:8px 12px;z-index:9">`
    + `<button id="copy-img" style="font:13px sans-serif;padding:4px 12px">复制图片</button>`
    + `<button id="copy-txt" style="font:13px sans-serif;padding:4px 12px;margin-left:6px">复制文字</button>`
    + `<span id="copy-st" style="font:12px sans-serif;margin-left:8px;color:#666"></span></div>`
    + `<div id="pages" style="padding:12px"></div></body></html>`);
  w.document.close();
  win = w;
  pages.length = 0;
  texts.length = 0;
  const btns = w.document.querySelectorAll("button");
  btns.item(0)?.addEventListener("click", () => copyAll(w));
  btns.item(1)?.addEventListener("click", () => copyText(w));
  return w;
}

function setStatus(w: W0, msg: string, ok: boolean): void {
  const el = w.document.querySelectorAll("span").item(0) as unknown as { textContent: string; style: { color: string } } | null;
  if (el) { el.textContent = msg; el.style.color = ok ? "#1b5e20" : "#b71c1c"; }
}

/** 分阶段文字一次复制走:截图给我读数字太不可靠,文本一眼定案。 */
function copyText(w: W0): void {
  try {
    if (!texts.length) return setStatus(w, "还没有数据", false);
    const t = texts.join("\n\n");
    if (!w.navigator.clipboard?.writeText) return setStatus(w, "此版本无剪贴板 API", false);
    w.navigator.clipboard.writeText(t)
      .then(() => setStatus(w, `已复制 ${texts.length} 页文字,直接粘给模型`, true))
      .catch((e: unknown) => setStatus(w, `复制失败:${e instanceof Error ? e.message : String(e)}`, false));
  } catch (e) {
    setStatus(w, `复制异常:${e instanceof Error ? e.message : String(e)}`, false);
  }
}

/** 拼成一张长图 → 剪贴板 PNG。同 tick 内解码,避免异步丢掉用户手势的剪贴板权限。 */
function copyAll(w: W0): void {
  const status = (msg: string, ok: boolean): void => setStatus(w, msg, ok);
  try {
    if (!pages.length) return status("还没有图", false);
    const gap = 12;
    const wMax = Math.max(...pages.map((p) => p.cv.width));
    const hSum = pages.reduce((s, p) => s + p.cv.height, 0) + gap * (pages.length - 1);
    const out = w.document.createElement("canvas");
    out.width = wMax;
    out.height = hSum;
    const oc = ctx2d(out);
    oc.fillStyle = "#ffffff";
    oc.fillRect(0, 0, wMax, hSum);
    let y = 0;
    for (const p of pages) { oc.drawImage(p.cv, 0, y, p.cv.width, p.cv.height); y += p.cv.height + gap; }
    const url = out.toDataURL("image/png");
    const bin = w.atob(url.slice(url.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new w.Blob([bytes], { type: "image/png" });
    if (!w.navigator.clipboard) return status("此版本无剪贴板 API，请右键图片→复制图片", false);
    w.navigator.clipboard.write([new w.ClipboardItem({ "image/png": blob })])
      .then(() => status(`已复制 ${pages.length} 页长图，可直接粘贴`, true))
      .catch((e: unknown) => status(`复制失败：${e instanceof Error ? e.message : String(e)}（改右键图片复制）`, false));
  } catch (e) {
    status(`复制异常：${e instanceof Error ? e.message : String(e)}`, false);
  }
}

/** 打开（或复用）弹窗，追加一页的分阶段图。任何失败都只记日志，绝不影响 OCR。 */
export function showStageOverlay(
  pageLabel: string,
  img: { width: number; height: number; rgba: Uint8ClampedArray },
  frames: Rect[],
  marks: StageMark[],
  text: string,
): void {
  try {
    const w0 = ensureWindow();
    if (!w0) return;
    const scale = Math.min(1, 980 / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const base = w0.document.createElement("canvas");
    base.width = img.width;
    base.height = img.height;
    ctx2d(base).putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);

    const counts = new Map<StageCls, number>();
    for (const m of marks) counts.set(m.cls, (counts.get(m.cls) || 0) + 1);
    const legend = (Object.keys(STYLE) as StageCls[]).filter((c) => counts.get(c));
    const legendH = 22 + legend.length * 20; // 标题行 + 每项一行

    const cv = w0.document.createElement("canvas");
    cv.width = w;
    cv.height = h + legendH;
    const ctx = ctx2d(cv);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(base, 0, 0, w, h);

    const box = (r: Rect): number[] => [
      Math.round(r.x1 * scale), Math.round(r.y1 * scale),
      Math.max(1, Math.round((r.x2 - r.x1) * scale)), Math.max(1, Math.round((r.y2 - r.y1) * scale)),
    ];
    for (const m of marks) {
      const s = STYLE[m.cls];
      const [x, y, bw, bh] = box(m.raw);
      // 圈外丢弃的行只画一个左侧小竖钩。以前画成整框,看图的人会得出「整页到处是框,圈根本没生效」
      // 的结论(b49 反馈)—— 而它恰恰是减法正在执行的表现。
      if (m.cls === "out") {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = s.color;
        ctx.fillRect(Math.max(0, x - 3), y, 2, Math.max(2, bh));
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x, y, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#00b0ff";
    frames.forEach((f, i) => {
      const [x, y, bw, bh] = box(f);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
      ctx.font = "bold 15px sans-serif";
      ctx.fillStyle = "#00b0ff";
      ctx.fillText(`F${i}`, x + 4, y + 16);
    });

    // 图例画进图片本身:复制出去我也能看懂颜色
    ctx.fillStyle = "#111111";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(`${pageLabel} — 蓝虚线框 = 你圈的 F#`, 6, h + 16);
    ctx.font = "13px sans-serif";
    legend.forEach((c, i) => {
      const y = h + 34 + i * 20;
      ctx.fillStyle = STYLE[c].color;
      ctx.fillRect(8, y - 11, 12, 12);
      ctx.fillStyle = "#111111";
      ctx.fillText(`${STYLE[c].label} ×${counts.get(c)}`, 26, y);
    });

    pages.push({ label: pageLabel, cv });
    texts.push(`${pageLabel}\n${text}`);
    const esc = text.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
    (w0.document.body as unknown as { insertAdjacentHTML: (p: string, h: string) => void })
      .insertAdjacentHTML("beforeend", `<div style="margin-bottom:14px"><img src="${cv.toDataURL("image/png")}" style="display:block;max-width:100%;border:1px solid #ccc">`
        + `<details style="margin-top:4px"><summary style="font:12px sans-serif;cursor:pointer">分阶段明细（${text.split("\n").length} 行）</summary>`
        + `<pre style="font:11px/1.5 monospace;white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:6px;max-height:320px;overflow:auto">${esc}</pre></details></div>`);
    debugLog.log(`stage overlay ${pageLabel}: marks=${marks.length} frames=${frames.length}`);
  } catch (e) {
    debugLog.log(`stage overlay failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
