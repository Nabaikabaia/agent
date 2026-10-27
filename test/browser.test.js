import test from "node:test";
import assert from "node:assert/strict";
import { validateBrowserUrl } from "../src/browser.js";

test("Patchright browser only accepts public HTTP(S) URLs", async () => {
  await assert.rejects(() => validateBrowserUrl("file:///etc/passwd"), /only navigates to HTTP/i);
  await assert.rejects(() => validateBrowserUrl("https://user:pass@example.com"), /embedded credentials/i);
  await assert.rejects(() => validateBrowserUrl("http://127.0.0.1:3000"), /Private-network IP addresses are blocked/i);
  await assert.rejects(() => validateBrowserUrl("http://192.168.1.10"), /Private-network IP addresses are blocked/i);
  await assert.rejects(() => validateBrowserUrl("http://localhost:9377"), /Local and metadata hosts are blocked/i);
});
