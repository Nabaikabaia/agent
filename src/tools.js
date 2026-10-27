import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { executeBrowserTool } from "./browser.js";
import { requestUserChoice } from "./interaction.js";
import { requestPackageInstallApproval } from "./approvals.js";

const MAX_OUTPUT = 30_000;
let telegramPhotoSender = null;

export function registerTelegramPhotoSender(sender) {
  telegramPhotoSender = sender;
}

async function sendTelegramPhoto(args) {
  if (!telegramPhotoSender) throw new Error("Telegram photo delivery is not initialized.");
  const file = safePath(args.path);
  const ext = path.extname(file).toLowerCase();
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[ext];
  if (!mime) throw new Error("Only PNG, JPEG, and WEBP images can be sent to Telegram.");
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("Image path is not a file.");
  if (stat.size > 10 * 1024 * 1024) throw new Error("Image exceeds Telegram's 10 MB sendPhoto limit.");
  return await telegramPhotoSender({ filePath: file, caption: String(args.caption || "").slice(0, 900) });
}
const DEFAULT_TIMEOUT_MS = 120_000;
const COMMANDS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "git", "python", "python3", "pip", "pip3",
  "pytest", "ruff", "uv", "cargo", "rustc", "go", "make", "cmake", "gcc", "g++",
  "java", "javac", "gradle", "mvn", "curl", "tar", "unzip", "zip", "ls", "cat", "head",
  "tail", "find", "grep", "rg", "sed", "awk", "wc", "which", "pwd", "env", "printenv"
]);
const DENIED_COMMANDS = new Set(["sudo", "su", "shutdown", "reboot", "mkfs", "dd", "mount", "umount", "passwd", "useradd", "userdel", "iptables", "systemctl"]);
const DENIED_PATTERNS = [
  /(^|\s)rm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
  /\b(git\s+push|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|npm\s+publish)\b/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /\b(chmod\s+777|chown\s+-R)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add)\b[^\n]*\s(--global|-g)\b/i,
  /\bpip3?\s+install\b/i
];

