import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { requestUserChoice } from "./interaction.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT = path.join(SOURCE_ROOT, ".agent-state", "self-upgrades");
const ALLOWED = /^(?:src\/[a-zA-Z0-9_./-]+\.js|agents\/[a-zA-Z0-9_-]+\.md|agent\.md\/[a-zA-Z0-9_./-]+\.md|test\/[a-zA-Z0-9_./-]+\.js|README\.md)$/;
const BLOCKED = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.agent-state|node_modules|whatsapp-auth|credentials?|secrets?)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

function run(executable, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const childEnv = { PATH: process.env.PATH || "", CI: "1", npm_config_audit: "false", npm_config_fund: "false" };
    for (const key of ["HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) if (process.env[key]) childEnv[key] = process.env[key];
    const child = spawn(executable, args, { cwd, env: childEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { if (stdout.length < 18000) stdout += chunk.toString().slice(0, 18000 - stdout.length); });
    child.stderr.on("data", chunk => { if (stderr.length < 18000) stderr += chunk.toString().slice(0, 18000 - stderr.length); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function safeRelative(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.includes("\0")) throw new Error("Invalid source path.");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || !ALLOWED.test(normalized) || BLOCKED.test(normalized)) {
    throw new Error("Self-upgrades may only touch approved source, profile, documentation and test files. Dependencies, secrets, runtime state and deployment files are excluded.");
  }
  return normalized;
}

export const selfMaintenanceToolDefinitions = [
  { type: "function", function: { name: "inspect_self", description: "Read-only inspection of Nabees's own source tree and selected source files. Use this to understand current implementation and identify concrete improvements to Nabees's interaction, memory, task management, tools and reliability. Never modify files with this tool.", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, maxItems: 12 } }, additionalProperties: false } } },
  { type: "function", function: { name: "self_upgrade", description: "Propose a specific self-improvement with its rationale, benefits, risks, exact source paths and complete replacement file contents. This tool first asks the owner to approve staging the change, tests it in an isolated Git worktree, then separately asks before applying the verified files to the live source checkout. It never silently modifies source, dependencies, secrets or deployment configuration. Do not use ordinary write_file for Nabees's own source.", parameters: { type: "object", properties: { title: { type: "string", minLength: 4, maxLength: 120 }, rationale: { type: "string", minLength: 20, maxLength: 2000 }, benefits: { type: "string", minLength: 10, maxLength: 1200 }, risks: { type: "string", minLength: 5, maxLength: 1200 }, files: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } }, required: ["title", "rationale", "benefits", "risks", "files"], additionalProperties: false } } }
];

