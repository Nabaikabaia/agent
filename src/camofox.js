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

async function request(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.camofoxAccessKey) headers.Authorization = `Bearer ${config.camofoxAccessKey}`;
  const response = await fetch(endpoint(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { text: raw.slice(0, 2000) }; }
  if (!response.ok) {
    throw new Error(`Camofox API ${method} ${path} returned HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1200)}`);
  }
  return data;
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
    const data = await request("POST", "/tabs", {
      userId, sessionKey, url: args.url
    });
    const remote = String(data.tabId ?? data.tab_id ?? data.id ?? "");
    if (!remote) throw new Error("Camofox created a tab but returned no tab identifier.");
    const id = `camofox-tab-${nextId++}`;
    const tab = { id, remoteId: remote, url: data.url || args.url, title: data.title || "" };
    tabs.set(id, tab);
    return { tab_id: id, url: tab.url, title: tab.title, status: data.status ?? null, browser: "camofox", details: data };
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
    return tabResult(args.tab_id, { clicked: ref, details: data, browser: "camofox" });
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
    const data = await request("DELETE", `/tabs/${encodeURIComponent(id)}`);
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
    const data = await request("GET", `/tabs/${encodeURIComponent(id)}/screenshot?userId=${encodeURIComponent(userId)}`);
    const candidates = [data.screenshot, data.data, data.image, data.base64, data.screenshotBase64];
    let encoded = candidates.find((value) => typeof value === "string" && value.length > 0);
    if (encoded?.startsWith("data:image/")) encoded = encoded.slice(encoded.indexOf(",") + 1);
    if (encoded && /^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
      const dir = path.resolve(config.workspace, "browser-screenshots");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `screenshot-camofox-${Date.now()}.png`);
      await fs.writeFile(file, Buffer.from(encoded, "base64"));
      const tab = tabs.get(String(args.tab_id));
      return { tab_id: args.tab_id, file: path.relative(config.workspace, file), url: data.url || tab.url, browser: "camofox" };
    }
    throw new Error("Camofox screenshot response did not include a recognised base64 image field.");
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

  if (name === "browser_select" || name === "browser_evaluate" || name === "browser_upload") {
    throw new Error(`${name} is not supported by the current Camofox API adapter. Use the standard Playwright backend for this operation.`);
  }

  throw new Error(`Unknown Camofox browser tool: ${name}`);
}

export async function checkCamofoxHealth() {
  return await request("GET", "/health");
}
