import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const historyPath = path.join(config.stateDir, "conversation-history.json");
const tasksPath = path.join(config.stateDir, "tasks.json");
let conversationHistory = [];
export const activeTasks = new Map();
const taskRecords = new Map();

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

export async function loadSharedState() {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath, "utf8"));
    conversationHistory = Array.isArray(parsed)
      ? parsed.filter(item => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string").slice(-80)
      : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[Nabees] Shared memory could not be loaded:", error.message);
    conversationHistory = [];
  }
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath, "utf8"));
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (!item || typeof item.id !== "string") continue;
      const restored = { ...item, status: item.status === "running" ? "interrupted" : item.status };
      taskRecords.set(restored.id, restored);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[Nabees] Task history could not be loaded:", error.message);
  }
  await persistTasks();
}

export function getConversationHistory(limit = 40) {
  return conversationHistory.slice(-Math.max(1, limit)).map(item => ({ ...item }));
}

export async function appendConversationTurns(userText, assistantText, source = "agent") {
  conversationHistory = [
    ...conversationHistory,
    { role: "user", content: String(userText || ""), source, timestamp: new Date().toISOString() },
    { role: "assistant", content: String(assistantText || ""), source, timestamp: new Date().toISOString() }
  ].slice(-80);
  await atomicWrite(historyPath, conversationHistory);
  return getConversationHistory();
}

async function persistTasks() {
  const records = [...taskRecords.values()].slice(-100);
  await atomicWrite(tasksPath, records);
}

export async function registerTaskSession(session) {
  const record = {
    id: session.id || randomUUID().slice(0, 8),
    task: String(session.task || ""),
    profile: session.profile || "general",
    source: session.source || "unknown",
    startedAt: session.startedAt || new Date().toISOString(),
    status: "running",
    progress: ["Task received."],
    updatedAt: new Date().toISOString()
  };
  session.id = record.id;
  taskRecords.set(record.id, record);
  activeTasks.set(record.id, session);
  await persistTasks();
  return record;
}

export async function updateTaskProgress(id, message, status) {
  const record = taskRecords.get(String(id));
  if (!record) return null;
  if (message) {
    record.progress.push(String(message).slice(0, 500));
    record.progress = record.progress.slice(-60);
  }
  if (status) record.status = status;
  record.updatedAt = new Date().toISOString();
  await persistTasks();
  return { ...record, progress: [...record.progress] };
}

export async function finishTaskSession(id, status = "completed", answer = "") {
  const key = String(id);
  const record = taskRecords.get(key);
  if (record) {
    record.status = status;
    record.answer = String(answer || "").slice(0, 8000);
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    await persistTasks();
  }
  activeTasks.delete(key);
  return record ? { ...record, progress: [...record.progress] } : null;
}

export function listTaskRecords({ includeCompleted = true } = {}) {
  const records = [...taskRecords.values()];
  return (includeCompleted ? records : records.filter(item => item.status === "running"))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map(item => ({ ...item, progress: [...(item.progress || [])] }));
}

export function getTaskRecord(id) {
  const record = taskRecords.get(String(id));
  return record ? { ...record, progress: [...(record.progress || [])] } : null;
}

export function cancelTask(id) {
  const session = activeTasks.get(String(id));
  if (!session) return false;
  session.cancelRequested = true;
  session.abortController?.abort();
  return true;
}
