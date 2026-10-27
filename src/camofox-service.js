import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";

let startupPromise;
let serviceProcess;

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function canBind(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  const start = Math.min(65535, Math.max(1024, Number(startPort) || 9377));
  for (let offset = 0; offset < 80 && start + offset <= 65535; offset += 1) {
    if (await canBind(start + offset)) return start + offset;
  }
  throw new Error(`Could not find a free local port near ${start}. Set CAMOFOX_BASE_URL to a reachable Camofox service.`);
}

function serviceUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function serviceResponds(baseUrl, accessKey) {
  const headers = { Accept: "application/json" };
  if (accessKey) headers.Authorization = `Bearer ${accessKey}`;
  try {
    const health = await fetch(new URL("/health", baseUrl), { headers, signal: AbortSignal.timeout(1500) });
    if (!health.ok) return false;
    const tabs = await fetch(new URL("/tabs?userId=nabees-agent-healthcheck", baseUrl), {
      headers,
      signal: AbortSignal.timeout(1500)
    });
    return tabs.ok;
  } catch {
    return false;
  }
}

function childEnvironment(port, accessKey) {
  const env = {};
  for (const key of [
    "PATH", "HOME", "NODE_ENV", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LD_LIBRARY_PATH", "LANG", "LC_ALL"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME ||= os.homedir();
  env.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  env.NODE_ENV ||= "production";
  env.CAMOFOX_PORT = String(port);
  env.PORT = String(port);
  env.CAMOFOX_BIND_HOST = "127.0.0.1";
  env.CAMOFOX_ACCESS_KEY = accessKey;
  env.CAMOFOX_CRASH_REPORT_ENABLED = "false";
  env.CAMOFOX_DISABLE_DEFAULT_ADDONS = "1";
  return env;
}

function launchService(port, accessKey) {
  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npmCommand, ["--yes", "@askjo/camofox-browser"], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: childEnvironment(port, accessKey),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const recentOutput = [];
  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      recentOutput.push(line.slice(0, 500));
      if (recentOutput.length > 30) recentOutput.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("error", (error) => {
    recentOutput.push(`Process error: ${error.message}`);
  });
  child.unref();
  return { child, recentOutput };
}

async function startLocalService() {
  const configuredUrl = new URL(config.camofoxBaseUrl);
  if (!isLoopback(configuredUrl.hostname)) {
    throw new Error("Camofox auto-start only applies to localhost. Set CAMOFOX_BASE_URL to your remote Camofox service.");
  }

  const configuredPort = Number(configuredUrl.port) || 9377;
  const port = await findAvailablePort(configuredPort);
  const accessKey = config.camofoxAccessKey || process.env.CAMOFOX_ACCESS_KEY || cryptoRandomKey();
  config.camofoxBaseUrl = serviceUrl(port);
  config.camofoxAccessKey = accessKey;

  const { child, recentOutput } = launchService(port, accessKey);
  serviceProcess = child;
  console.log(`Starting Camofox browser service on ${config.camofoxBaseUrl}`);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Camofox exited during startup (code ${child.exitCode}). ${recentOutput.slice(-8).join(" | ")}`);
    }
    if (await serviceResponds(config.camofoxBaseUrl, accessKey)) {
      console.log(`Camofox browser service is ready on port ${port}`);
      return { started: true, port, baseUrl: config.camofoxBaseUrl };
    }
    await delay(1000);
  }
  throw new Error(`Camofox did not become ready within 180 seconds on port ${port}. ${recentOutput.slice(-8).join(" | ")}`);
}

function cryptoRandomKey() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function ensureCamofoxService() {
  if (startupPromise) return await startupPromise;

  startupPromise = (async () => {
    if (await serviceResponds(config.camofoxBaseUrl, config.camofoxAccessKey)) {
      return { started: false, baseUrl: config.camofoxBaseUrl };
    }

    const configuredUrl = new URL(config.camofoxBaseUrl);
    if (!isLoopback(configuredUrl.hostname)) {
      throw new Error(`Camofox is not reachable at ${config.camofoxBaseUrl}. Remote services are not started automatically; check CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY.`);
    }
    if (process.env.CAMOFOX_AUTOSTART === "false") {
      throw new Error(`Camofox is not reachable at ${config.camofoxBaseUrl} and CAMOFOX_AUTOSTART=false.`);
    }
    return await startLocalService();
  })();

  try {
    return await startupPromise;
  } catch (error) {
    startupPromise = undefined;
    throw error;
  }
}

export function getCamofoxServiceProcess() {
  return serviceProcess;
}
