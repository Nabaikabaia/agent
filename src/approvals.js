import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

const storePath = path.join(config.stateDir, "package-approvals.json");
const pending = new Map();
let notifier = null;
let initialized = false;

async function readStore() {
  await fs.mkdir(config.stateDir, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not read package approval store: ${error.message}`);
  }
}

async function writeStore(records) {
  await fs.mkdir(config.stateDir, { recursive: true });
  const temporaryPath = `${storePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(records.slice(-200), null, 2), { mode: 0o600 });
  await fs.rename(temporaryPath, storePath);
}

export async function initializePackageApprovals() {
  const records = await readStore();
  let changed = false;
  // A JS task cannot safely resume after a process restart. Preserve its audit record,
  // but never silently resume or approve an old request.
  for (const record of records) {
    if (record.status === "pending") {
      record.status = "interrupted";
      record.updatedAt = new Date().toISOString();
      record.note = "Agent restarted while awaiting a decision; submit the task again to create a new request.";
      changed = true;
    }
  }
  if (changed) await writeStore(records);
  initialized = true;
}

export function registerPackageApprovalNotifier(send) {
  if (typeof send !== "function") throw new TypeError("Package approval notifier must be a function.");
  notifier = send;
}

export async function requestPackageInstallApproval({ packageName, manager, dev = false }) {
  if (!initialized) await initializePackageApprovals();
  if (!notifier) throw new Error("Package approval buttons are not connected to Telegram.");
  if (typeof packageName !== "string" || !packageName.trim()) throw new Error("Package name is required.");

  const records = await readStore();
  const id = randomBytes(6).toString("hex");
  const record = {
    id,
    type: "package_install",
    package: packageName,
    manager,
    dev: Boolean(dev),
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  records.push(record);
  await writeStore(records);

  return await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(async () => {
      pending.delete(id);
      try {
        const current = await readStore();
        const item = current.find((entry) => entry.id === id);
        if (item?.status === "pending") {
          item.status = "expired";
          item.updatedAt = new Date().toISOString();
          await writeStore(current);
        }
      } catch (error) {
        console.error("Could not persist expired package approval:", error.message);
      }
      resolve({ approved: false, status: "expired", message: "Approval request expired; package was not installed." });
    }, 5 * 60 * 1000);
    timeout.unref?.();

    pending.set(id, {
      resolve: async (decision) => {
        clearTimeout(timeout);
        pending.delete(id);
        resolve(decision);
      }
    });

    try {
      await notifier({
        id,
        text: [
          "**Package installation permission**",
          "",
          `Package: \`${packageName}\``,
          `Manager: ${manager}`,
          `Dependency type: ${dev ? "Development" : "Production"}`,
          "",
          "Install this dependency in the agent workspace?"
        ].join("\n")
      });
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(id);
      const current = await readStore();
      const item = current.find((entry) => entry.id === id);
      if (item?.status === "pending") {
        item.status = "delivery_failed";
        item.updatedAt = new Date().toISOString();
        await writeStore(current);
      }
      reject(error);
    }
  });
}

export async function decidePackageApproval(id, decision, actorId, ownerId) {
  if (String(actorId ?? "") !== String(ownerId ?? "")) {
    return { ok: false, message: "Only the configured owner can decide this request." };
  }
  if (!/^[a-f0-9]{12}$/.test(String(id)) || !["approve", "reject"].includes(decision)) {
    return { ok: false, message: "Invalid approval button." };
  }

  const records = await readStore();
  const record = records.find((entry) => entry.id === id);
  if (!record || record.status !== "pending") {
    return { ok: false, message: "This request is no longer pending. No package was installed." };
  }

  record.status = decision === "approve" ? "approved" : "rejected";
  record.updatedAt = new Date().toISOString();
  record.decidedBy = String(actorId);
  await writeStore(records);

  const waiting = pending.get(id);
  const result = decision === "approve"
    ? { approved: true, status: "approved", package: record.package, manager: record.manager, dev: record.dev }
    : { approved: false, status: "rejected", message: "The owner rejected the package installation; package was not installed." };

  if (waiting) {
    await waiting.resolve(result);
  } else if (decision === "approve") {
    // A persisted button tap after restart must never authorize an action that is no longer waiting.
    record.status = "interrupted";
    record.updatedAt = new Date().toISOString();
    record.note = "Approval arrived without a live waiting task; package was not installed.";
    await writeStore(records);
    return { ok: false, message: "The task is no longer waiting. No package was installed." };
  }

  return { ok: true, status: record.status, package: record.package };
}

export async function listPackageApprovals() {
  return (await readStore()).slice(-50).reverse();
}
