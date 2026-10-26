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

const workspace = path.resolve(process.env.AGENT_WORKSPACE || "./workspace");

export const config = {
  apiKey: process.env.OXION_API_KEY || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramOwnerId: process.env.TELEGRAM_OWNER_ID || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  baseUrl: (process.env.OXION_BASE_URL || "https://www.oxionai.com/v1").replace(/\/+$/, ""),
  model: process.env.OXION_MODEL || "deepseek-v4-flash-0731",
  workspace,
  stateDir: path.resolve(".agent-state"),
  agentsDir: path.resolve(process.env.AGENT_PROFILES_DIR || "./agents"),
  maxSteps: Math.min(20, Math.max(1, Number.parseInt(process.env.AGENT_MAX_STEPS || "8", 10) || 8))
};

export function validateConfig() {
  if (!config.apiKey) throw new Error("Missing OXION_API_KEY. Copy .env.example to .env and add your key.");
  if (!/^https:\/\//i.test(config.baseUrl)) throw new Error("OXION_BASE_URL must use HTTPS.");
}
