"use strict";

var chromeHandle;
var resProto;
var addonContext;

function install(_data, _reason) {}

async function startup({ id, version, rootURI }, _reason) {
  await Zotero.initializationPromise;

  const addonManagerStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = addonManagerStartup.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [
      ["content", "pdfocrforzotero", rootURI + "content/"],
      ["locale", "pdfocrforzotero", "en-US", rootURI + "locale/en-US/"],
      ["locale", "pdfocrforzotero", "zh-CN", rootURI + "locale/zh-CN/"],
    ],
  );

  // Register resource://pdfocrforzotero/ → rootURI (jar: URL) so the OCR
  // Web Worker can be loaded via `new Worker("resource://...")` — Firefox
  // does not support `new Worker("jar:...")` but does support resource://.
  resProto = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Components.interfaces.nsIResProtocolHandler);
  resProto.setSubstitution("pdfocrforzotero", Services.io.newURI(rootURI));

  addonContext = { addonID: id, addonVersion: version, addonRoot: rootURI };
  addonContext._globalThis = addonContext;
  addonContext.Zotero = Zotero;
  addonContext.Services = Services;
  addonContext.Components = Components;
  addonContext.IOUtils = IOUtils;
  addonContext.ChromeUtils = ChromeUtils;
  // The bundled onnxruntime-web glue calls console.* at factory init; the
  // bootstrap sandbox doesn't expose `console` as a bare global.
  addonContext.console = {
    log: (...args) => Zotero.debug(`[ORT] ${args.map(String).join(" ")}`),
    warn: (...args) => Zotero.debug(`[ORT][warn] ${args.map(String).join(" ")}`),
    error: (...args) => Zotero.debug(`[ORT][error] ${args.map(String).join(" ")}`),
  };
  // onnxruntime-web also calls performance.now() / performance.timeOrigin
  // for profiling; the bootstrap sandbox lacks these globals.
  addonContext.performance = {
    now: () => Date.now(),
    timeOrigin: Date.now(),
  };

  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/pdf-ocr-for-zotero.js",
    addonContext,
  );
  await Zotero.PDFOCRForZotero.hooks.onStartup();
}

async function onMainWindowLoad({ window }, _reason) {
  await Zotero.PDFOCRForZotero?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, _reason) {
  await Zotero.PDFOCRForZotero?.hooks.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason !== APP_SHUTDOWN) {
    await Zotero.PDFOCRForZotero?.hooks.onShutdown();
  }

  Zotero.PDFOCRForZotero = undefined;
  addonContext = undefined;

  if (resProto) {
    resProto.setSubstitution("pdfocrforzotero", null);
    resProto = undefined;
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = undefined;
  }
}

function uninstall(_data, _reason) {}
