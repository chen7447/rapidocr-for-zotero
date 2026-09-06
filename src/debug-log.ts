// src/debug-log.ts
// Plugin-private debug log: ring buffer + help-menu entry + viewer window.
// Source tee: every module's own log wrapper forwards here. We NEVER patch
// global Zotero.debug (shared by all plugins, last-writer-wins wrappers).

import { t } from "./locale";

const CAP = 2000;
const MENU_ID = "pdfocrforzotero-debug-log-menu";
const WINDOW_TYPE = "chrome:pdfocr-debuglog";
const WINDOW_URL = "chrome://pdfocrforzotero/content/debugLog.xhtml";

const lines: string[] = [];
let dropped = 0;

interface DebugWindow {
  closed?: boolean;
  __pdfocrDebugCallback?: (batch: string[], dropped: number) => void;
}

/** 已打开的查看窗口(订阅者) */
const windows = new Set<DebugWindow>();
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function z(): any {
  return (globalThis as { Zotero?: unknown }).Zotero;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 入口统一脱敏:防止日后把带 key 的请求 URL 打进日志。 */
function sanitize(s: string): string {
  return s.replace(/\b(secretKey|apiKey|api_key|token|password)=[^&\s"']+/gi, "$1=***");
}

function push(line: string): void {
  if (lines.length >= CAP) {
    lines.shift();
    dropped++;
  }
  lines.push(line);
  // 无订阅者时不积压 pending:历史只从快照一条路走(避免开窗后双投递)
  if (windows.size) {
    pending.push(line);
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 150);
}

function flush(): void {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  for (const win of Array.from(windows)) {
    try {
      if (win && !win.closed && typeof win.__pdfocrDebugCallback === "function") {
        win.__pdfocrDebugCallback(batch, dropped);
      } else {
        windows.delete(win); // 窗口关了(用户关/unload) → 退订
      }
    } catch {
      windows.delete(win);
    }
  }
}

/** 唯一入口:各模块的日志 wrapper tee 到这里。内部整体 try/catch,日志故障绝不影响主流程。 */
function log(msg: unknown): void {
  try {
    const s = msg instanceof Error ? String(msg.stack || msg) : String(msg);
    push(`[${stamp()}] ${sanitize(s)}`);
  } catch {
    /* swallow */
  }
}

function getSnapshot(): string {
  return lines.join("\n");
}

function clear(): void {
  lines.length = 0;
  dropped = 0;
  pending = [];
}

/** 查看窗口 onLoad 时调用:先返回快照,再推自测标记行(即时可见 = 实时通道 OK)。 */
function attachWindow(win: DebugWindow): string {
  const snap = getSnapshot();
  windows.add(win);
  log("debug log window opened");
  return snap;
}

function openWindow(): void {
  try {
    const Z = z();
    const wm = (globalThis as { Services?: { wm?: any } }).Services?.wm;
    const existing = wm?.getMostRecentWindow?.(WINDOW_TYPE);
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const parent = Z?.getMainWindow?.();
    if (!parent) return;
    parent.openDialog(WINDOW_URL, WINDOW_TYPE, "chrome,resizable,width=860,height=560,centerscreen");
  } catch (err) {
    log(`open debug window failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 幂等:按固定 id 查重;双入口(onStartup 遍历 + onMainWindowLoad)各调一次。 */
function registerHelpMenuItem(doc: Document): void {
  try {
    if (doc.getElementById(MENU_ID)) return;
    const popup = doc.getElementById("menu_HelpPopup") || doc.getElementById("helpMenu");
    if (!popup) return;
    const anyDoc = doc as unknown as { createXULElement?: (tag: string) => HTMLElement };
    const item = anyDoc.createXULElement
      ? anyDoc.createXULElement("menuitem")
      : doc.createElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", t("debugLog.menu"));
    item.addEventListener("command", () => openWindow());
    // 插到官方排障区之前,锚点按优先级回退
    const anchor = ["debug-output-menu", "menuitem-restart-in-troubleshooting-mode", "checkForUpdates"]
      .map((id) => doc.getElementById(id))
      .find(Boolean);
    if (anchor) popup.insertBefore(item, anchor);
    else popup.appendChild(item);
  } catch {
    /* 主窗口结构变化时静默降级:日志功能丢了不影响 OCR */
  }
}

function unregisterFromWindow(doc: Document): void {
  try {
    doc.getElementById(MENU_ID)?.remove();
  } catch {
    /* best-effort */
  }
}

function unregisterAll(): void {
  const wins = (z()?.getMainWindows?.() ?? []) as Window[];
  for (const win of wins) {
    try {
      if (win?.document) unregisterFromWindow(win.document as unknown as Document);
    } catch {
      /* per-window best-effort */
    }
  }
  const wm = (globalThis as { Services?: { wm?: any } }).Services?.wm;
  try {
    const en = wm?.getEnumerator?.(WINDOW_TYPE);
    while (en?.hasMoreElements()) {
      try {
        en.getNext().close();
      } catch {
        /* per-window best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
  windows.clear();
  pending = [];
}

export const debugLog = { log, getSnapshot, clear, attachWindow, openWindow, registerHelpMenuItem, unregisterFromWindow, unregisterAll };
// 暴露给查看窗口(静态脚本只能经 Zotero 全局拿到它)
try {
  const Z = z();
  if (Z) Z.pdfOCRDebugLog = debugLog;
} catch {
  /* 非 Zotero 环境(单测) */
}

// 自证行:模块加载即写一条。查看窗口里看不到这条 = bundle/tee 层问题,与窗口渲染无关。
log("debug log module ready");