export const toolDefinitions = [
  { type: "function", function: { name: "list_files", description: "List files and directories under the configured workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file inside the configured workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or replace a UTF-8 text file inside the workspace. Never write secrets.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the public web for current information. Returns result titles, URLs and snippets.", parameters: { type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "browse_url", description: "Fetch and extract readable text from a public HTTP(S) page, including documentation pages. Use web_search to discover URLs first.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "github_api", description: "Read public GitHub repository metadata, files, commits, issues, pull requests, releases, and search results using the GitHub REST API. A configured GITHUB_TOKEN enables higher limits/private repositories. Use API paths such as /repos/owner/repo, /repos/owner/repo/contents/src, /repos/owner/repo/issues, /repos/owner/repo/pulls, /repos/owner/repo/commits, /repos/owner/repo/releases, /search/repositories?q=... or /search/code?q=... .", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "install_package", description: "Request owner approval in Telegram, then install a project dependency in the configured workspace using npm, pnpm, yarn, or bun. Choose dev=true for development-only packages. Do not install global packages. Direct package-install commands through run_command are blocked.", parameters: { type: "object", properties: { package: { type: "string", minLength: 1 }, manager: { type: "string", enum: ["npm", "pnpm", "yarn", "bun"] }, dev: { type: "boolean" } }, required: ["package", "manager"], additionalProperties: false } } },
  { type: "function", function: { name: "run_command", description: "Run a command in the configured workspace for development, tests, builds, Git inspection, or project setup. Provide the executable and arguments as a single command string; shell operators, pipes, and redirections are not supported. Commands run without agent API credentials and are time/output limited. Inspect project scripts before running them.", parameters: { type: "object", properties: { command: { type: "string", minLength: 1 }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, required: ["command"], additionalProperties: false } } },
  { type: "function", function: { name: "run_check", description: "Compatibility tool for common project checks and read-only Git inspection.", parameters: { type: "object", properties: { command: { type: "string", enum: ["npm run check", "npm test", "npm run test", "npm run build", "git status --short", "git diff --", "git log -5 --oneline"] } }, required: ["command"], additionalProperties: false } } },
  { type: "function", function: { name: "ask_user", description: "Pause the current task and ask the configured Telegram owner a question with 2–8 custom in-message buttons. Use this when a decision, clarification, preference, or choice from the user is needed before continuing. Button labels should be short and meaningful. The task resumes with the exact selected choice. Never use this to request secrets.", parameters: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 1200 }, choices: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } }, timeout_seconds: { type: "integer", minimum: 10, maximum: 300 } }, required: ["prompt", "choices"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_open", description: "Open a URL in a real headless Chromium browser using Playwright. JavaScript-rendered sites are supported. Creates a new isolated tab unless tab_id is provided. HTTP(S) only; local/private network targets are blocked by default.", parameters: { type: "object", properties: { url: { type: "string" }, tab_id: { type: "string" }, wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] }, timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_list_tabs", description: "List open Playwright browser tabs, titles, and URLs.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "browser_snapshot", description: "Inspect the current page DOM and visible text, links, buttons, inputs, and images. Use this before interacting with unfamiliar pages.", parameters: { type: "object", properties: { tab_id: { type: "string" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_click", description: "Click a page element by CSS selector, role+name, accessible label, placeholder, or text. Use browser_snapshot first to identify the right target.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, exact: { type: "boolean" }, force: { type: "boolean" }, timeout_ms: { type: "integer" }, wait_ms: { type: "integer" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_fill", description: "Fill a form field by selector, accessible label, placeholder, role+name, or text. Do not send secrets to untrusted sites without authorization.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, exact: { type: "boolean" }, value: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["tab_id", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_type", description: "Type text character-by-character into a located element, useful for pages that react to keyboard events.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, exact: { type: "boolean" }, delay_ms: { type: "integer" }, timeout_ms: { type: "integer" } }, required: ["tab_id", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_press", description: "Press a keyboard key on a located element or the active page (e.g. Enter, Tab, Escape, Control+A).", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, exact: { type: "boolean" }, key: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["tab_id", "key"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_select", description: "Select option(s) in a native select field by CSS selector or accessible locator.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, exact: { type: "boolean" }, values: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Option value(s) to select." }, timeout_ms: { type: "integer" } }, required: ["tab_id", "values"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_scroll", description: "Scroll the page by x/y pixels or scroll a selected element into view.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_screenshot", description: "Capture a screenshot of the current page and save it under workspace/browser-screenshots. Use this to preserve visual evidence.", parameters: { type: "object", properties: { tab_id: { type: "string" }, full_page: { type: "boolean" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "send_telegram_photo", description: "Send an existing PNG, JPEG, or WEBP image from the configured workspace to the configured Telegram owner as a photo. Use after browser_screenshot when the user asks you to send the screenshot/image. Provide the relative workspace path returned by the screenshot tool.", parameters: { type: "object", properties: { path: { type: "string" }, caption: { type: "string", maxLength: 900 } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_evaluate", description: "Run JavaScript in the current webpage context for DOM inspection or ordinary page interaction. This does not run in Node.js and cannot directly access the agent filesystem or environment. Never use it to defeat access controls or anti-abuse systems.", parameters: { type: "object", properties: { tab_id: { type: "string" }, script: { type: "string" } }, required: ["tab_id", "script"], additionalProperties: false } } },

  { type: "function", function: { name: "browser_wait", description: "Wait for a CSS selector, text, or page load state, or pause briefly for dynamic content. Prefer condition-based waits over fixed sleeps.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, state: { type: "string", enum: ["visible", "hidden", "attached", "detached", "load", "domcontentloaded", "networkidle"] }, timeout_ms: { type: "integer", minimum: 500, maximum: 60000 }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_upload", description: "Upload a file from inside the configured workspace to a page file input. The file path must stay within the workspace.", parameters: { type: "object", properties: { tab_id: { type: "string" }, selector: { type: "string" }, path: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["tab_id", "selector", "path"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_back", description: "Navigate the current tab back one history entry.", parameters: { type: "object", properties: { tab_id: { type: "string" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_close", description: "Close a browser tab and its isolated browser context.", parameters: { type: "object", properties: { tab_id: { type: "string" } }, required: ["tab_id"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_downloads", description: "List recent browser download events. Downloads are saved under workspace/browser-downloads.", parameters: { type: "object", properties: {}, additionalProperties: false } } },

];

function safePath(relativePath = ".") {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) throw new Error("Invalid path.");
  const resolved = path.resolve(config.workspace, relativePath);
  const rel = path.relative(config.workspace, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Path is outside the configured workspace.");
  return resolved;
}

async function listFiles(args) {
  const dir = safePath(args.path || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.slice(0, 200).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
}

async function readFile(args) {
  const file = safePath(args.path);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > 200_000) throw new Error("File exceeds the 200 KB read limit.");
  return await fs.readFile(file, "utf8");
}

async function writeFile(args) {
  if (typeof args.content !== "string") throw new Error("content must be a string.");
  if (Buffer.byteLength(args.content, "utf8") > 200_000) throw new Error("File exceeds the 200 KB write limit.");
  const file = safePath(args.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content, { encoding: "utf8", mode: 0o600 });
  return { written: path.relative(config.workspace, file), bytes: Buffer.byteLength(args.content, "utf8") };
}

function cleanHtml(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(svg|nav|footer|header|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|article|section|h[1-6]|li|tr|br|main)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function assertPublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a valid absolute URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs are supported.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host === "0.0.0.0" ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error("Private and local network addresses are not allowed.");
  }
  return url;
}

async function webSearch(args) {
  const query = String(args.query || "").trim();
  if (query.length < 2 || query.length > 300) throw new Error("Search query must be 2–300 characters.");
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NabeesAgent/0.2)" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}.`);
  const html = await response.text();
  const results = [];
  const blocks = html.split(/<div class="result[^>]*>/i).slice(1, 9);
  for (const block of blocks) {
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const clean = (value) => cleanHtml(value);
    let resultUrl = link[1].replace(/&amp;/g, "&");
    try {
      const parsed = new URL(resultUrl, "https://duckduckgo.com");
      if (parsed.hostname.includes("duckduckgo.com") && parsed.searchParams.has("uddg")) resultUrl = decodeURIComponent(parsed.searchParams.get("uddg"));
    } catch {}
    results.push({ title: clean(link[2]), url: resultUrl, snippet: snippet ? clean(snippet[1]) : "" });
  }
  return results;
}

async function browseUrl(args) {
  const url = assertPublicUrl(args.url);
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NabeesAgent/0.2)", "Accept": "text/html,text/plain,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Page request failed with HTTP ${response.status}.`);
  const finalUrl = assertPublicUrl(response.url);
  const type = response.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml\+xml|application\/json/i.test(type)) throw new Error(`Unsupported page content type: ${type}`);
  const raw = await response.text();
  return { url: finalUrl.href, status: response.status, contentType: type, text: (type.includes("html") || type.includes("xhtml") ? cleanHtml(raw) : raw).slice(0, 22_000) };
}

async function githubApi(args) {
  const apiPath = String(args.path || "").trim();
  if (!apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.includes("..") || apiPath.length > 1500) throw new Error("Provide a GitHub REST API path, not a full URL.");
  if (!(/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(apiPath) || /^\/search\/(repositories|code|issues|commits)\?/.test(apiPath))) {
    throw new Error("Allowed paths are repository endpoints (/repos/owner/repo/...) and GitHub search endpoints (/search/...).");
  }
  const url = new URL(apiPath, "https://api.github.com");
  if (url.origin !== "https://api.github.com") throw new Error("GitHub API host is fixed.");
  const headers = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Nabees-Agent" };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
  let data;
  try { data = JSON.parse(text); } catch { return text.slice(0, MAX_OUTPUT); }
  return JSON.stringify(data).slice(0, MAX_OUTPUT);
}

// Small shell-like argument parser: supports quoted arguments, but never invokes a shell.
function splitArgs(command) {
  const args = [];
  let current = "", quote = "", escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ""; else current += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { args.push(current); current = ""; started = false; } continue; }
    if ("|;&<>\n\r".includes(char)) throw new Error("Shell operators, pipes, and redirections are not supported. Run one command at a time.");
    current += char; started = true;
  }
  if (escaped || quote) throw new Error("Unclosed quote or escape in command.");
  if (started) args.push(current);
  if (!args.length) throw new Error("Command is empty.");
  return args;
}

function validateCommand(args, original, allowPackageInstall = false) {
  const executable = path.basename(args[0]).toLowerCase();
  if (!COMMANDS.has(executable) || DENIED_COMMANDS.has(executable)) throw new Error(`Command '${executable}' is not on the supported executable list.`);
  if (DENIED_PATTERNS.some((pattern) => pattern.test(original))) throw new Error("This potentially destructive or unsafe command is blocked.");
  if (!allowPackageInstall && /\b(npm\s+(?:install|i)|pnpm\s+(?:add|install|i)|yarn\s+(?:add|install)|bun\s+(?:add|install))\b/i.test(original)) {
    throw new Error("Package installation must use the install_package tool, which requests owner approval in Telegram.");
  }
  if (args.some((arg) => arg === "--force-with-lease" || arg === "--no-verify")) throw new Error("This command includes a blocked bypass/force option.");
  return executable;
}

async function runCommand(command, timeoutSeconds = 120, allowPackageInstall = false) {
  if (typeof command !== "string" || command.length > 2000) throw new Error("Command must be a string under 2000 characters.");
  const args = splitArgs(command);
  const executable = validateCommand(args, command, allowPackageInstall);
  await fs.mkdir(config.workspace, { recursive: true });
  const timeoutMs = Math.min(300, Math.max(1, Number(timeoutSeconds) || 120)) * 1000;
  return await new Promise((resolve, reject) => {
    const childEnv = { PATH: process.env.PATH || "", CI: "1", npm_config_audit: "false", npm_config_fund: "false" };
    for (const key of ["HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) if (process.env[key]) childEnv[key] = process.env[key];
    // Avoid passing Oxion, Telegram, or GitHub credentials into project commands.
    const child = spawn(args[0], args.slice(1), { cwd: config.workspace, env: childEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, outputTruncated = false;
    const collect = (target, chunk) => {
      if (target === "stdout") { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString().slice(0, MAX_OUTPUT - stdout.length); else outputTruncated = true; }
      else if (stderr.length < MAX_OUTPUT) stderr += chunk.toString().slice(0, MAX_OUTPUT - stderr.length);
      else outputTruncated = true;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, executable, exitCode: code, signal, timedOut, outputTruncated, stdout, stderr });
    });
  });
}

async function installPackage(args) {
  const manager = args.manager;
  const pkg = String(args.package || "").trim();
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) throw new Error("Unsupported package manager.");
  if (!pkg || pkg.length > 250 || /[\n\r;&|<>\0]/.test(pkg) || pkg.startsWith("-")) throw new Error("Invalid package name/specifier.");
  if (/^(npm|pnpm|yarn|bun)@/.test(pkg)) throw new Error("Use the manager field to select a package manager.");
  const approval = await requestPackageInstallApproval({ packageName: pkg, manager, dev: Boolean(args.dev) });
  if (!approval.approved) {
    return {
      installed: false,
      approval: approval.status,
      package: pkg,
      message: approval.message || "Package installation was not approved."
    };
  }

  const managerArgs = manager === "npm" ? ["install", ...(args.dev ? ["--save-dev"] : []), "--", pkg]
    : manager === "pnpm" ? ["add", ...(args.dev ? ["--save-dev"] : []), pkg]
    : manager === "yarn" ? ["add", ...(args.dev ? ["--dev"] : []), pkg]
    : ["add", ...(args.dev ? ["--dev"] : []), pkg];
  return await runCommand([manager, ...managerArgs].join(" "), 180, true);
}

async function runCheck(args) {
  const commands = new Set(["npm run check", "npm test", "npm run test", "npm run build", "git status --short", "git diff --", "git log -5 --oneline"]);
  if (!commands.has(args.command)) throw new Error("Command is not allowed.");
  return await runCommand(args.command, 120);
}

export async function executeTool(name, args) {
  switch (name) {
    case "list_files": return await listFiles(args);
    case "read_file": return await readFile(args);
    case "write_file": return await writeFile(args);
    case "web_search": return await webSearch(args);
    case "browse_url": return await browseUrl(args);
    case "github_api": return await githubApi(args);
    case "install_package": return await installPackage(args);
    case "run_command": return await runCommand(args.command, args.timeout_seconds);
    case "run_check": return await runCheck(args);
    case "ask_user": return await requestUserChoice(args);
    case "send_telegram_photo": return await sendTelegramPhoto(args);
    case "browser_open":
    case "browser_list_tabs":
    case "browser_snapshot":
    case "browser_click":
    case "browser_fill":
    case "browser_type":
    case "browser_press":
    case "browser_select":
    case "browser_scroll":
    case "browser_screenshot":
    case "browser_evaluate":
    case "browser_wait":
    case "browser_upload":
    case "browser_back":
    case "browser_close":
    case "browser_downloads":
      return await executeBrowserTool(name, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
