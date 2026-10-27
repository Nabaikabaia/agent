import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { chromium } from "playwright";
import { config } from "./config.js";
import { executeCamofoxTool } from "./camofox.js";

const MAX_TEXT = 24_000;
const tabs = new Map();
let browserPromise;
let nextTab = 1;
const downloadLog = [];

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") ||
      normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validateBrowserUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a valid absolute URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("The browser only navigates to HTTP(S) URLs.");
  if (url.username || url.password) throw new Error("URLs containing embedded credentials are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "metadata.google.internal" || host === "metadata.azure.internal") {
    if (process.env.BROWSER_ALLOW_LOCALHOST !== "true" || (host !== "localhost" && host !== "127.0.0.1" && host !== "::1")) {
      throw new Error("Local and metadata hosts are blocked by default. Set BROWSER_ALLOW_LOCALHOST=true only for a trusted local development workflow.");
    }
  }
  if (net.isIP(host) && isPrivateAddress(host) && process.env.BROWSER_ALLOW_LOCALHOST !== "true") {
    throw new Error("Private-network IP addresses are blocked by default.");
  }
  if (!net.isIP(host) && host !== "localhost") {
    try {
      const addresses = await dns.lookup(host, { all: true, verbatim: true });
      if (addresses.some(({ address }) => isPrivateAddress(address)) && process.env.BROWSER_ALLOW_LOCALHOST !== "true") {
        throw new Error("This hostname resolves to a private or reserved network address and is blocked.");
      }
    } catch (error) {
      if (error.message.includes("private or reserved")) throw error;
      // DNS errors will be surfaced by Chromium with a clearer navigation error.
    }
  }
  return url;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }).catch((error) => {
      browserPromise = undefined;
      throw new Error(`Playwright could not launch Chromium. Run "npx playwright install chromium" and verify the Box has the required system libraries. Details: ${error.message}`);
    });
  }
  return browserPromise;
}

function getTab(tabId) {
  const tab = tabs.get(String(tabId || ""));
  if (!tab || tab.page.isClosed()) throw new Error("Unknown or closed tab. Use browser_list_tabs to see open tabs or browser_open to create one.");
  return tab;
}

async function createTab() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US"
  });
  await context.route("**/*", async (route) => {
    try {
      const requestUrl = new URL(route.request().url());
      if (["data:", "blob:", "about:"].includes(requestUrl.protocol)) { await route.continue(); return; }
      await validateBrowserUrl(route.request().url());
      await route.continue();
    } catch (error) {
      await route.abort("blockedbyclient").catch(() => {});
      downloadLog.push({ type: "blocked_request", url: route.request().url(), reason: error.message, at: new Date().toISOString() });
    }
  });
  const page = await context.newPage();
  const id = `tab-${nextTab++}`;
  const tab = { id, context, page, createdAt: new Date().toISOString(), lastUrl: "about:blank" };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) tab.lastUrl = frame.url();
  });
  page.on("download", async (download) => {
    try {
      const dir = path.resolve(config.workspace, "browser-downloads");
      await fs.mkdir(dir, { recursive: true });
      const suggested = path.basename(download.suggestedFilename() || `download-${Date.now()}`).replace(/[\\/\0]/g, "_");
      const target = path.join(dir, suggested || `download-${Date.now()}`);
      await download.saveAs(target);
      downloadLog.push({ type: "download", file: path.relative(config.workspace, target), url: download.url(), at: new Date().toISOString() });
    } catch (error) {
      downloadLog.push({ type: "download_error", filename: download.suggestedFilename(), reason: error.message, at: new Date().toISOString() });
    }
  });
  tabs.set(id, tab);
  return tab;
}

async function browserOpen(args) {
  const url = await validateBrowserUrl(args.url);
  const waitUntil = ["load", "domcontentloaded", "networkidle", "commit"].includes(args.wait_until) ? args.wait_until : "domcontentloaded";
  let tab;
  if (args.tab_id) tab = getTab(args.tab_id);
  else tab = await createTab();
  const response = await tab.page.goto(url.href, { waitUntil, timeout: Math.min(60_000, Math.max(1_000, Number(args.timeout_ms) || 30_000)) });
  return {
    tab_id: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    status: response?.status() ?? null,
    titleText: (await tab.page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 1500)
  };
}

async function browserListTabs() {
  const liveTabs = [...tabs.values()].filter((tab) => !tab.page.isClosed());
  return await Promise.all(liveTabs.map(async (tab) => ({
    tab_id: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    created_at: tab.createdAt
  })));
}

