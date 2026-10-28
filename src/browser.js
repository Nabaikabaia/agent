import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";
import { config } from "./config.js";

const MAX_TEXT = 24_000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tabs = new Map();
let browserPromise;
let externalBrowserPromise;
let installPromise;
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

export async function validateBrowserUrl(value) {
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

function missingBrowserBinary(error) {
  const message = String(error?.message || error || "");
  return /executable doesn't exist|executable does not exist|please run .*install|browserType\.launch:.*executable|could not find.*browser/i.test(message);
}

async function findSystemBrowser() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
  }
  return null;
}

async function installManagedChromium() {
  if (process.env.BROWSER_AUTO_INSTALL === "false") {
    throw new Error("Automatic Chromium installation is disabled by BROWSER_AUTO_INSTALL=false.");
  }
  if (!installPromise) {
    installPromise = new Promise((resolve, reject) => {
      const command = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(command, ["run", "browser:install"], {
        cwd: projectRoot,
        env: process.env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      const append = (chunk) => { if (output.length < 6000) output += chunk.toString().slice(0, 6000 - output.length); };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => reject(new Error("Could not start the local Chromium installer: " + error.message)));
      child.on("close", (code) => {
        if (code === 0) resolve({ installed: true, output: output.trim() });
        else reject(new Error(`Automatic Chromium installation failed (exit ${code}). Install it during deployment with "npm run browser:install". ${output.trim()}`));
      });
    }).catch((error) => {
      installPromise = undefined;
      throw error;
    });
  }
  return installPromise;
}

async function launchLocalBrowser() {
  const explicitPath = String(process.env.BROWSER_EXECUTABLE_PATH || "").trim();
  let executablePath = null;
  if (explicitPath) {
    try { await fs.access(explicitPath); executablePath = explicitPath; } catch {}
    if (!executablePath) {
      throw new Error("BROWSER_EXECUTABLE_PATH is set, but the executable cannot be found or accessed.");
    }
  } else if (process.env.BROWSER_PREFER_SYSTEM !== "false") {
    executablePath = await findSystemBrowser();
  }
  const options = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(executablePath ? { executablePath } : {})
  };
  try {
    return await chromium.launch(options);
  } catch (firstError) {
    // A pinned executable is an explicit operator choice: never silently override it.
    if (process.env.BROWSER_EXECUTABLE_PATH) throw firstError;

    // If a detected system browser is incompatible, fall back to Patchright's managed build.
    if (executablePath) {
      try {
        return await chromium.launch({ headless: true, args: options.args });
      } catch (managedError) {
        if (!missingBrowserBinary(managedError)) {
          throw new Error(`System browser failed (${firstError.message}); managed Chromium also failed (${managedError.message}).`);
        }
        await installManagedChromium();
        return await chromium.launch({ headless: true, args: options.args });
      }
    }

    if (!missingBrowserBinary(firstError)) throw firstError;
    await installManagedChromium();
    return await chromium.launch({ headless: true, args: options.args });
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        return await launchLocalBrowser();
      } catch (localError) {
        const endpoint = String(process.env.BROWSER_CDP_URL || "").trim();
        if (endpoint && /^wss?:\/\//i.test(endpoint)) {
          try {
            externalBrowserPromise ||= chromium.connectOverCDP(endpoint);
            const connected = await externalBrowserPromise;
            return connected;
          } catch (remoteError) {
            externalBrowserPromise = undefined;
            throw new Error(`Local Chromium could not start (${localError.message}). The configured remote browser also failed (${remoteError.message}).`);
          }
        }
        browserPromise = undefined;
        throw new Error(`Nabees could not start its browser in this environment. ${localError.message} If the browser binary is missing, enable BROWSER_AUTO_INSTALL or run "npm run browser:install" during deployment. If system libraries or sandbox permissions are missing, use a compatible container image or configure an optional private BROWSER_CDP_URL fallback.`);
      }
    })().catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

export async function browserDiagnostics() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium"
  ].filter(Boolean);
  const installed = [];
  for (const candidate of candidates) {
    try { await fs.access(candidate); installed.push(candidate); } catch {}
  }
  return {
    runtime: "patchright",
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    headless: true,
    managed_browser_install: "npm run browser:install",
    auto_install_enabled: process.env.BROWSER_AUTO_INSTALL !== "false",
    remote_fallback_configured: Boolean(String(process.env.BROWSER_CDP_URL || "").trim()),
    explicit_executable_configured: Boolean(process.env.BROWSER_EXECUTABLE_PATH),
    detected_system_browsers: [...new Set(installed)],
    local_browser_started: Boolean(browserPromise),
    external_browser_connected: Boolean(externalBrowserPromise),
    note: "Diagnostics report environment hints; browser launch is tested when browser_open is called."
  };
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
  return trackTab(context, page);
}

