import fs from "node:fs";
import path from "node:path";

function loadEnvFile(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

// Load local .env before reading any configuration values.
loadEnvFile();

const workspace = path.resolve(process.env.AGENT_WORKSPACE || "./workspace");

export const config = {
  apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || process.env.OXION_API_KEY || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramOwnerId: process.env.TELEGRAM_OWNER_ID || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  baseUrl: (process.env.OPENROUTER_BASE_URL || process.env.AI_BASE_URL || process.env.OXION_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  model: process.env.OPENROUTER_MODEL || process.env.AI_MODEL || process.env.OXION_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
  workspace,
  stateDir: path.resolve(".agent-state"),
  agentsDir: path.resolve(process.env.AGENT_PROFILES_DIR || "./agents"),
  maxSteps: Math.min(20, Math.max(1, Number.parseInt(process.env.AGENT_MAX_STEPS || "8", 10) || 8)),
  aiRequestTimeoutMs: Math.min(600_000, Math.max(30_000, Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "300000", 10) || 300_000))
};

export function validateConfig() {
  if (!config.apiKey) throw new Error("Missing API key. Set OPENROUTER_API_KEY in .env (see .env.example).");
  if (!/^https:\/\//i.test(config.baseUrl)) throw new Error("AI API base URL must use HTTPS.");
}