async function browserSnapshot(args) {
  const tab = getTab(args.tab_id);
  const page = tab.page;
  const snapshot = await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const labelFor = (el) => {
      const aria = el.getAttribute("aria-label");
      const labelled = el.getAttribute("aria-labelledby");
      const label = el.labels?.[0]?.innerText;
      return clean(aria || (labelled ? document.getElementById(labelled)?.innerText : "") || label || el.getAttribute("placeholder") || el.getAttribute("name") || "");
    };
    const elements = (selector, limit = 100) => [...document.querySelectorAll(selector)].slice(0, limit).map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || ""),
      label: labelFor(el),
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      href: el.href || "",
      disabled: Boolean(el.disabled),
      visible: Boolean(el.getClientRects().length)
    }));
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      text: clean(document.body?.innerText || "").slice(0, 18000),
      links: elements("a[href]", 80),
      buttons: elements("button, input[type=button], input[type=submit], [role=button]", 80),
      inputs: elements("input:not([type=hidden]), textarea, select, [contenteditable=true]", 80),
      images: elements("img", 30)
    };
  });
  return { tab_id: tab.id, ...snapshot };
}

function locatorFor(page, args) {
  if (args.selector) return page.locator(args.selector).first();
  if (args.role && args.name) return page.getByRole(args.role, { name: args.name, exact: Boolean(args.exact) }).first();
  if (args.label) return page.getByLabel(args.label, { exact: Boolean(args.exact) }).first();
  if (args.placeholder) return page.getByPlaceholder(args.placeholder, { exact: Boolean(args.exact) }).first();
  if (args.text) return page.getByText(args.text, { exact: Boolean(args.exact) }).first();
  throw new Error("Provide selector, role+name, label, placeholder, or text to identify an element.");
}

async function browserClick(args) {
  const tab = getTab(args.tab_id);
  const locator = locatorFor(tab.page, args);
  await locator.click({ timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)), ...(args.force ? { force: true } : {}) });
  if (args.wait_ms) await tab.page.waitForTimeout(Math.min(5000, Math.max(0, Number(args.wait_ms))));
  return { tab_id: tab.id, url: tab.page.url(), title: await tab.page.title(), clicked: args.selector || args.name || args.label || args.placeholder || args.text };
}

async function browserFill(args) {
  const tab = getTab(args.tab_id);
  const locator = locatorFor(tab.page, args);
  await locator.fill(String(args.value ?? ""), { timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)) });
  return { tab_id: tab.id, filled: args.selector || args.name || args.label || args.placeholder, value_length: String(args.value ?? "").length };
}

async function browserType(args) {
  const tab = getTab(args.tab_id);
  const locator = locatorFor(tab.page, args);
  await locator.pressSequentially(String(args.text ?? ""), { delay: Math.min(250, Math.max(0, Number(args.delay_ms) || 0)), timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)) });
  return { tab_id: tab.id, typed_characters: String(args.text ?? "").length };
}

async function browserPress(args) {
  const tab = getTab(args.tab_id);
  if (args.selector || args.role || args.label || args.placeholder || args.text) {
    await locatorFor(tab.page, args).press(args.key, { timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)) });
  } else {
    await tab.page.keyboard.press(args.key);
  }
  return { tab_id: tab.id, key: args.key, url: tab.page.url() };
}

async function browserSelect(args) {
  const tab = getTab(args.tab_id);
  const locator = locatorFor(tab.page, args);
  const selected = await locator.selectOption(args.values, { timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)) });
  return { tab_id: tab.id, selected };
}

async function browserScroll(args) {
  const tab = getTab(args.tab_id);
  if (args.selector) {
    await tab.page.locator(args.selector).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
  } else {
    await tab.page.evaluate(({ x, y }) => window.scrollBy(x, y), {
      x: Math.max(-5000, Math.min(5000, Number(args.x) || 0)),
      y: Math.max(-10000, Math.min(10000, Number(args.y) || 700))
    });
  }
  return { tab_id: tab.id, url: tab.page.url(), scroll: await tab.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })) };
}

async function browserScreenshot(args) {
  const tab = getTab(args.tab_id);
  const dir = path.resolve(config.workspace, "browser-screenshots");
  await fs.mkdir(dir, { recursive: true });
  const filename = `screenshot-${Date.now()}.png`;
  const file = path.join(dir, filename);
  await tab.page.screenshot({ path: file, fullPage: Boolean(args.full_page), animations: "disabled", timeout: 30_000 });
  return { tab_id: tab.id, file: path.relative(config.workspace, file), url: tab.page.url(), full_page: Boolean(args.full_page) };
}

