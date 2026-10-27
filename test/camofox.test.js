import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "camofox-adapter-test-"));
process.env.AGENT_WORKSPACE = workspace;
process.env.CAMOFOX_BASE_URL = "http://camofox.test:9377";
process.env.CAMOFOX_ACCESS_KEY = "test-key";

const { executeCamofoxTool, checkCamofoxHealth } = await import("../src/camofox.js");
const calls = [];
const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  calls.push({ method: options.method || "GET", pathname: parsed.pathname, search: parsed.search, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined });
  if (parsed.pathname === "/health") return jsonResponse({ status: "ok" });
  if (parsed.pathname === "/tabs" && options.method === "POST") return jsonResponse({ tabId: "remote-1", url: "https://example.com", title: "Example" });
  if (parsed.pathname === "/tabs" && (!options.method || options.method === "GET")) return jsonResponse({ running: true, tabs: [{ tabId: "remote-1", url: "https://example.com", title: "Example" }] });
  if (parsed.pathname.endsWith("/snapshot")) return jsonResponse({ snapshot: "[button e1] Continue [textbox e2] Search", url: "https://example.com", title: "Example" });
  if (parsed.pathname.endsWith("/screenshot")) return jsonResponse({ screenshot: { data: pngHeader.toString("base64"), mimeType: "image/png" } });
  if (parsed.pathname.endsWith("/downloads")) return jsonResponse({ downloads: [] });
  if (parsed.pathname.endsWith("/evaluate")) return jsonResponse({ ok: true, result: { value: "ok" } });
  if (parsed.pathname.endsWith("/forward") || parsed.pathname.endsWith("/refresh")) return jsonResponse({ ok: true, url: "https://example.com" });
  if (parsed.pathname.endsWith("/links")) return jsonResponse({ links: [{ href: "https://example.com/a" }] });
  if (parsed.pathname.endsWith("/images")) return jsonResponse({ images: [{ src: "https://example.com/a.png" }] });
  if (parsed.pathname.endsWith("/navigate")) return jsonResponse({ ok: true, url: "https://example.org", httpStatus: 200 });
  if (parsed.pathname.endsWith("/back")) return jsonResponse({ ok: true, url: "https://example.com" });
  if (parsed.pathname.endsWith("/click") || parsed.pathname.endsWith("/type") || parsed.pathname.endsWith("/wait") || parsed.pathname.endsWith("/scroll")) return jsonResponse({ ok: true });
  if (parsed.pathname === "/tabs/remote-1" && options.method === "DELETE") return jsonResponse({ ok: true });
  return jsonResponse({ error: "unhandled test route" }, 404);
};

test("Camofox adapter matches the documented HTTP contract", async () => {
  const health = await checkCamofoxHealth();
  assert.equal(health.status, "ok");

  const opened = await executeCamofoxTool("browser_open", { url: "https://example.com" });
  assert.equal(opened.tab_id, "camofox-tab-1");
  assert.equal(opened.browser, "camofox");

  const snapshot = await executeCamofoxTool("browser_snapshot", { tab_id: opened.tab_id });
  assert.match(snapshot.snapshot, /button e1/);

  const clicked = await executeCamofoxTool("browser_click", { tab_id: opened.tab_id, selector: "e1" });
  assert.equal(clicked.clicked, "e1");

  await executeCamofoxTool("browser_fill", { tab_id: opened.tab_id, selector: "e2", value: "hello" });
  const typeCall = calls.find((call) => call.pathname.endsWith("/type"));
  assert.equal(typeCall.body.ref, "e2");
  assert.equal(typeCall.body.text, "hello");

  const navigated = await executeCamofoxTool("browser_open", { tab_id: opened.tab_id, url: "https://example.org" });
  assert.equal(navigated.url, "https://example.org");
  assert.ok(calls.some((call) => call.pathname === "/tabs/remote-1/navigate"));

  const tabs = await executeCamofoxTool("browser_list_tabs", {});
  assert.equal(tabs[0].tab_id, opened.tab_id);

  const screenshot = await executeCamofoxTool("browser_screenshot", { tab_id: opened.tab_id });
  assert.ok(screenshot.file.startsWith("browser-screenshots" + path.sep));
  const screenshotBytes = await fs.readFile(path.join(workspace, screenshot.file));
  assert.equal(screenshotBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  assert.deepEqual(await executeCamofoxTool("browser_downloads", {}), [{ tab_id: opened.tab_id, downloads: [] }]);
  assert.deepEqual((await executeCamofoxTool("browser_evaluate", { tab_id: opened.tab_id, script: "document.title" })).result, { value: "ok" });
  assert.equal((await executeCamofoxTool("browser_links", { tab_id: opened.tab_id })).links.length, 1);
  assert.equal((await executeCamofoxTool("browser_images", { tab_id: opened.tab_id })).images.length, 1);
  await executeCamofoxTool("browser_forward", { tab_id: opened.tab_id });
  await executeCamofoxTool("browser_refresh", { tab_id: opened.tab_id });
  await executeCamofoxTool("browser_back", { tab_id: opened.tab_id });
  await executeCamofoxTool("browser_close", { tab_id: opened.tab_id });
  await assert.rejects(() => executeCamofoxTool("browser_snapshot", { tab_id: opened.tab_id }), /Unknown Camofox tab/);

  assert.ok(calls.every((call) => call.headers.Authorization === "Bearer test-key"));
  await fs.rm(workspace, { recursive: true, force: true });
});
