import test from "node:test";
import assert from "node:assert/strict";
import { browserDiagnostics, validateBrowserUrl } from "../src/browser.js";

test("Patchright browser only accepts public HTTP(S) URLs", async () => {
  await assert.rejects(() => validateBrowserUrl("file:///etc/passwd"), /only navigates to HTTP/i);
  await assert.rejects(() => validateBrowserUrl("https://user:pass@example.com"), /embedded credentials/i);
  await assert.rejects(() => validateBrowserUrl("http://127.0.0.1:3000"), /Private-network IP addresses are blocked/i);
  await assert.rejects(() => validateBrowserUrl("http://192.168.1.10"), /Private-network IP addresses are blocked/i);
  await assert.rejects(() => validateBrowserUrl("http://localhost:9377"), /Local and metadata hosts are blocked/i);
});


test("browser diagnostics describe the runtime without launching Chromium", async () => {
  const result = await browserDiagnostics();
  assert.equal(result.runtime, "patchright");
  assert.equal(result.headless, true);
  assert.equal(typeof result.platform, "string");
  assert.equal(typeof result.architecture, "string");
  assert.equal(typeof result.auto_install_enabled, "boolean");
  assert.equal(typeof result.remote_fallback_configured, "boolean");
  assert.equal(typeof result.detected_system_browsers.length, "number");
});
