import assert from "node:assert/strict";
import test from "node:test";
import { debugLog } from "../../src/debug-log";

test("debugLog snapshot + sanitize + clear", () => {
  debugLog.clear();
  debugLog.log("hello one");
  debugLog.log("GET https://x/api?secretKey=abc123&u=1");
  const snap = debugLog.getSnapshot();
  assert.ok(snap.includes("hello one"));
  assert.ok(snap.includes("secretKey=***"), "secret must be masked");
  assert.ok(!snap.includes("abc123"));
  debugLog.clear();
  assert.equal(debugLog.getSnapshot(), "");
});

test("debugLog ring buffer keeps the newest 2000 lines", () => {
  debugLog.clear();
  for (let i = 0; i < 2005; i++) debugLog.log("line " + i);
  const rows = debugLog.getSnapshot().split("\n");
  assert.equal(rows.length, 2000);
  assert.ok(rows[0].endsWith("line 5"), "oldest lines dropped");
  assert.ok(rows[rows.length - 1].endsWith("line 2004"));
  debugLog.clear();
});
