import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under the configured workspace. Use a relative path; default is the workspace root.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Relative directory path, default ." } }, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the configured workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a UTF-8 text file inside the workspace. Create parent directories if needed. Never write secrets.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current information and return result titles, URLs and snippets.",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description: "Run only an approved project check/build script or a read-only Git inspection. Allowed commands: npm run check, npm test, npm run test, npm run build, git status --short, git diff --, git log -5 --oneline.",
      parameters: { type: "object", properties: { command: { type: "string", enum: ["npm run check", "npm test", "npm run test", "npm run build", "git status --short", "git diff --", "git log -5 --oneline"] } }, required: ["command"], additionalProperties: false }
    }
  }
];

function safePath(relativePath = ".") {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) throw new Error("Invalid path.");
  const resolved = path.resolve(config.workspace, relativePath);
  const rel = path.relative(config.workspace, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Path is outside the configured workspace.");
  }
  return resolved;
}

async function listFiles(args) {
  const dir = safePath(args.path || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.slice(0, 200).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
  }));
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

async function webSearch(args) {
  const query = String(args.query || "").trim();
  if (query.length < 2 || query.length > 300) throw new Error("Search query must be 2–300 characters.");
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NabeesAgent/0.1)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}.`);
  const html = await response.text();
  const results = [];
  const blocks = html.split(/<div class="result[^>]*>/i).slice(1, 9);
  for (const block of blocks) {
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const clean = (value) => value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    let resultUrl = link[1].replace(/&amp;/g, "&");
    try {
      const parsed = new URL(resultUrl, "https://duckduckgo.com");
      if (parsed.hostname.includes("duckduckgo.com") && parsed.searchParams.has("uddg")) resultUrl = decodeURIComponent(parsed.searchParams.get("uddg"));
    } catch {}
    results.push({ title: clean(link[2]), url: resultUrl, snippet: snippet ? clean(snippet[1]) : "" });
  }
  return results;
}

async function runCheck(args) {
  const commands = {
    "npm run check": ["npm", ["run", "check"]],
    "npm test": ["npm", ["test"]],
    "npm run test": ["npm", ["run", "test"]],
    "npm run build": ["npm", ["run", "build"]],
    "git status --short": ["git", ["status", "--short"]],
    "git diff --": ["git", ["diff", "--"]],
    "git log -5 --oneline": ["git", ["log", "-5", "--oneline"]]
  };
  const selected = commands[args.command];
  if (!selected) throw new Error("Command is not allowed.");
  return await new Promise((resolve, reject) => {
    // Do not pass the agent's API key or the rest of its environment into project scripts.
    const childEnv = { PATH: process.env.PATH || "", CI: "1" };
    for (const key of ["HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }
    const child = spawn(selected[0], selected[1], {
      cwd: config.workspace,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const limit = 30_000;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { if (stdout.length < limit) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < limit) stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ command: args.command, exitCode: code, stdout, stderr });
    });
  });
}

export async function executeTool(name, args) {
  switch (name) {
    case "list_files": return await listFiles(args);
    case "read_file": return await readFile(args);
    case "write_file": return await writeFile(args);
    case "web_search": return await webSearch(args);
    case "run_check": return await runCheck(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
