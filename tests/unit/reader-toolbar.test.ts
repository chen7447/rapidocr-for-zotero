import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { regionBBox } from "../../src/ui/reader-toolbar";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/ui/reader-toolbar.ts"),
  "utf8",
);

test("popup uses a shield and click-delegates strip/ocr", () => {
  assert.match(src, /POP_ID \+ "-shield"/);
  assert.match(src, /host\.append\(shield, pop\)/);
  assert.match(src, /closest\?\.\("#pdfocr-go, #pdfocr-strip, #pdfocr-draw"\)/);
  assert.doesNotMatch(src, /pointerEvents = on \? "none"/);
});

test("Select-Area entry re-queries native button on click, guards active state", () => {
  // 点击时重新查询(不缓存)+ active 防呆:已是 image 工具时不能把用户切回 pointer。
  assert.match(src, /doc\.querySelector<HTMLElement>\("\.toolbar \.center\.tools \.toolbar-button\.area"\)/);
  assert.match(src, /classList\.contains\("active"\)/);
  assert.match(src, /areaBtn\.click\(\)/);
  // 弹窗打开时按钮不存在(阅读模式/epub)则入口保持 display:none。
  assert.match(src, /style\.removeProperty\("display"\)/);
});

test("strip OCR closes reader, shows progress, then reopens", () => {
  const hooks = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/hooks.ts"),
    "utf8",
  );
  assert.match(hooks, /ocrDialog\.open\(ocrItem\.getDisplayTitle\?\.\(\) \|\| "", t\("strip\.title"\)\)/);
  assert.match(hooks, /await waitReadersClosed/);
  assert.match(hooks, /await writePdf\(ocrPath, bytes\)/);
  assert.match(hooks, /reopen after strip/);
  assert.match(hooks, /reopen after page OCR/);
  assert.doesNotMatch(hooks, /reader\?\.navigate/);
});

test("regionBBox covers real Zotero ink and rect shapes", () => {
  const ink = regionBBox({ paths: [{ lines: [[10, 20, 30, 40]], points: [[5, 60]] }] });
  assert.deepEqual(ink, { x1: 5, y1: 20, x2: 30, y2: 60 });
  const rect = regionBBox({ rects: [[100, 50, 300, 90]] });
  assert.deepEqual(rect, { x1: 100, y1: 50, x2: 300, y2: 90 });
  assert.equal(regionBBox({}), null);
  assert.equal(regionBBox(undefined), null);
});

test("registerReaderToolbar registers first in onStartup, before any await", () => {
  const hooks = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/hooks.ts"),
    "utf8",
  );
  const body = hooks.slice(hooks.indexOf("async function onStartup"));
  const registerIdx = body.indexOf("registerReaderToolbar(");
  const firstAwaitIdx = body.indexOf("await ");
  assert.ok(registerIdx >= 0, "registerReaderToolbar must exist in onStartup");
  assert.ok(
    firstAwaitIdx < 0 || registerIdx < firstAwaitIdx,
    "toolbar listener must be registered before the first await in onStartup",
  );
  // 注册后与异步初始化后各补挂一次(双重兜底,幂等)
  const retrofitCalls = body.match(/retrofitOpenReaders\(\)/g) ?? [];
  assert.ok(retrofitCalls.length >= 2, "retrofitOpenReaders must run right after register and again after async init");
});

test("retrofitOpenReaders: retrofits open pdf readers idempotently, skips note/absent containers", async () => {
  // 最小 DOM 桩:jsdom 不可用,直接用 node:test 的断言 + 手写桩文档
  const { retrofitOpenReaders, registerReaderToolbar } = await import("../../src/ui/reader-toolbar");
  let appended = 0;
  const makeDoc = (hasContainer: boolean) => ({
    getElementById: (id: string) => (id === "pdfocr-toolbar-btn" && appended > 0 ? { id } : null),
    querySelector: (sel: string) =>
      hasContainer && sel === ".toolbar .custom-sections"
        ? { append: () => { appended++; } }
        : null,
    createElement: () => ({
      style: { cssText: "" },
      append: () => {},
      addEventListener: () => {},
      setAttribute: () => {},
      classList: { add: () => {} },
    }),
  });
  const makeReader = (type: string, hasContainer: boolean) => ({
    _type: type,
    _iframeWindow: { document: makeDoc(hasContainer) },
    setToolbarPlaceholderWidth: () => {},
  });
  const savedZotero = (globalThis as Record<string, unknown>).Zotero;
  (globalThis as Record<string, unknown>).Zotero = {
    Reader: {
      _readers: [
        makeReader("pdf", true),
        makeReader("pdf", false), // toolbar 未渲染,跳过
        makeReader("note", true), // 非 pdf,跳过
      ],
    },
  };
  try {
    retrofitOpenReaders();
    assert.equal(appended, 1, "only the ready pdf reader gets a button");
    retrofitOpenReaders(); // 幂等:已有 BTN_ID 则跳过
    assert.equal(appended, 1, "second pass must not append again");
  } finally {
    (globalThis as Record<string, unknown>).Zotero = savedZotero;
  }
  void registerReaderToolbar; // keep import referenced
});