function trackTab(context, page) {
  const id = `tab-${nextTab++}`;
  const tab = { id, context, page, createdAt: new Date().toISOString(), lastUrl: page.url(), networkLog: [] };
  const pushNetwork = (entry) => {
    tab.networkLog.push({ at: new Date().toISOString(), ...entry });
    if (tab.networkLog.length > 500) tab.networkLog.splice(0, tab.networkLog.length - 500);
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) tab.lastUrl = frame.url();
  });
  page.on("request", (request) => pushNetwork({
    type: "request", url: request.url(), method: request.method(),
    resource_type: request.resourceType(), request
  }));
  page.on("response", (response) => pushNetwork({
    type: "response", url: response.url(), status: response.status(),
    method: response.request().method(), resource_type: response.request().resourceType(),
    request: response.request(), response
  }));
  page.on("requestfailed", (request) => pushNetwork({
    type: "failed", url: request.url(), method: request.method(),
    resource_type: request.resourceType(), failure: request.failure()?.errorText || "Request failed",
    request
  }));
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

async function browserForward(args) {
  const tab = getTab(args.tab_id);
  const response = await tab.page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  return { tab_id: tab.id, url: tab.page.url(), title: await tab.page.title(), status: response?.status() ?? null };
}

async function browserRefresh(args) {
  const tab = getTab(args.tab_id);
  const response = await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  return { tab_id: tab.id, url: tab.page.url(), title: await tab.page.title(), status: response?.status() ?? null };
}

async function browserLinks(args) {
  const tab = getTab(args.tab_id);
  const links = await tab.page.locator("a[href]").evaluateAll((items) => items.slice(0, 200).map((item) => ({
    text: (item.innerText || item.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 500),
    href: item.href,
    title: item.title || ""
  })));
  return { tab_id: tab.id, url: tab.page.url(), links };
}

async function browserNetwork(args) {
  const tab = getTab(args.tab_id);
  const needle = String(args.url_contains || "").toLowerCase();
  const method = String(args.method || "").toUpperCase();
  const statusFilter = Number(args.status);
  const entries = tab.networkLog.filter((entry) =>
    (!needle || entry.url.toLowerCase().includes(needle)) &&
    (!method || entry.method === method) &&
    (!Number.isFinite(statusFilter) || statusFilter <= 0 || entry.status === statusFilter)
  ).slice(-Math.min(200, Math.max(1, Number(args.limit) || 60)));
  const redactHeaders = (headers) => Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [
    key, /authorization|cookie|token|api[-_]?key|secret/i.test(key) ? "[REDACTED]" : String(value).slice(0, 1000)
  ]));
  const output = [];
  for (const entry of entries) {
    const request = entry.request;
    const response = entry.response;
    const item = {
      at: entry.at, type: entry.type, url: entry.url, method: entry.method,
      status: entry.status ?? null, resource_type: entry.resource_type,
      failure: entry.failure || null,
      request_headers: request ? redactHeaders(request.headers()) : undefined
    };
    if (response) {
      item.response_headers = redactHeaders(await response.allHeaders().catch(() => ({})));
      if (args.include_bodies === true) {
        const contentType = String(item.response_headers["content-type"] || "");
        if (/json|text|javascript|xml|graphql/i.test(contentType)) {
          const raw = await response.text().catch(() => "");
          item.response_body = raw.slice(0, 12000)
            .replace(/("(?:access_token|refresh_token|token|api[_-]?key|password|secret|authorization)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
            .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]");
          if (raw.length > 12000) item.response_body += "\n[body truncated]";
        } else {
          item.response_body = "[omitted: response is not text/JSON]";
        }
      }
    }
    output.push(item);
  }
  return { tab_id: tab.id, url: tab.page.url(), captured_events: tab.networkLog.length, returned: output.length, events: output };
}


