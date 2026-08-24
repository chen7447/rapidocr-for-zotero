import assert from "node:assert/strict";
import test from "node:test";

import { registerPrefs, unregisterPrefs } from "../../src/ui/preferences";

type RegisterCall = {
  pluginID: string;
  id: string;
  src: string;
  label: string;
  image: string;
  scripts: string[];
};

class FakePreferencePanes {
  registered: RegisterCall[] = [];
  unregistered: string[] = [];

  async register(opts: RegisterCall): Promise<string> {
    this.registered.push(opts);
    return opts.id;
  }

  unregister(id: string): boolean {
    this.unregistered.push(id);
    this.registered = this.registered.filter((p) => p.id !== id);
    return true;
  }
}

test("registerPrefs calls PreferencePanes.register with required fields", async () => {
  const panes = new FakePreferencePanes();
  const rootURI = "file:///pdf-ocr-for-zotero/";
  const result = await registerPrefs(panes, "pdfocrforzotero@example.com", rootURI);
  assert.equal(result, "pdf-ocr-for-zotero-prefs");
  assert.equal(panes.registered.length, 1);
  const call = panes.registered[0];
  assert.equal(call.pluginID, "pdfocrforzotero@example.com");
  assert.equal(call.id, "pdf-ocr-for-zotero-prefs");
  assert.ok(call.src.includes("content/preferences.xhtml"));
  assert.ok(call.label.includes("PDF OCR"));
  assert.ok(call.image.includes("pdf-ocr.svg"));
  assert.equal(call.scripts.length, 1);
  assert.ok(call.scripts[0].includes("content/preferences.js"));
});

test("registerPrefs unregisters previous pane before registering", async () => {
  const panes = new FakePreferencePanes();
  const rootURI = "file:///pdf-ocr-for-zotero/";
  await registerPrefs(panes, "pdfocrforzotero@example.com", rootURI);
  panes.unregistered = []; // clear first-call unregister record
  await registerPrefs(panes, "pdfocrforzotero@example.com", rootURI);
  assert.equal(panes.registered.length, 1);
  assert.deepEqual(panes.unregistered, ["pdf-ocr-for-zotero-prefs"]);
});

test("unregisterPrefs calls PreferencePanes.unregister", () => {
  const panes = new FakePreferencePanes();
  // First unregister sets the default pane ID
  unregisterPrefs(panes);
  panes.unregistered = []; // clear
  panes.registered.push({ id: "pdf-ocr-for-zotero-prefs" } as RegisterCall);
  unregisterPrefs(panes, "pdf-ocr-for-zotero-prefs");
  assert.deepEqual(panes.unregistered, ["pdf-ocr-for-zotero-prefs"]);
});