async function browserEvaluate(args) {
  const tab = getTab(args.tab_id);
  const script = String(args.script || "");
  if (!script || script.length > 8000) throw new Error("Provide a page-context JavaScript expression/script up to 8000 characters.");
  // Runs in the current webpage context, not in Node.js; no filesystem or agent environment is exposed.
  const result = await tab.page.evaluate((source) => {
    const fn = new Function(`return (async () => { ${source}\n })()`);
    return fn();
  }, script);
  let serialized;
  try { serialized = JSON.stringify(result); } catch { serialized = String(result); }
  return { tab_id: tab.id, url: tab.page.url(), result: (serialized ?? "undefined").slice(0, MAX_TEXT) };
}

async function browserWait(args) {
  const tab = getTab(args.tab_id);
  const timeout = Math.min(60_000, Math.max(500, Number(args.timeout_ms) || 15_000));
  if (args.selector) {
    const state = ["visible", "hidden", "attached", "detached"].includes(args.state) ? args.state : "visible";
    await tab.page.locator(args.selector).first().waitFor({ state, timeout });
  } else if (args.text) {
    const locator = tab.page.getByText(args.text).first();
    const state = ["hidden", "attached", "detached"].includes(args.state) ? args.state : "visible";
    await locator.waitFor({ state, timeout });
  } else if (["load", "domcontentloaded", "networkidle"].includes(args.state)) {
    await tab.page.waitForLoadState(args.state, { timeout });
  } else if (args.wait_ms !== undefined) {
    await tab.page.waitForTimeout(Math.min(10_000, Math.max(0, Number(args.wait_ms) || 0)));
  } else {
    throw new Error("Provide selector, text, a load state, or wait_ms.");
  }
  return { tab_id: tab.id, url: tab.page.url(), title: await tab.page.title(), ready_state: await tab.page.evaluate(() => document.readyState) };
}

async function browserUpload(args) {
  const tab = getTab(args.tab_id);
  const root = path.resolve(config.workspace);
  const file = path.resolve(root, String(args.path || ""));
  const relative = path.relative(root, file);
  if (!args.path || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Upload path must be inside the configured workspace.");
  }
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error("Upload path resolves outside the configured workspace.");
  }
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("Upload path is not a file.");
  if (stat.size > 50 * 1024 * 1024) throw new Error("Uploads are limited to 50 MB per file.");
  await tab.page.locator(args.selector).first().setInputFiles(realFile, { timeout: Math.min(30_000, Math.max(500, Number(args.timeout_ms) || 10_000)) });
  return { tab_id: tab.id, uploaded: path.relative(root, realFile), bytes: stat.size };
}

async function browserBack(args) {
  const tab = getTab(args.tab_id);
  const response = await tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  return { tab_id: tab.id, url: tab.page.url(), title: await tab.page.title(), status: response?.status() ?? null };
}

async function browserClose(args) {
  const tab = getTab(args.tab_id);
  await tab.context.close();
  tabs.delete(tab.id);
  return { closed: tab.id };
}

async function browserDownloads() {
  return downloadLog.slice(-50);
}

export async function executeBrowserTool(name, args) {
  if (config.browserBackend === "camofox") {
    if (name === "browser_open") await validateBrowserUrl(args.url);
    return await executeCamofoxTool(name, args);
  }
  switch (name) {
    case "browser_open": return await browserOpen(args);
    case "browser_list_tabs": return await browserListTabs();
    case "browser_snapshot": return await browserSnapshot(args);
    case "browser_click": return await browserClick(args);
    case "browser_fill": return await browserFill(args);
    case "browser_type": return await browserType(args);
    case "browser_press": return await browserPress(args);
    case "browser_select": return await browserSelect(args);
    case "browser_scroll": return await browserScroll(args);
    case "browser_screenshot": return await browserScreenshot(args);
    case "browser_evaluate": return await browserEvaluate(args);
    case "browser_wait": return await browserWait(args);
    case "browser_upload": return await browserUpload(args);
    case "browser_back": return await browserBack(args);
    case "browser_close": return await browserClose(args);
    case "browser_downloads": return await browserDownloads();
    default: throw new Error(`Unknown browser tool: ${name}`);
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
    browserPromise = undefined;
  }
  tabs.clear();
}
