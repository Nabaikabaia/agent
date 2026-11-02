import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import {
  activeTasks, appendConversationTurns, getConversationHistory, listTaskRecords,
  getTaskRecord, registerTaskSession, updateTaskProgress, finishTaskSession, cancelTask
} from "./shared-state.js";
import { setWhatsAppSocket, getWhatsAppSocket, setWhatsAppConnectionState } from "./whatsapp/socket-state.js";

const authDir = path.join(config.stateDir, "whatsapp-auth");
const ownerFile = path.join(config.stateDir, "whatsapp-owner.json");
let baileys = null;
let connectPromise = null;
let reconnectTimer = null;
let stopping = false;
let ownerJid = "";

function normalizeNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("Use an international phone number with country code, digits only.");
  return digits;
}

function toJid(value) {
  return normalizeNumber(value) + "@s.whatsapp.net";
}

async function loadOwner() {
  try {
    const saved = JSON.parse(await fs.readFile(ownerFile, "utf8"));
    if (typeof saved.ownerJid === "string" && /^\d{8,15}@s\.whatsapp\.net$/.test(saved.ownerJid)) ownerJid = saved.ownerJid;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[Nabees WhatsApp] Owner configuration could not be read:", error.message);
  }
  if (!ownerJid && config.whatsappOwnerJid) {
    try { ownerJid = toJid(config.whatsappOwnerJid); } catch {}
  }
  return ownerJid;
}

async function saveOwner(number) {
  ownerJid = toJid(number);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = ownerFile + ".tmp";
  await fs.writeFile(temporary, JSON.stringify({ ownerJid, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.rename(temporary, ownerFile);
}

async function loadBaileys() {
  if (!baileys) baileys = await import("@whiskeysockets/baileys");
  return baileys;
}

async function connectSocket() {
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const lib = await loadBaileys();
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await lib.useMultiFileAuthState(authDir);
    const makeWASocket = lib.default;
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: lib.Browsers?.ubuntu ? lib.Browsers.ubuntu("Nabees Agent") : undefined,
      getMessage: async () => undefined
    });
    setWhatsAppSocket(sock);
    setWhatsAppConnectionState("connecting");
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", update => {
      if (update.connection === "open") {
        setWhatsAppConnectionState("connected");
        console.log("[Nabees WhatsApp] Connected.");
      } else if (update.connection === "close") {
        setWhatsAppConnectionState("disconnected");
        setWhatsAppSocket(null);
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        if (!stopping && statusCode !== lib.DisconnectReason?.loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            connectPromise = null;
            void connectSocket().catch(error => console.error("[Nabees WhatsApp] Reconnect failed:", error.message));
          }, 3000);
          reconnectTimer.unref?.();
        } else if (statusCode === lib.DisconnectReason?.loggedOut) {
          console.warn("[Nabees WhatsApp] Session logged out. Run /pair again.");
        }
      }
    });
    sock.ev.on("messages.upsert", event => {
      if (event.type !== "notify") return;
      for (const message of event.messages || []) {
        void handleIncomingMessage(message).catch(error => {
          console.error("[Nabees WhatsApp] Message handling failed:", error.message);
        });
      }
    });
    return sock;
  })();
  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    setWhatsAppConnectionState("error");
    throw error;
  }
}

function extractText(message) {
  const content = message.message || {};
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  ).trim();
}

function taskSummary(record) {
  if (!record) return "Task not found.";
  return [
    "**Task " + record.id + "** — " + record.status,
    "Source: " + (record.source || "unknown"),
    "Started: " + record.startedAt,
    "Request: " + String(record.task || "").slice(0, 500),
    "",
    "**Recent progress**",
    ...(record.progress || []).slice(-12).map(item => "• " + item),
    record.answer ? "\n**Result**\n" + record.answer.slice(0, 2500) : ""
  ].join("\n");
}

async function sendText(jid, text) {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected.");
  const source = String(text || "");
  for (let offset = 0; offset < source.length; offset += 3500) {
    await sock.sendMessage(jid, { text: source.slice(offset, offset + 3500) });
  }
}

