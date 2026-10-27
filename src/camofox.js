import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const tabs = new Map();
const userId = process.env.CAMOFOX_USER_ID || "nabees-agent";
const sessionKey = process.env.CAMOFOX_SESSION_KEY || "telegram";
let nextId = 1;

function endpoint(path) {
  return new URL(path, config.camofoxBaseUrl);
}

async function request(method, path, body, { binary = false } = {}) {
  const headers = { Accept: binary ? "image/png" : "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.camofoxAccessKey) headers.Authorization = `Bearer ${config.camofoxAccessKey}`;
  const response = await fetch(endpoint(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) {
    const raw = await response.text();
    let details;
    try { details = raw ? JSON.parse(raw) : {}; } catch { details = { text: raw.slice(0, 2000) }; }
    throw new Error(`Camofox API ${method} ${path} returned HTTP ${response.status}: ${JSON.stringify(details).slice(0, 1200)}`);
  }
  if (binary) return Buffer.from(await response.arrayBuffer());
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return { text: raw.slice(0, 2000) }; }
}

function remoteId(tabId) {
  const tab = tabs.get(String(tabId || ""));
  if (!tab) throw new Error("Unknown Camofox tab. Use browser_list_tabs or browser_open first.");
  return tab.remoteId;
}

function tabResult(id, data = {}) {
  const tab = tabs.get(id);
  return { tab_id: id, ...data, ...(tab?.url ? { url: tab.url } : {}) };
}

function pickText(data) {
  return data.snapshot ?? data.text ?? data.content ?? data.result ?? JSON.stringify(data);
}

export async function executeCamofoxTool(name, args) {
  if (name === "browser_open") {
    if (args.tab_id) {
      const localId = String(args.tab_id);
      const tab = tabs.get(localId);
      if (!tab) throw new Error("Unknown Camofox tab. Use browser_list_tabs or browser_open first.");
      const data = await request("POST", `/tabs/${encodeURIComponent(tab.remoteId)}/navigate`, {
        userId, url: args.url
      });
      tab.url = data.url || args.url;
      tab.title = data.title || tab.title;
      return { tab_id: localId, url: tab.url, title: tab.title, status: data.httpStatus ?? null, browser: "camofox", details: data };
    }
    const data = await request("POST", "/tabs", { userId, sessionKey, url: args.url });
    const remote = String(data.tabId ?? data.tab_id ?? data.id ?? "");
    if (!remote) throw new Error("Camofox created a tab but returned no tab identifier.");
    const id = `camofox-tab-${nextId++}`;
    const tab = { id, remoteId: remote, url: data.url || args.url, title: data.title || "" };
    tabs.set(id, tab);
    return { tab_id: id, url: tab.url, title: tab.title, status: data.httpStatus ?? null, browser: "camofox", details: data };
  }

  if (name === "browser_list_tabs") {
    const data = await request("GET", `/tabs?userId=${encodeURIComponent(userId)}`);
    const remoteTabs = Array.isArray(data) ? data : (data.tabs || []);
    return remoteTabs.map((item) => {
      let local = [...tabs.values()].find((tab) => tab.remoteId === String(item.tabId ?? item.id));
      if (!local) {
        const remote = String(item.tabId ?? item.id ?? "");
        if (!remote) return null;
        const id = `camofox-tab-${nextId++}`;
        local = { id, remoteId: remote, url: item.url || "", title: item.title || "" };
        tabs.set(id, local);
      }
      return { tab_id: local.id, url: item.url || local.url, title: item.title || local.title, browser: "camofox" };
    }).filter(Boolean);
  }

  if (name === "browser_snapshot") {
    const id = remoteId(args.tab_id);
    const data = await request("GET", `/tabs/${encodeURIComponent(id)}/snapshot?userId=${encodeURIComponent(userId)}`);
    const tab = tabs.get(String(args.tab_id));
    return { tab_id: args.tab_id, url: data.url || tab.url, title: data.title || tab.title, snapshot: pickText(data), browser: "camofox", details: data };
  }

  if (name === "browser_click") {
    const id = remoteId(args.tab_id);
    const candidate = args.ref || args.selector || args.name || args.label || args.text;
    if (!candidate) throw new Error("Provide a Camofox element ref from browser_snapshot (for example e1), or a CSS selector.");
    const isElementRef = /^e\d+$/.test(candidate);
    if (!isElementRef && !args.selector) {
      throw new Error("Camofox interactions use element refs from browser_snapshot (for example e1) or an explicit CSS selector. Take a fresh snapshot and pass its element ref.");
    }
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/click`, {
      userId, ...(isElementRef ? { ref: candidate } : { selector: args.selector }), ...(args.wait_ms ? { waitMs: Math.min(5000, Number(args.wait_ms)) } : {})
    });
    return tabResult(args.tab_id, { clicked: candidate, details: data, browser: "camofox" });
  }

  if (name === "browser_type" || name === "browser_fill") {
    const id = remoteId(args.tab_id);
    const candidate = args.ref || args.selector || args.name || args.label || args.text || args.placeholder;
    if (!candidate) throw new Error("Provide a Camofox element ref from browser_snapshot (for example e1), or a CSS selector.");
    const isElementRef = /^e\d+$/.test(candidate);
    if (!isElementRef && !args.selector) {
      throw new Error("Camofox interactions use element refs from browser_snapshot (for example e1) or an explicit CSS selector. Take a fresh snapshot and pass its element ref.");
    }
    const value = String(name === "browser_fill" ? (args.value ?? "") : (args.text ?? ""));
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/type`, {
      userId, ...(isElementRef ? { ref: candidate } : { selector: args.selector }), text: value,
      ...(args.press_enter ? { pressEnter: true } : {})
    });
    return tabResult(args.tab_id, { typed_characters: value.length, details: data, browser: "camofox" });
  }

  if (name === "browser_press") {
    const id = remoteId(args.tab_id);
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/press`, {
      userId, key: args.key, ...(args.selector ? { selector: args.selector } : {})
    });
    return tabResult(args.tab_id, { key: args.key, details: data, browser: "camofox" });
  }

  if (name === "browser_scroll") {
    const id = remoteId(args.tab_id);
    const direction = Number(args.y) < 0 ? "up" : Number(args.x) < 0 ? "left" : Number(args.x) > 0 ? "right" : "down";
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/scroll`, { userId, direction });
    return tabResult(args.tab_id, { direction, details: data, browser: "camofox" });
  }

  if (name === "browser_back") {
    const id = remoteId(args.tab_id);
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/back`, { userId });
    const tab = tabs.get(String(args.tab_id));
    if (data.url) tab.url = data.url;
    return tabResult(args.tab_id, { details: data, browser: "camofox" });
  }

  if (name === "browser_close") {
    const id = remoteId(args.tab_id);
    const data = await request("DELETE", `/tabs/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`);
    tabs.delete(String(args.tab_id));
    return { closed: args.tab_id, details: data, browser: "camofox" };
  }

  if (name === "browser_wait") {
    const id = remoteId(args.tab_id);
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/wait`, {
      userId, ...(args.selector ? { selector: args.selector } : {}),
      ...(args.text ? { text: args.text } : {}),
      ...(args.wait_ms !== undefined ? { timeoutMs: Math.min(10_000, Math.max(0, Number(args.wait_ms))) } : {})
    });
    return tabResult(args.tab_id, { details: data, browser: "camofox" });
  }

  if (name === "browser_screenshot") {
    const id = remoteId(args.tab_id);
    const result = await request("GET", `/tabs/${encodeURIComponent(id)}/screenshot?userId=${encodeURIComponent(userId)}`);
    const encoded = result?.screenshot?.data || result?.screenshot || result?.data || result?.base64;
    if (typeof encoded !== "string") throw new Error("Camofox screenshot response did not contain base64 image data.");
    const image = Buffer.from(encoded.replace(/^data:image\\/png;base64,/, ""), "base64");
    if (image.length < 8 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Camofox screenshot response was not a valid PNG image.");
    }
    const dir = path.resolve(config.workspace, "browser-screenshots");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `screenshot-camofox-${Date.now()}.png`);
    await fs.writeFile(file, image);
    const tab = tabs.get(String(args.tab_id));
    return { tab_id: args.tab_id, file: path.relative(config.workspace, file), url: tab.url, browser: "camofox" };
  }

  if (name === "browser_downloads") {
    const results = [];
    for (const tab of tabs.values()) {
      try {
        const data = await request("GET", `/tabs/${encodeURIComponent(tab.remoteId)}/downloads?userId=${encodeURIComponent(userId)}`);
        results.push({ tab_id: tab.id, downloads: data.downloads || data });
      } catch (error) {
        results.push({ tab_id: tab.id, error: error.message });
      }
    }
    return results;
  }

  if (name === "browser_evaluate") {
    const id = remoteId(args.tab_id);
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/evaluate`, { userId, expression: args.script });
    return tabResult(args.tab_id, { result: data.result, browser: "camofox", details: data });
  }

  if (name === "browser_select") {
    const id = remoteId(args.tab_id);
    const selector = String(args.selector || "");
    if (!selector) throw new Error("Camofox select requires a CSS selector for the select element.");
    const values = Array.isArray(args.values) ? args.values : [args.values];
    const expression = '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el || el.tagName !== "SELECT") throw new Error("Select element not found"); const wanted = ' + JSON.stringify(values.map(String)) + '; for (const option of el.options) option.selected = wanted.includes(option.value); el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); return {value:el.value, selected:[...el.selectedOptions].map(o=>o.value)}; })()';
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/evaluate`, { userId, expression });
    return tabResult(args.tab_id, { selection: data.result, browser: "camofox" });
  }

  if (name === "browser_upload") {
    const id = remoteId(args.tab_id);
    const absolute = path.resolve(config.workspace, String(args.path || ""));
    const relative = path.relative(config.workspace, absolute);
    if (!args.path || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Upload path must stay inside the configured agent workspace.");
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error("Upload path must be a regular file.");
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/upload`, { userId, path: absolute, ...(args.selector ? { selector: args.selector } : {}) });
    return tabResult(args.tab_id, { uploaded: path.basename(absolute), details: data, browser: "camofox" });
  }

  if (name === "browser_forward" || name === "browser_refresh") {
    const id = remoteId(args.tab_id);
    const action = name === "browser_forward" ? "forward" : "refresh";
    const data = await request("POST", `/tabs/${encodeURIComponent(id)}/${action}`, { userId });
    const tab = tabs.get(String(args.tab_id));
    if (data.url) tab.url = data.url;
    return tabResult(args.tab_id, { action, details: data, browser: "camofox" });
  }

  if (name === "browser_links" || name === "browser_images") {
    const id = remoteId(args.tab_id);
    const resource = name === "browser_links" ? "links" : "images";
    const data = await request("GET", `/tabs/${encodeURIComponent(id)}/${resource}?userId=${encodeURIComponent(userId)}`);
    return tabResult(args.tab_id, { [resource]: data[resource] || data, browser: "camofox" });
  }

  throw new Error(`Unknown Camofox browser tool: ${name}`);
}

export async function checkCamofoxHealth() {
  return await request("GET", "/health");
}
