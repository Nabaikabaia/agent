import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { requestUserChoice } from "./interaction.js";

const MAX_SKILL_FILES = 150;
const MAX_SKILL_BYTES = 80_000;
const MAX_SKILL_CONTEXT_CHARS = 24_000;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are",
  "can", "will", "when", "what", "how", "use", "using", "task", "make", "please",
  "agent", "skill", "skills", "install", "help", "about", "then", "them", "their",
  "have", "has", "was", "were", "not", "but", "all", "any", "our", "its", "only"
]);

function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9+._-]{2,}/g)?.filter(token => !STOP_WORDS.has(token)) || []);
}

export function selectRelevantSkills(task, skills, limit = 3) {
  const taskTokens = tokens(task);
  if (!taskTokens.size) return [];
  return skills.map(skill => {
    const metadata = tokens((skill.name || "") + " " + (skill.description || ""));
    const body = tokens(String(skill.content || "").slice(0, 12_000));
    let score = 0;
    for (const token of taskTokens) {
      if (metadata.has(token)) score += 3;
      else if (body.has(token)) score += 1;
    }
    return { ...skill, score };
  }).filter(skill => skill.score > 0)
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, Math.max(1, Math.min(5, limit)));
}

function frontmatterValue(markdown, key) {
  const frontmatter = String(markdown).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return "";
  const line = frontmatter[1].split(/\r?\n/).find(item => new RegExp("^\\s*" + key + "\\s*:").test(item));
  return line ? line.replace(new RegExp("^\\s*" + key + "\\s*:\\s*"), "").trim().replace(/^["']|["']$/g, "") : "";
}

async function discoverSkillFiles(root, depth = 0, result = []) {
  if (result.length >= MAX_SKILL_FILES || depth > 4) return result;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (result.length >= MAX_SKILL_FILES) break;
    if (entry.name.startsWith(".")) continue;
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await discoverSkillFiles(target, depth + 1, result);
    } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      result.push(target);
    }
  }
  return result;
}

export async function loadRelevantSkills(task) {
  const home = process.env.HOME || "";
  const roots = [
    path.join(config.workspace, ".agents", "skills"),
    path.join(config.workspace, "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills")
  ].filter(Boolean);
  const seen = new Set();
  const loaded = [];
  for (const root of roots) {
    const files = await discoverSkillFiles(root);
    for (const file of files) {
      if (seen.has(file) || loaded.length >= MAX_SKILL_FILES) continue;
      seen.add(file);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;
        const content = await fs.readFile(file, "utf8");
        loaded.push({
          name: frontmatterValue(content, "name") || path.basename(path.dirname(file)),
          description: frontmatterValue(content, "description"),
          path: path.relative(config.workspace, file).split(path.sep).join("/"),
          content
        });
      } catch {}
    }
  }
  const selected = selectRelevantSkills(task, loaded, 3);
  if (!selected.length) return "";
  let context = "";
  for (const skill of selected) {
    const block = "### " + skill.name + "\nSource: " + skill.path + "\nDescription: " + (skill.description || "No description provided.") + "\n\n" + skill.content + "\n";
    if (context.length + block.length > MAX_SKILL_CONTEXT_CHARS) {
      const remaining = MAX_SKILL_CONTEXT_CHARS - context.length;
      if (remaining > 500) context += block.slice(0, remaining) + "\n[Skill context truncated at the configured limit.]\n";
      break;
    }
    context += block + "\n";
  }
  return context;
}

function normalizeInstallRequest(args) {
  let source = String(args.source || "").trim();
  let skillName = String(args.skill_name || "").trim();
  let reaSetup = false;
  if (/^(?:npx\s+)?rea-agents(?:@latest)?\s+setup$/i.test(source)) {
    source = "morluto/rea";
    skillName = skillName || "reverse-engineer-anything";
    reaSetup = true;
  }
  if (!source || source.length > 500 || /[\r\n;&|<>$]/.test(source) || source.includes(String.fromCharCode(96)) || source.startsWith("-")) {
    throw new Error("Provide a GitHub repository/source without shell syntax.");
  }
  const githubShorthand = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
  let githubUrl = false;
  try {
    const parsed = new URL(source);
    githubUrl = parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com" &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {}
  const skillsUrl = /^https:\/\/skills\.sh\/p\/[A-Za-z0-9_-]+\/?$/.test(source);
  if (!githubShorthand && !githubUrl && !skillsUrl) {
    throw new Error("Skill source must be a GitHub owner/repository, a GitHub HTTPS URL, or a skills.sh pack URL.");
  }
  if (!skillName && !reaSetup) {
    throw new Error("Specify the skill name from the repository. Use the repository's skill list to find it.");
  }
  if (skillName && (skillName.length > 100 || /[\r\n\0]/.test(skillName) || skillName.startsWith("-"))) {
    throw new Error("Invalid skill name.");
  }
  return { source, skillName, reaSetup };
}

export async function installSkill(args) {
  const request = normalizeInstallRequest(args);
  const prompt = request.reaSetup
    ? "Install REA's reverse-engineer-anything skill into Nabees Agent's skill library? This adds workflow instructions only; it does not configure REA MCP tools for this custom Telegram agent."
    : "Install skill \"" + request.skillName + "\" from \"" + request.source + "\" into the agent workspace? Downloaded skill instructions will be read when relevant tasks arrive.";
  const choice = await requestUserChoice({
    prompt,
    choices: ["Approve skill installation", "Cancel"],
    timeout_seconds: 300
  });
  if (choice.timed_out || choice.selected !== "Approve skill installation") {
    return { installed: false, approval: choice.timed_out ? "expired" : "rejected", source: request.source, skill_name: request.skillName || null };
  }

  const argsList = ["--yes", "skills", "add", request.source];
  if (request.skillName) argsList.push("--skill", request.skillName);
  argsList.push("--agent", "codex", "--copy", "--yes");

  const childEnv = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    CI: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  for (const key of ["TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key]) childEnv[key] = process.env[key];

  const result = await new Promise((resolve, reject) => {
    const child = spawn("npx", argsList, {
      cwd: config.workspace,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    const collect = (target, chunk) => {
      const current = target === "stdout" ? stdout : stderr;
      const next = current + chunk.toString();
      if (target === "stdout") stdout = next.slice(-12_000);
      else stderr = next.slice(-12_000);
    };
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.on("error", error => { clearTimeout(timer); reject(new Error("Could not start npx for skill installation: " + error.message)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
  if (result.exitCode !== 0) {
    throw new Error("Skill installation failed (exit " + (result.exitCode ?? "unknown") + "). " + String(result.stderr || result.stdout || "").slice(-2500));
  }

  const skills = await loadRelevantSkills("skill " + request.skillName + " " + request.source);
  return {
    installed: true,
    source: request.source,
    skill_name: request.skillName,
    destination: path.join(".agents", "skills", request.skillName || "(repository skills)").split(path.sep).join("/"),
    output: String(result.stdout || "").slice(-3000),
    verified_relevant_skill_loaded: Boolean(skills),
    note: request.reaSetup
      ? "The REA skill instructions are installed for Nabees Agent. REA MCP analysis tools are not connected by this skill-only install."
      : "Relevant SKILL.md instructions are loaded automatically into future tasks."
  };
}
