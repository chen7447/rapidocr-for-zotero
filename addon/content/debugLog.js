// PDF OCR For Zotero — debug log viewer window.
// Instrumented build: every step writes its status into the log area itself,
// so an empty/broken window reports WHERE it broke (script / api / snapshot).
(function () {
  "use strict";

  var auto = true;
  var booted = [];

  function el(id) {
    return document.getElementById(id);
  }

  function append(batch) {
    var ta = el("pdfocr-dbg-ta");
    if (!ta || !batch || !batch.length) return;
    ta.value += batch.join("\n") + "\n";
    if (auto) ta.scrollTop = ta.scrollHeight;
  }

  // 诊断行:同时进日志区、统计 label、窗口标题(标题永不可见失败)
  function say(s) {
    booted.push(s);
    try { append(["[viewer] " + s]); } catch (e) { /* ignore */ }
    try { el("pdfocr-dbg-stat").value = s.slice(0, 80); } catch (e) { /* ignore */ }
  }

  function stat(dropped) {
    var lbl = el("pdfocr-dbg-stat");
    if (lbl && dropped > 0) lbl.value = "缓冲区已满,丢弃 " + dropped + " 行";
  }

  function reportText() {
    var data = (Zotero.PDFOCRForZotero && Zotero.PDFOCRForZotero.data) || {};
    return [
      "- Zotero: " + Zotero.version,
      "- PDF OCR For Zotero: " + (data.addonVersion || "?"),
      "- 平台: " + (navigator.platform || "?") + "  locale: " + (Zotero.locale || "?"),
      "- viewer boot 诊断: " + booted.join(" | "),
      "",
      "```",
      el("pdfocr-dbg-ta").value,
      "```",
    ].join("\n");
  }

  window.addEventListener("error", function (ev) {
    say("WINDOW ERROR: " + (ev.message || "?") + " @" + (ev.filename || "?") + ":" + (ev.lineno || "?"));
  });

  // 本脚本位于文档末尾:此刻 DOM 已存在,立刻报告脚本是否被执行
  say("script executed, textbox=" + (el("pdfocr-dbg-ta") ? "ok" : "MISSING"));

  window.addEventListener("load", function () {
    var hasZ = typeof Zotero !== "undefined";
    say("load: Zotero=" + hasZ);
    var api = hasZ ? Zotero.pdfOCRDebugLog : null;
    say("load: api=" + (api ? Object.keys(api).join(",") : "NULL"));
    if (!api) return;

    window.__pdfocrDebugCallback = function (batch, dropped) {
      append(batch);
      stat(dropped);
    };

    try {
      var snap = api.attachWindow(window);
      var rows = snap ? snap.split("\n").length : 0;
      say("snapshot rows=" + rows);
      append(snap ? snap.split("\n") : []);
    } catch (e) {
      say("attachWindow threw: " + (e && e.message));
    }

    el("pdfocr-dbg-copy").addEventListener("command", function () {
      Zotero.Utilities.Internal.copyTextToClipboard(el("pdfocr-dbg-ta").value);
    });
    el("pdfocr-dbg-report").addEventListener("command", function () {
      Zotero.Utilities.Internal.copyTextToClipboard(reportText());
    });
    el("pdfocr-dbg-clear").addEventListener("command", function () {
      api.clear();
      el("pdfocr-dbg-ta").value = "";
    });
    el("pdfocr-dbg-auto").addEventListener("command", function (ev) {
      auto = ev.target.checked;
    });
  });
})();