async function runWhatsAppTask(jid, task) {
  if (activeTasks.size >= 4) {
    await sendText(jid, "Nabees is already running four tasks. Use /tasks to inspect them or wait for one to finish.");
    return;
  }
  const session = {
    id: Math.random().toString(36).slice(2, 10),
    task,
    profile: "general",
    source: "whatsapp",
    startedAt: new Date().toISOString(),
    history: getConversationHistory(30),
    abortController: new AbortController(),
    cancelRequested: false
  };
  await registerTaskSession(session);
  await sendText(jid, "Nabees is on it. Task ID: " + session.id + "\nUse /view " + session.id + " to follow progress.");
  try {
    const result = await runAgent(task, {
      profile: session.profile,
      history: session.history,
      signal: session.abortController.signal,
      onProgress: event => {
        if (event.message) void updateTaskProgress(session.id, event.message);
      }
    });
    await appendConversationTurns(task, result.answer || "", "whatsapp");
    const status = session.cancelRequested || result.status === "cancelled" ? "cancelled" :
      result.status === "failed" ? "failed" :
      result.status === "step_limit" ? "paused" : "completed";
    await finishTaskSession(session.id, status, result.answer || "");
    await sendText(jid, (result.answer || "Task finished without a response.") + "\n\nTask ID: " + session.id);
  } catch (error) {
    await finishTaskSession(session.id, "failed", "Task failed.");
    console.error("[Nabees WhatsApp] Agent task failed:", error.message);
    await sendText(jid, "Sir, I hit an execution issue. The task checkpoint is saved; you can continue from Telegram or WhatsApp.");
  }
}

async function handleIncomingMessage(message) {
  if (!ownerJid || !message?.key || message.key.fromMe) return;
  const remoteJid = message.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid !== ownerJid) return;
  const text = extractText(message.message || {});
  if (!text) return;
  const command = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  const name = command?.[1]?.toLowerCase();
  const argument = command?.[2]?.trim() || "";
  if (name === "help" || name === "start") {
    await sendText(remoteJid, "Nabees is connected on WhatsApp.\n\n/tasks — running and recent tasks\n/view <id> — live task progress\n/kill <id> — stop a task\n/task <request> — start a task\n/status — agent status\n\nYou can also chat naturally. Telegram and WhatsApp share memory and task sessions.");
    return;
  }
  if (name === "status" || name === "tasks") {
    const running = listTaskRecords({ includeCompleted: false });
    await sendText(remoteJid, running.length
      ? "**" + running.length + " task(s) running**\n\n" + running.map(item => item.id + " — " + item.task.slice(0, 180)).join("\n\n")
      : "Nabees is idle. No tasks are currently running.");
    return;
  }
  if (name === "view" || name === "taskstatus") {
    if (!argument) return sendText(remoteJid, "Use /view <task-id>.");
    return sendText(remoteJid, taskSummary(getTaskRecord(argument)));
  }
  if (name === "kill" || name === "killtask") {
    if (!argument) return sendText(remoteJid, "Use /kill <task-id>.");
    const stopped = cancelTask(argument);
    return sendText(remoteJid, stopped ? "Stop requested for task " + argument + "." : "No running task found with ID " + argument + ".");
  }
  if (name === "task") {
    if (!argument) return sendText(remoteJid, "Use /task <request>.");
    return runWhatsAppTask(remoteJid, argument);
  }
  if (name) return sendText(remoteJid, "Unknown command. Send /help for commands.");
  return runWhatsAppTask(remoteJid, text);
}

export async function pairWhatsApp(linkedAccountNumber, controllerNumber) {
  const linkedNumber = normalizeNumber(linkedAccountNumber);
  await saveOwner(controllerNumber);
  const sock = await connectSocket();
  if (sock.authState?.creds?.registered) throw new Error("A WhatsApp account is already paired. Log it out before pairing another account.");
  const code = await sock.requestPairingCode(linkedNumber);
  return { code: String(code).match(/.{1,4}/g)?.join("-") || String(code), linkedAccount: linkedNumber, controller: ownerJid };
}

export async function startWhatsAppController() {
  if (config.whatsappEnabled === false) return { enabled: false };
  await loadOwner();
  if (!ownerJid) {
    console.log("[Nabees WhatsApp] Not paired yet. Use /pair in Telegram to connect it.");
    return { enabled: true, paired: false };
  }
  try {
    const entries = await fs.readdir(authDir);
    if (!entries.length) return { enabled: true, paired: false };
  } catch {
    return { enabled: true, paired: false };
  }
  await connectSocket();
  return { enabled: true, paired: true };
}

export function stopWhatsAppController() {
  stopping = true;
  clearTimeout(reconnectTimer);
  const sock = getWhatsAppSocket();
  try { sock?.end?.(new Error("Nabees is shutting down.")); } catch {}
  setWhatsAppSocket(null);
  setWhatsAppConnectionState("disconnected");
}
