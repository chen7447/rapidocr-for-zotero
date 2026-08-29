"use strict";

(function () {
  // Zotero 先 loadSubScript，再插入 XHTML 片段。脚本执行时 getElementById 全是 null。
  // 真正可绑 DOM 的时机是 pane 的 load；每次显示会再派 showing。
  const PREFIX = "pdfocrforzotero";

  const DEFAULT_LIMIT = 1536;
  const DEFAULT_THRESH = 0.3;
  const DEFAULT_BOX_THRESH = 0.4;
  const DEFAULT_MAX_ROT = 30;
  const DEFAULT_CROP_MODE = 2;
  const DEFAULT_WORKERS = 4;
  const DEFAULT_AUTO_OPEN = false;

  var bound = false;

  function get(id) {
    return document.getElementById(id);
  }

  function readPref(key) {
    try {
      return Zotero.Prefs.get(PREFIX + "." + key);
    } catch (e) {
      Zotero.debug("[PDF OCR prefs] read error: " + e);
      return null;
    }
  }

  function writePref(key, value) {
    try {
      Zotero.Prefs.set(PREFIX + "." + key, value);
      var readback = Zotero.Prefs.get(PREFIX + "." + key);
      Zotero.debug("[PDF OCR prefs] set " + key + "=" + value + " readback=" + readback);
    } catch (e) {
      Zotero.debug("[PDF OCR prefs] set error: " + e);
    }
  }

  function readThresholdInt(key, fallbackPercent) {
    var v = Number(readPref(key));
    if (isNaN(v)) return fallbackPercent;
    if (v > 0 && v < 1) return Math.round(v * 100); // legacy float storage
    return v; // >=1 stays a percentage; 0 is legitimate and must survive
  }

  function writeThreshold(key, percent) {
    writePref(key, percent);
  }

  function resetPrefs() {
    writePref("detLimitSideLen", DEFAULT_LIMIT);
    writeThreshold("detThresh", Math.round(DEFAULT_THRESH * 100));
    writeThreshold("detBoxThresh", Math.round(DEFAULT_BOX_THRESH * 100));
    writePref("detMaxRotDeg", DEFAULT_MAX_ROT);
    writePref("cropMode", DEFAULT_CROP_MODE);
    writePref("ocrWorkers", DEFAULT_WORKERS);
    writePref("autoOpenAfterSuccess", DEFAULT_AUTO_OPEN);
    loadSettings();
  }

  function loadSettings() {
    var limit = get("pdf-ocr-det-limit");
    if (limit) {
      var v = readPref("detLimitSideLen");
      limit.value = String(v || DEFAULT_LIMIT);
    }
    var thresh = get("pdf-ocr-det-thresh");
    if (thresh) {
      thresh.value = String(readThresholdInt("detThresh", Math.round(DEFAULT_THRESH * 100)) / 100);
    }
    var boxThresh = get("pdf-ocr-det-box-thresh");
    if (boxThresh) {
      boxThresh.value = String(readThresholdInt("detBoxThresh", Math.round(DEFAULT_BOX_THRESH * 100)) / 100);
    }
    var maxRot = get("pdf-ocr-det-max-rot");
    if (maxRot) {
      var mr = Number(readPref("detMaxRotDeg"));
      maxRot.value = String(isNaN(mr) ? DEFAULT_MAX_ROT : mr); // 0 = filter off, keep it
    }
    var cropMode = get("pdf-ocr-crop-mode");
    if (cropMode) {
      var cm = Number(readPref("cropMode"));
      cropMode.value = String(cm === 0 || cm === 1 ? cm : DEFAULT_CROP_MODE);
    }
    var workers = get("pdf-ocr-workers");
    if (workers) {
      var w = Number(readPref("ocrWorkers"));
      workers.value = String(Number.isInteger(w) && w >= 1 ? Math.min(8, w) : DEFAULT_WORKERS);
    }
    var auto = get("pdf-ocr-auto-open");
    if (auto) auto.checked = !!readPref("autoOpenAfterSuccess");
  }

  function clampNumber(value, min, max, fallback) {
    var n = parseFloat(value);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function persistThresh(el, key, fallback) {
    var percent = Math.round(clampNumber(el.value, 0, 1, fallback) * 100);
    writeThreshold(key, percent);
  }

  function bindEvents() {
    var limit = get("pdf-ocr-det-limit");
    if (limit) {
      limit.addEventListener("change", function () {
        writePref("detLimitSideLen", parseInt(limit.value, 10));
      });
    }
    var thresh = get("pdf-ocr-det-thresh");
    if (thresh) {
      var saveThresh = function () { persistThresh(thresh, "detThresh", DEFAULT_THRESH); };
      thresh.addEventListener("change", saveThresh);
      thresh.addEventListener("input", saveThresh);
    }
    var boxThresh = get("pdf-ocr-det-box-thresh");
    if (boxThresh) {
      var saveBox = function () { persistThresh(boxThresh, "detBoxThresh", DEFAULT_BOX_THRESH); };
      boxThresh.addEventListener("change", saveBox);
      boxThresh.addEventListener("input", saveBox);
    }
    var maxRot = get("pdf-ocr-det-max-rot");
    if (maxRot) {
      var saveMaxRot = function () {
        writePref("detMaxRotDeg", Math.round(clampNumber(maxRot.value, 0, 90, DEFAULT_MAX_ROT)));
      };
      maxRot.addEventListener("change", saveMaxRot);
      maxRot.addEventListener("input", saveMaxRot);
    }
    var cropMode = get("pdf-ocr-crop-mode");
    if (cropMode) {
      cropMode.addEventListener("change", function () {
        writePref("cropMode", parseInt(cropMode.value, 10));
      });
    }
    var workers = get("pdf-ocr-workers");
    if (workers) {
      var saveWorkers = function () {
        writePref("ocrWorkers", Math.round(clampNumber(workers.value, 1, 8, DEFAULT_WORKERS)));
      };
      workers.addEventListener("change", saveWorkers);
      workers.addEventListener("input", saveWorkers);
    }
    var auto = get("pdf-ocr-auto-open");
    if (auto) {
      auto.addEventListener("change", function () {
        writePref("autoOpenAfterSuccess", auto.checked);
      });
    }
    var reset = get("pdf-ocr-reset-defaults");
    if (reset) {
      reset.addEventListener("click", function () {
        resetPrefs();
      });
    }
  }

  function showVersionInfo() {
    var ver = get("pdf-ocr-plugin-version");
    if (ver) {
      try {
        var addon = Zotero.PDFOCRForZotero;
        ver.textContent = addon && addon.data && addon.data.addonVersion
          ? addon.data.addonVersion
          : "—";
      } catch (e) {
        ver.textContent = "—";
      }
    }
  }

  function ensureL10n() {
    // 面板是独立文档：确保 Fluent 资源链接存在，data-l10n-id 才会被翻译。
    // 正常情况下 preferences.xhtml 的 head 里已带 <link rel="localization">；
    // 这里兜底补插（幂等）。失败则保留 XHTML 内的中文兜底文案。
    try {
      if (!document.querySelector("[data-l10n-id]")) return;
      var links = document.querySelectorAll('link[rel="localization"]');
      for (var i = 0; i < links.length; i++) {
        if (/pdfocrforzotero-mainWindow\.ftl/.test(links[i].getAttribute("href") || "")) return;
      }
      if (window.MozXULElement && window.MozXULElement.insertFTLIfNeeded) {
        window.MozXULElement.insertFTLIfNeeded("pdfocrforzotero-mainWindow.ftl");
      }
    } catch (e) {
      Zotero.debug("[PDF OCR prefs] l10n link inject failed: " + e);
    }
  }

  function tryInit() {
    if (!get("pdf-ocr-det-limit")) return;
    if (!bound) {
      bound = true;
      bindEvents();
      showVersionInfo();
    }
    ensureL10n();
    loadSettings();
  }

  document.addEventListener("load", tryInit, true);
  document.addEventListener("showing", tryInit, true);
  tryInit();
})();
