import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import {
  activeTasks, appendConversationTurns, getConversationHistory, listTaskRecords,
  getTaskRecord, registerTaskSession, updateTaskProgress, finishTaskSession, cancelTask
} from "./shared-state.js";
import { setWhatsAppSocket, getWhatsAppSocket, getWhatsAppConnectionState, setWhatsAppConnectionState, setWhatsAppOwnerJid } from "./whatsapp/socket-state.js";

const authDir = path.join(config.stateDir, "whatsapp-auth");
const ownerFile = path.join(config.stateDir, "whatsapp-owner.json");
let baileys = null;
let connectPromise = null;
let reconnectTimer = null;
let stopping = false;
let ownerJid = "";
let accountRegistered = false;
let lastDisconnectReason = "";
const chatAccessFile = path.join(config.stateDir, "whatsapp-chat-access.json");
let chatAccess = { chats: {} };
const outboundMessageIds = new Set();
async function loadChatAccess() {
  try { const saved=JSON.parse(await fs.readFile(chatAccessFile,"utf8")); if(saved?.chats && typeof saved.chats==="object") chatAccess=saved; }
  catch(error) { if(error.code!=="ENOENT") console.error("[Nabees WhatsApp] Chat settings load failed:",error.message); }
}
async function saveChatAccess() {
  await fs.mkdir(config.stateDir,{recursive:true,mode:0o700});
  const tmp=chatAccessFile+".tmp";
  await fs.writeFile(tmp,JSON.stringify(chatAccess,null,2),{mode:0o600});
  await fs.rename(tmp,chatAccessFile);
}
function chatSettings(jid) { return chatAccess.chats[jid] || {enabled:false,mode:"public"}; }
function ownerMessage(message) {
  return Boolean(message?.key?.fromMe || (ownerJid && (message?.key?.participant===ownerJid || message?.key?.remoteJid===ownerJid)));
}
function contextInfo(message) {
  const m=message?.message||{};
  return m.extendedTextMessage?.contextInfo||m.imageMessage?.contextInfo||m.videoMessage?.contextInfo||
    m.documentMessage?.contextInfo||m.audioMessage?.contextInfo||m.stickerMessage?.contextInfo||null;
}
function publicTrigger(message,text) {
  const quotedId=contextInfo(message)?.stanzaId;
  return Boolean((quotedId && outboundMessageIds.has(quotedId)) || /(^|[^a-z0-9])nabees([^a-z0-9]|$)/i.test(text));
}
function isOwnerDirectChat(jid) { return jid===ownerJid; }
function ownerRuleRequest(text) {
  return text.match(/^(?:hey\s+)?nabees[, ]+(?:remember|save|set)\s+(?:this\s+)?(?:whatsapp\s+)?rule\s*:\s*([\s\S]{5,1000})$/i)?.[1]?.trim() || "";
}


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
  setWhatsAppOwnerJid(ownerJid);
  return ownerJid;
}