async function browserTurnstileDiagnostics(args) {
  const tab = getTab(args.tab_id);
  const page = tab.page;
  const candidates = new Map();
  const add = (value, source, evidence) => {
    const key = String(value || "").trim();
    // Turnstile site keys are public widget identifiers, not response tokens.
    if (!/^[0-9a-zA-Z_-]{8,200}$/.test(key)) return;
    const previous = candidates.get(key) || { sitekey: key, sources: [], evidence: [] };
    if (!previous.sources.includes(source)) previous.sources.push(source);
    if (evidence && previous.evidence.length < 5 && !previous.evidence.includes(evidence)) previous.evidence.push(evidence.slice(0, 300));
    candidates.set(key, previous);
  };
  const inspectUrl = (raw, source) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const pathAndHost = host + url.pathname;
      const looksTurnstile = /challenges\\.cloudflare\\.com|turnstile/i.test(pathAndHost);
      for (const name of ["sitekey", "site_key", "render", "k"]) {
        const value = url.searchParams.get(name);
        if (value && (looksTurnstile || name === "sitekey" || name === "site_key")) {
          add(value, source, url.origin + url.pathname + "?" + name + "=" + value);
        }
      }
    } catch {}
  };
  for (const entry of tab.networkLog) inspectUrl(entry.url, "network:" + entry.type);
  const pageFindings = await page.evaluate(() => {
    const out = [];
    const push = (sitekey, source, evidence) => {
      if (sitekey) out.push({ sitekey: String(sitekey), source, evidence: String(evidence || "").slice(0, 300) });
    };
    for (const el of document.querySelectorAll("[data-sitekey], [data-site-key], .cf-turnstile")) {
      push(el.getAttribute("data-sitekey") || el.getAttribute("data-site-key"), "dom-attribute", el.outerHTML);
    }
    for (const frame of document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')) {
      try {
        const src = new URL(frame.src);
        push(src.searchParams.get("k") || src.searchParams.get("sitekey") || src.searchParams.get("render"), "turnstile-iframe", src.origin + src.pathname + src.search);
      } catch {}
    }
    for (const script of document.scripts) {
      const src = script.src || "";
      if (/challenges\\.cloudflare\\.com\\/turnstile|turnstile/i.test(src)) {
        try {
          const url = new URL(src, location.href);
          push(url.searchParams.get("render") || url.searchParams.get("sitekey"), "turnstile-script-url", url.origin + url.pathname + url.search);
        } catch {}
      }
      if (script.textContent && /turnstile|cf-turnstile/i.test(script.textContent)) {
        const text = script.textContent.slice(0, 250000);
        const patterns = [
          /(?:sitekey|siteKey|site_key)\\s*[:=]\\s*["']([0-9a-zA-Z_-]{8,200})["']/g,
          /turnstile\\.render\\s*\\([^,]+,\\s*\\{[\\s\\S]{0,1000}?sitekey\\s*:\\s*["']([0-9a-zA-Z_-]{8,200})["']/g
        ];
        for (const pattern of patterns) {
          let match, count = 0;
          while ((match = pattern.exec(text)) && count++ < 10) push(match[1], "turnstile-inline-config", match[0]);
        }
      }
    }
    return out.slice(0, 100);
  }).catch(() => []);
  for (const finding of pageFindings) add(finding.sitekey, finding.source, finding.evidence);
  return {
    tab_id: tab.id,
    url: page.url(),
    turnstile_detected: candidates.size > 0 || tab.networkLog.some((entry) => /challenges\\.cloudflare\\.com\\/turnstile|turnstile/i.test(entry.url)),
    candidates: [...candidates.values()],
    note: "Diagnostic only: site keys identify public widgets. This tool does not solve challenges, create response tokens, or submit/inject tokens."
  };
}

async function browserConnectExternal() {
  const endpoint = String(process.env.BROWSER_CDP_URL || "").trim();
  if (!endpoint) throw new Error("Set BROWSER_CDP_URL to the DevTools WebSocket endpoint of the separately installed Chromium/Chrome browser, then restart Nabees.");
  if (!/^wss?:\/\//i.test(endpoint)) throw new Error("BROWSER_CDP_URL must be a ws:// or wss:// DevTools endpoint.");
  if (!externalBrowserPromise) {
    externalBrowserPromise = chromium.connectOverCDP(endpoint).catch((error) => {
      externalBrowserPromise = undefined;
      throw new Error("Could not connect to the external browser via CDP: " + error.message);
    });
  }
  const browser = await externalBrowserPromise;
  const contexts = browser.contexts();
  let added = 0;
  for (const context of contexts) {
    for (const page of context.pages()) {
      if ([...tabs.values()].some((tab) => tab.page === page)) continue;
      trackTab(context, page);
      added++;
    }
  }
  return { connected: true, contexts: contexts.length, tabs_discovered: added, message: "External browser connected. Use browser_list_tabs to inspect its tabs." };
}

async function browserImages(args) {
  const tab = getTab(args.tab_id);
  const images = await tab.page.locator("img").evaluateAll((items) => items.slice(0, 100).map((item) => ({
    src: item.currentSrc || item.src,
    alt: item.alt || "",
    title: item.title || "",
    width: item.naturalWidth || item.width || 0,
    height: item.naturalHeight || item.height || 0
  })));
  return { tab_id: tab.id, url: tab.page.url(), images };
}


export async function executeBrowserTool(name, args) {
  switch (name) {
    case "browser_diagnostics": return await browserDiagnostics();
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
    case "browser_forward": return await browserForward(args);
    case "browser_refresh": return await browserRefresh(args);
    case "browser_links": return await browserLinks(args);
    case "browser_images": return await browserImages(args);
    case "browser_network": return await browserNetwork(args);
    case "browser_turnstile_diagnostics": return await browserTurnstileDiagnostics(args);
    case "browser_connect_external": return await browserConnectExternal();
    default: throw new Error(`Unknown browser tool: ${name}`);
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
    browserPromise = undefined;
  }
  if (externalBrowserPromise) {
    const external = await externalBrowserPromise.catch(() => null);
    await external?.close().catch(() => {});
    externalBrowserPromise = undefined;
  }
  tabs.clear();
}
