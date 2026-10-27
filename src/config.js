import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file = path.join(projectRoot, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    // A non-empty environment variable takes precedence, but empty PM2/shell
    // values should not mask a populated value in the project's .env file.
    if (process.env[match[1]] !== undefined && process.env[match[1]] !== "") continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

// Load the project .env independently of the process working directory.
loadEnvFile();

const workspace = path.resolve(process.env.AGENT_WORKSPACE || "./workspace");
const inceptionKey = process.env.INCEPTION_API_KEY || process.env.INCEPTIONLABS_API_KEY || process.env.INCEPTION_LABS_API_KEY || "";
const provider = (process.env.AI_PROVIDER || process.env.OXION_PROVIDER || (inceptionKey ? "inception" : "openrouter")).trim().toLowerCase();
const isInception = provider === "inception" || provider === "inceptionlabs";

export const config = {
  provider,
  browserBackend: (process.env.BROWSER_BACKEND || "camofox").trim().toLowerCase(),
  camofoxBaseUrl: (process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377").replace(/\/+$/, ""),
  camofoxAccessKey: process.env.CAMOFOX_ACCESS_KEY || "",
  apiKey: isInception
    ? inceptionKey
    : (process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || process.env.OXION_API_KEY || ""),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramOwnerId: process.env.TELEGRAM_OWNER_ID || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  baseUrl: (isInception
    ? (process.env.INCEPTION_BASE_URL || "https://api.inceptionlabs.ai/v1")
    : (process.env.OPENROUTER_BASE_URL || process.env.AI_BASE_URL || process.env.OXION_BASE_URL || "https://openrouter.ai/api/v1")).replace(/\/+$/, ""),
  model: isInception
    ? (process.env.INCEPTION_MODEL || "mercury-3")
    : (process.env.OPENROUTER_MODEL || process.env.AI_MODEL || process.env.OXION_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free"),
  workspace,
  stateDir: path.resolve(".agent-state"),
  agentsDir: path.resolve(process.env.AGENT_PROFILES_DIR || "./agents"),
  maxSteps: Math.min(20, Math.max(1, Number.parseInt(process.env.AGENT_MAX_STEPS || "8", 10) || 8)),
  aiRequestTimeoutMs: Math.min(600_000, Math.max(30_000, Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "300000", 10) || 300_000))
};

export function validateConfig() {
  if (!config.apiKey) {
    const variable = config.provider === "inception" || config.provider === "inceptionlabs"
      ? "INCEPTION_API_KEY"
      : "OPENROUTER_API_KEY";
    throw new Error(`Missing API key for provider "${config.provider}". Set ${variable} in .env.`);
  }
  if (!/^https:\/\//i.test(config.baseUrl)) throw new Error("AI API base URL must use HTTPS.");
}
