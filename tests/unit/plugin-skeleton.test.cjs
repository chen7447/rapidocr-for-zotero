"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const addonRoot = path.join(root, "addon");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function createBootstrapSandbox() {
  const calls = {
    loadSubScript: [],
    startup: 0,
    windowLoads: [],
    windowUnloads: [],
    shutdown: 0,
  };
  const addon = {
    hooks: {
      async onStartup() { calls.startup += 1; },
      async onMainWindowLoad(window) { calls.windowLoads.push(window); },
      async onMainWindowUnload(window) { calls.windowUnloads.push(window); },
      async onShutdown() { calls.shutdown += 1; },
    },
  };
  const chromeHandle = { destructed: false, destruct() { this.destructed = true; } };
  const sandbox = {
    APP_SHUTDOWN: 2,
    Zotero: {
      initializationPromise: Promise.resolve(),
      PDFOCRForZotero: undefined,
      logError() {},
    },
    Services: {
      io: { newURI(value) { return value; } },
      scriptloader: {
        loadSubScript(uri, target) {
          calls.loadSubScript.push({ uri, target });
          target.addon = addon;
          sandbox.Zotero.PDFOCRForZotero = addon;
        },
      },
    },
    Components: {
      classes: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService() { return { registerChrome() { return chromeHandle; } }; },
        },
      },
      interfaces: { amIAddonManagerStartup: {} },
    },
    IOUtils: {
      readUTF8URI() { throw new Error("IOUtils.readUTF8URI not available in test sandbox"); },
      makeDirectory() { throw new Error("IOUtils.makeDirectory not available in test sandbox"); },
      writeUTF8() { throw new Error("IOUtils.writeUTF8 not available in test sandbox"); },
    },
    ChromeUtils: {
      importESModule() { throw new Error("ChromeUtils not available in test sandbox"); },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("addon/bootstrap.js"), sandbox, { filename: "bootstrap.js" });
  return { sandbox, calls, chromeHandle };
}

test("manifest targets Zotero 9.0–10.0.x", () => {
  const manifest = JSON.parse(read("addon/manifest.json"));
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.name, "RapidOCR for Zotero");
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}(?:b\d+)?$/i);
  assert.equal(manifest.applications.zotero.strict_min_version, "9.0");
  assert.equal(manifest.applications.zotero.strict_max_version, "10.0.*");
  assert.equal(manifest.applications.zotero.id, "pdfocrforzotero@example.com");
  assert.match(manifest.applications.zotero.update_url, /^https:\/\//);
});

test("bootstrap exposes Zotero lifecycle functions", () => {
  const source = read("addon/bootstrap.js");
  for (const name of ["install", "startup", "onMainWindowLoad", "onMainWindowUnload", "shutdown", "uninstall"]) {
    assert.match(source, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  }
});

test("bootstrap delegates lifecycle and destroys state on shutdown", async () => {
  const { sandbox, calls, chromeHandle } = createBootstrapSandbox();
  const rootURI = "file:///pdf-ocr-for-zotero/";
  await sandbox.startup({ id: "pdfocrforzotero@example.com", version: "0.5.0b1", rootURI }, 3);
  assert.equal(calls.startup, 1);
  assert.equal(calls.loadSubScript.length, 1);
  assert.match(calls.loadSubScript[0].uri, /content\/scripts\/pdf-ocr-for-zotero\.js$/);

  const firstWindow = { id: "first" };
  await sandbox.onMainWindowLoad({ window: firstWindow }, 9);
  await sandbox.onMainWindowUnload({ window: firstWindow }, 10);
  assert.deepEqual(calls.windowLoads, [firstWindow]);
  assert.deepEqual(calls.windowUnloads, [firstWindow]);

  await sandbox.shutdown({}, 4);
  assert.equal(calls.shutdown, 1);
  assert.equal(chromeHandle.destructed, true);
  assert.equal(sandbox.Zotero.PDFOCRForZotero, undefined);
});

test("source hooks make repeated window load idempotent", () => {
  const hooks = read("src/hooks.ts");
  assert.match(hooks, /WeakSet<Window>/);
  assert.match(hooks, /if\s*\(.*\.has\(window\)\)\s*return/s);
  assert.match(hooks, /\.delete\(window\)/);
});

test("required localized resources exist", () => {
  for (const relativePath of [
    "addon/locale/zh-CN/addon.ftl",
    "addon/locale/en-US/addon.ftl",
    "addon/locale/zh-CN/pdfocrforzotero-mainWindow.ftl",
    "addon/locale/en-US/pdfocrforzotero-mainWindow.ftl",
    "addon/prefs.js",
    "addon/content/preferences.xhtml",
    "addon/content/preferences.css",
    "addon/content/icons/pdf-ocr.svg",
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${relativePath} is missing`);
  }
});

test("XPI source root contains manifest and bootstrap directly", () => {
  assert.equal(fs.existsSync(path.join(addonRoot, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(addonRoot, "bootstrap.js")), true);
});

test("addon class exposes data and hooks", () => {
  const addon = read("src/addon.ts");
  assert.match(addon, /class Addon/);
  assert.match(addon, /public readonly data/);
  assert.match(addon, /public readonly hooks/);
});

test("hooks wire job manager, progress dialog, and MenuManager", () => {
  const hooks = read("src/hooks.ts");
  assert.match(hooks, /MenuManager/);
  assert.match(hooks, /ContextMenuController/);
  assert.match(hooks, /SelectionResolver/);
  assert.match(hooks, /JobManager/);
  assert.match(hooks, /OcrProgressDialog/);
  assert.match(hooks, /contextMenuController\.register\(\)/);
  assert.match(hooks, /contextMenuController\?\.unregister\(\)/);
  assert.match(hooks, /jobManager\?\.shutdown\(\)/);
  assert.match(hooks, /createParentAndAttachOCR/);
  assert.match(hooks, /Services\.prompt/);
  assert.doesNotMatch(hooks, /controllers = new WeakMap/);
});

test("OCR worker bundles onnxruntime-web (WASM inference lives in the worker)", () => {
  const worker = read("src/ocr/ocr-worker.ts");
  assert.match(worker, /onnxruntime-web/);
});

test("build script copies addon and bundles XPI", () => {
  const build = fs.readFileSync(path.join(root, "scripts", "build.mjs"), "utf8");
  assert.match(build, /fs\.cpSync\(addonRoot, stageRoot/);
  assert.match(build, /esbuild\.build/);
  assert.match(build, /archiver/);
});