async function saveOwner(number) {
  ownerJid = toJid(number);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = ownerFile + ".tmp";
  await fs.writeFile(temporary, JSON.stringify({ ownerJid, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.rename(temporary, ownerFile);
  setWhatsAppOwnerJid(ownerJid);
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
    accountRegistered = Boolean(state.creds?.registered);
    // Match Batman MDX's working connection sequence: negotiate the current
    // WhatsApp Web version and let Baileys use its default browser identity.
    const { version } = await lib.fetchLatestBaileysVersion();
    const makeWASocket = lib.default;
    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined
    });
    setWhatsAppSocket(sock);
    setWhatsAppConnectionState("connecting");
    sock.ev.on("creds.update", async () => {
      accountRegistered = Boolean(state.creds?.registered);
      await saveCreds();
    });
    sock.ev.on("connection.update", update => {
      if (update.connection === "open") {
        lastDisconnectReason = "";
        setWhatsAppConnectionState("connected");
        console.log("[Nabees WhatsApp] Connected.");
      } else if (update.connection === "close") {
        setWhatsAppConnectionState("disconnected");
        setWhatsAppSocket(null);
        connectPromise = null;
        const disconnectError = update.lastDisconnect?.error;
        const statusCode = disconnectError?.output?.statusCode;
        const loggedOutCode = Number(lib.DisconnectReason?.loggedOut);
        const isLoggedOut = Number.isFinite(loggedOutCode) && statusCode === loggedOutCode;
        const diagnostic = [
          disconnectError?.message || "No disconnect message",
          statusCode != null ? `status=${statusCode}` : "status=unknown",
          disconnectError?.data?.reason ? `reason=${disconnectError.data.reason}` : "",
          disconnectError?.data?.location ? `location=${disconnectError.data.location}` : ""
        ].filter(Boolean).join(" | ");
        lastDisconnectReason = diagnostic;
        console.warn("[Nabees WhatsApp] Connection closed:", diagnostic);
        if (!stopping && !isLoggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            connectPromise = null;
            void connectSocket().catch(error => console.error("[Nabees WhatsApp] Reconnect failed:", error.message));
          }, 3000);
          reconnectTimer.unref?.();
        } else if (isLoggedOut) {
          console.warn("[Nabees WhatsApp] WhatsApp explicitly reported a logged-out session. Run /pair again.");
        }
      }
    });
    sock.ev.on("messages.upsert", event => {
      if (event.type !== "notify" && event.type !== "append") return;
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

async function sendText(jid, text, quotedMessage = null) {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected.");
  const source = String(text || "");
  for (let offset = 0; offset < source.length; offset += 3500) {
    const sent=await sock.sendMessage(jid,{text:source.slice(offset,offset+3500)},quotedMessage?{quoted:quotedMessage}:undefined);
    if(sent?.key?.id){outboundMessageIds.add(sent.key.id);if(outboundMessageIds.size>500)outboundMessageIds.delete(outboundMessageIds.values().next().value);}
  }
}

async function runWhatsAppTask(jid, task, quotedMessage = null) {
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
    history: jid===ownerJid ? getConversationHistory(30) : [],
    abortController: new AbortController(),
    cancelRequested: false
  };
  await registerTaskSession(session);
  await sendText(jid, "Nabees is on it. Task ID: " + session.id + "\nUse /view " + session.id + " to follow progress.", quotedMessage);
  try {
    const result = await runAgent(task, {
      profile: session.profile,
      history: session.history,
      signal: session.abortController.signal,
      onProgress: event => {
        if (event.message) void updateTaskProgress(session.id, event.message);
      }
    });
    if(jid===ownerJid) await appendConversationTurns(task, result.answer || "", "whatsapp");
    const status = session.cancelRequested || result.status === "cancelled" ? "cancelled" :
      result.status === "failed" ? "failed" :
      result.status === "step_limit" ? "paused" : "completed";
    await finishTaskSession(session.id, status, result.answer || "");
    await sendText(jid, (result.answer || "Task finished without a response.") + "\n\nTask ID: " + session.id, quotedMessage);
  } catch (error) {
    await finishTaskSession(session.id, "failed", "Task failed.");
    console.error("[Nabees WhatsApp] Agent task failed:", error.message);
    await sendText(jid, "Sir, I hit an execution issue. The task checkpoint is saved; you can continue from Telegram or WhatsApp.");
  }
}

async function handleIncomingMessage(message) {
  if (!ownerJid || !message?.key) return;
  const jid=message.key.remoteJid;
  if(!jid || jid==="status@broadcast" || jid.endsWith("@newsletter")) return;
  const text=extractText(message);
  const isOwner=ownerMessage(message);
  const ownerDm=isOwnerDirectChat(jid);
  if(message.key.fromMe && outboundMessageIds.has(message.key.id)) return;
  const match=text.match(/^\/(agent|mode|help|start|status|tasks|view|taskstatus|kill|killtask|task)(?:\s+([\s\S]*))?$/i);
  const cmd=match?.[1]?.toLowerCase(), arg=match?.[2]?.trim()||"";

  if(isOwner) {
    const requestedRule=ownerRuleRequest(text);
    if(requestedRule) {
      if(jid===ownerJid) chatAccess.globalRules=[...(chatAccess.globalRules||[]),requestedRule].slice(-30);
      else {
        chatAccess.chats[jid]={...chatSettings(jid),rules:[...(chatSettings(jid).rules||[]),requestedRule].slice(-20)};
      }
      await saveChatAccess();
      return sendText(jid,"Saved. I'll apply that WhatsApp rule "+(jid===ownerJid?"across your WhatsApp chats.":"in this chat."));
    }
    if(/^\/rules$/i.test(text)) {
      const rules=[...(chatAccess.globalRules||[]),...(chatSettings(jid).rules||[])];
      return sendText(jid,rules.length?"Current WhatsApp rules:\n"+rules.map((rule,i)=>(i+1)+". "+rule).join("\n"):"No custom WhatsApp rules saved yet. Say: Nabees, remember WhatsApp rule: ...");
    }
  }

  if(isOwner && cmd==="agent") {
    if(arg.toLowerCase()==="on") {
      chatAccess.chats[jid]={...chatSettings(jid),enabled:true}; await saveChatAccess();
      return sendText(jid,"Nabees is enabled in this chat. Mode: "+chatAccess.chats[jid].mode+". Use /mode public or /mode private. /agent off disables it.");
    }
    if(arg.toLowerCase()==="off") {
      chatAccess.chats[jid]={...chatSettings(jid),enabled:false}; await saveChatAccess();
      return sendText(jid,"Nabees is disabled in this chat. New messages here will not be processed.");
    }
    return sendText(jid,"Use /agent on or /agent off.");
  }
  if(isOwner && cmd==="mode") {
    const mode=arg.toLowerCase();
    if(!["public","private"].includes(mode)) return sendText(jid,"Use /mode public or /mode private.");
    if(!chatSettings(jid).enabled) return sendText(jid,"Enable Nabees here first with /agent on.");
    chatAccess.chats[jid]={...chatSettings(jid),mode}; await saveChatAccess();
    return sendText(jid,"Nabees mode for this chat is now "+mode+".");
  }

  if(isOwner && cmd && (chatSettings(jid).enabled || ownerDm)) {
    if(cmd==="help"||cmd==="start") return sendText(jid,"I'm here. Just message me normally in this private chat. In other chats use /agent on, then /mode public or /mode private. /tasks; /view <id>; /kill <id>; /task <request>.");
    if(cmd==="status"||cmd==="tasks") {
      const running=listTaskRecords({includeCompleted:false});
      return sendText(jid,running.length?"**"+running.length+" task(s) running**\n\n"+running.map(x=>x.id+" — "+x.task.slice(0,180)).join("\n\n"):"Nabees is idle.");
    }
    if(cmd==="view"||cmd==="taskstatus") return sendText(jid,arg?taskSummary(getTaskRecord(arg)):"Use /view <task-id>.");
    if(cmd==="kill"||cmd==="killtask") { if(!arg)return sendText(jid,"Use /kill <task-id>."); const ok=cancelTask(arg); return sendText(jid,ok?"Stop requested for "+arg+".":"No running task found."); }
    if(cmd==="task") return arg?runWhatsAppTask(jid,arg):sendText(jid,"Use /task <request>.");
  }

  if(!text) return;
  // The owner's one-to-one chat is the natural control room: no wake word or
  // activation command is needed there.
  if(ownerDm && cmd) return;
  const settings=chatSettings(jid);
  if(!ownerDm && !settings.enabled) return;
  if(!ownerDm && settings.mode==="public" && !publicTrigger(message,text)) return;
  // In groups, the owner can also address Nabees by replying to one of its
  // tracked messages or explicitly mentioning Nabees.
  const sender=message.key.participant||jid;
  const prompt=[
    "WhatsApp "+(jid.endsWith("@g.us")?"group":"private chat"),
    "Sender: "+sender,
    "Mode: "+(ownerDm?"owner-private":settings.mode),
    "WhatsApp safety and privacy rules:",
    "Never disclose passwords, API keys, authentication codes, private credentials, private personal information, confidential business information, or secrets in a group. If asked for something sensitive in a group, politely say it can only be handled in the owner's private chat. Do not repeat the sensitive content in the group.",
    "Do not assume every group message is addressed to you. Only respond when the owner-private chat is active, or in other chats when the activation mode permits it.",
    "Owner-defined WhatsApp rules:",
    ...(chatAccess.globalRules||[]),
    ...(settings.rules||[]),
    "Reply naturally to this message. Do not reveal internal identifiers.",
    "Message:",
    text
  ].join("\n");
  return runWhatsAppTask(jid,prompt,message);
}

export async function pairWhatsApp(phoneNumber) {
  const linkedNumber = normalizeNumber(phoneNumber);
  if (accountRegistered) {
    throw new Error("A WhatsApp session is already registered. To link a different number, log out the existing linked device first.");
  }

  stopping = false;
  clearTimeout(reconnectTimer);
  const sock = await connectSocket();
  // Batman-MDX also waits before requesting the code; give Baileys time to finish its initial WebSocket handshake.
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (getWhatsAppSocket() !== sock || getWhatsAppConnectionState() === "disconnected") {
    throw new Error(lastDisconnectReason || "WhatsApp disconnected before the pairing code could be requested. Check outbound WebSocket access and try again.");
  }

  let code;
  try {
    code = await sock.requestPairingCode(linkedNumber, "NABEESAG");
  } catch (error) {
    const reason = lastDisconnectReason ? ` WhatsApp disconnect reason: ${lastDisconnectReason}` : "";
    throw new Error(`Baileys could not request a pairing code: ${error?.message || String(error)}.${reason}`);
  }

  await saveOwner(linkedNumber);
  return {
    code: String(code).match(/.{1,4}/g)?.join("-") || String(code),
    linkedAccount: linkedNumber,
    controller: ownerJid
  };
}

export async function startWhatsAppController() {
  if (config.whatsappEnabled === false) return { enabled: false };
  await loadOwner();
  await loadChatAccess();
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