export async function executeSelfMaintenanceTool(name, args) {
  if (name === "inspect_self") {
    const requested = Array.isArray(args.paths) && args.paths.length
      ? args.paths.map(safeRelative)
      : ["src/agent.js", "src/tools.js", "src/shared-state.js", "src/telegram.js", "src/whatsapp.js", "src/approvals.js", "package.json"];
    const files = [];
    for (const rel of [...new Set(requested)]) {
      const full = path.join(SOURCE_ROOT, rel);
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > 160000) { files.push({ path: rel, skipped: "File exceeds inspection limit." }); continue; }
      files.push({ path: rel, content: await fs.readFile(full, "utf8") });
    }
    const tree = await run("git", ["ls-files", "src", "agents", "agent.md", "test"], SOURCE_ROOT, 20000);
    return { root: SOURCE_ROOT, trackedFiles: tree.stdout.split("\n").filter(Boolean).slice(0, 250), files };
  }

  if (name !== "self_upgrade") throw new Error("Unknown self-maintenance operation.");
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > 12) throw new Error("Provide 1–12 complete source files.");
  const files = args.files.map(item => ({ path: safeRelative(item.path), content: String(item.content ?? "") }));
  if (new Set(files.map(item => item.path)).size !== files.length) throw new Error("Each source path must appear only once.");
  if (files.some(item => Buffer.byteLength(item.content, "utf8") > 180000)) throw new Error("A proposed source file exceeds the 180 KB limit.");

  const first = await requestUserChoice({
    prompt: [
      "NABEES SELF-UPGRADE — STAGING APPROVAL",
      args.title,
      "",
      "Why: " + args.rationale,
      "",
      "Expected benefit: " + args.benefits,
      "",
      "Risks: " + args.risks,
      "",
      "Files to stage and test: " + files.map(item => item.path).join(", "),
      "",
      "Approval here only permits an isolated test copy. The running source will not be changed yet."
    ].join("\n"),
    choices: ["Approve staging", "Reject upgrade"],
    timeout_seconds: 300
  });
  if (first.timed_out || first.selected !== "Approve staging") return { staged: false, status: first.timed_out ? "approval_expired" : "rejected", message: "No source files were changed." };

  const status = await run("git", ["status", "--porcelain"], SOURCE_ROOT, 20000);
  if (status.code !== 0) throw new Error("Cannot inspect the source Git checkout: " + status.stderr.slice(0, 1000));
  if (status.stdout.trim()) return { staged: false, status: "source_checkout_dirty", message: "The source checkout has existing uncommitted changes. Commit or safely set them aside before self-upgrade staging; nothing was changed." };

  const id = Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
  const upgradeRoot = path.join(STATE_ROOT, id);
  const worktree = path.join(os.tmpdir(), "nabees-self-upgrade-" + id);
  await fs.mkdir(upgradeRoot, { recursive: true, mode: 0o700 });
  const added = await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], SOURCE_ROOT, 60000);
  if (added.code !== 0) throw new Error("Could not create isolated upgrade worktree: " + added.stderr.slice(0, 1500));

  try {
    try { await fs.access(path.join(SOURCE_ROOT, "node_modules")); await fs.symlink(path.join(SOURCE_ROOT, "node_modules"), path.join(worktree, "node_modules"), "junction"); } catch (error) { if (error.code !== "ENOENT" && error.code !== "EACCES") throw error; }
    for (const item of files) {
      const target = path.join(worktree, item.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, item.content, { encoding: "utf8", mode: 0o600 });
    }
    const check = await run("npm", ["run", "check"], worktree, 180000);
    const tests = check.code === 0 ? await run("npm", ["test"], worktree, 180000) : { code: null, stdout: "", stderr: "Skipped because npm run check failed." };
    const testReport = { syntax: { exitCode: check.code, output: (check.stdout + "\n" + check.stderr).slice(-9000) }, tests: { exitCode: tests.code, output: (tests.stdout + "\n" + tests.stderr).slice(-9000) } };
    await fs.writeFile(path.join(upgradeRoot, "report.json"), JSON.stringify({ id, title: args.title, rationale: args.rationale, benefits: args.benefits, risks: args.risks, files: files.map(item => item.path), testReport, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

    if (check.code !== 0 || tests.code !== 0) {
      return { staged: true, applied: false, status: "tests_failed", id, worktree, testReport, message: "The isolated upgrade failed validation. The live source remains untouched. Review the report and fix the proposal before trying again." };
    }

    const second = await requestUserChoice({
      prompt: [
        "NABEES SELF-UPGRADE — APPLY APPROVAL",
        args.title,
        "",
        "The isolated copy passed npm run check and npm test.",
        "Files: " + files.map(item => item.path).join(", "),
        "",
        "Why: " + args.rationale,
        "Benefit: " + args.benefits,
        "Risks: " + args.risks,
        "",
        "Apply these verified files to the source checkout now? The current running process will keep serving from its already-loaded code; restart is a separate step and is not performed here."
      ].join("\n"),
      choices: ["Apply verified upgrade", "Keep staged only"],
      timeout_seconds: 300
    });
    if (second.timed_out || second.selected !== "Apply verified upgrade") {
      return { staged: true, applied: false, status: second.timed_out ? "apply_approval_expired" : "kept_staged", id, worktree, testReport, message: "The verified upgrade remains isolated. The running source was not modified." };
    }

    const current = await run("git", ["status", "--porcelain"], SOURCE_ROOT, 20000);
    if (current.code !== 0 || current.stdout.trim()) return { staged: true, applied: false, status: "source_checkout_changed", id, worktree, testReport, message: "The source checkout changed after testing. Nothing was applied; inspect and reconcile the changes first." };

    const backups = [];
    try {
      for (const item of files) {
        const target = path.join(SOURCE_ROOT, item.path);
        let previous = null;
        try {
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing to replace a non-regular source path: " + item.path);
          previous = await fs.readFile(target);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        backups.push({ target, previous });
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = target + ".nabees-upgrade-" + id + ".tmp";
        await fs.writeFile(temporary, item.content, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
      }
    } catch (error) {
      for (const backup of backups.reverse()) {
        try {
          if (backup.previous === null) await fs.rm(backup.target, { force: true });
          else await fs.writeFile(backup.target, backup.previous, { mode: 0o600 });
        } catch {}
      }
      throw new Error("Upgrade application failed and rollback was attempted: " + error.message);
    }
    return { staged: true, applied: true, status: "applied_restart_required", id, files: files.map(item => item.path), testReport, message: "Verified source files were applied. The current process was not restarted; arrange a controlled restart to load the new code." };
  } finally {
    // Keep the isolated worktree and report for review/rollback; the worktree lives outside the source checkout.
  }
}
