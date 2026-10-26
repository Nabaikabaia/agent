import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "./config.js";
import { runAgent } from "./agent.js";
import { listProfiles, loadProfile } from "./profiles.js";
import { registerChoicePromptSender, resolveUserChoice } from "./interaction.js";
import { initializePackageApprovals, registerPackageApprovalNotifier, decidePackageApproval } from "./approvals.js";

const API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 3900;
const CALLBACK_PREFIX = "na:";
let activeTask = null;
let selectedProfile = "general";
let conversationHistory = [];
let stopping = false;

function describeError(error) {
  const parts = [error?.message || String(error)];
  if (error?.cause?.message && error.cause.message !== error.message) parts.push(`cause: ${error.cause.message}`);
  if (error?.cause?.code) parts.push(`code: ${error.cause.code}`);
  return parts.join(" | ");
}

async function telegram(method, payload = {}) {
  let response;
  try {
    response = await fetch(`${API()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000)
    });
  } catch (error) {
    throw new Error(`Telegram ${method} network request failed: ${describeError(error)}`, { cause: error });
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram ${method} returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 180)}`);
  }
  if (!response.ok || !data.ok) {
    const error = new Error(data.description || `Telegram API HTTP ${response.status}`);
    error.telegramStatus = response.status;
    error.telegramDescription = data.description || "";
    throw error;
  }
  return data.result;
}

function inlineRichText(text) {
  const source = String(text ?? "");
  const tokens = source.split(/(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
  return tokens.map((token) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return { type: "bold", text: token.slice(2, -2) };
    }
    if (token.startsWith("*") && token.endsWith("*")) {
      return { type: "italic", text: token.slice(1, -1) };
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return { type: "code", text: token.slice(1, -1) };
    }
    return token;
  });
}

function markdownBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let codeLines = [];
  let codeLanguage = "";
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: inlineRichText(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      blocks.push({
        type: "list",
        items: listItems.map((item) => ({
          blocks: [{ type: "paragraph", text: inlineRichText(item) }]
        }))
      });
      listItems = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      if (!inCode) {
        inCode = true;
        codeLanguage = fence[1] || "";
        codeLines = [];
      } else {
        blocks.push({
          type: "pre",
          text: codeLines.join("\n"),
          ...(codeLanguage ? { language: codeLanguage } : {})
        });
        inCode = false;
        codeLanguage = "";
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        size: Math.min(6, Math.max(1, heading[1].length)),
        text: inlineRichText(heading[2])
      });
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "divider" });
      continue;
    }
    const list = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (list) {
      flushParagraph();
      listItems.push(list[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (inCode) {
    blocks.push({
      type: "pre",
      text: codeLines.join("\n"),
      ...(codeLanguage ? { language: codeLanguage } : {})
    });
  }
  flushParagraph();
  flushList();
  return blocks.length ? blocks : [{ type: "paragraph", text: " " }];
}

function richContent(text, buttons = []) {
  const blocks = markdownBlocks(text);
  if (buttons.length) {
    const regularRow = buttons.filter((button) => !button.separate).slice(0, 8);
    const separateRows = buttons.filter((button) => button.separate);
    if (regularRow.length) {
      blocks.push({
        type: "buttons",
        align: "left",
        buttons: regularRow.map((button) => ({
          text: button.text,
          callback_data: button.data,
          ...(button.style ? { style: button.style } : {})
        }))
      });
    }
    for (const button of separateRows) {
      blocks.push({
        type: "buttons",
        align: "left",
        buttons: [{
          text: button.text,
          callback_data: button.data,
          ...(button.style ? { style: button.style } : {})
        }]
      });
    }
  }
  return { blocks };
}

function menuButtons(includeProfiles = true) {
  const buttons = [
    { text: "Status", data: `${CALLBACK_PREFIX}status`, style: "primary" },
    { text: "Help", data: `${CALLBACK_PREFIX}help`, style: "link" }
  ];
  if (includeProfiles) buttons.push({ text: "Profiles", data: `${CALLBACK_PREFIX}profiles` });
  return buttons;
}

function plainFallbackText(text) {
  return String(text ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^`{3}[^\n]*\n?/gm, "")
    .replace(/^`{3}\s*$/gm, "")
    .replace(/^\s*(---+|___+|\*\*\*+)\s*$/gm, "────────")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function legacyKeyboard(buttons) {
  if (!buttons.length) return undefined;
  const rows = [];
  const regular = buttons.filter((button) => !button.separate).slice(0, 8);
  if (regular.length) rows.push(regular.map((button) => ({
    text: button.text.slice(0, 64),
    callback_data: button.data.slice(0, 64)
  })));
  for (const button of buttons.filter((item) => item.separate).slice(0, 20)) {
    rows.push([{ text: button.text.slice(0, 64), callback_data: button.data.slice(0, 64) }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function sendRich(chatId, text, buttons = [], options = {}) {
  const payload = {
    chat_id: chatId,
    rich_message: richContent(text, buttons),
    ...(options.ephemeralMessageParameters
      ? { ephemeral_message_parameters: options.ephemeralMessageParameters }
      : {}),
    ...(options.replyParameters ? { reply_parameters: options.replyParameters } : {})
  };
  try {
    return await telegram("sendRichMessage", payload);
  } catch (error) {
    const canFallback = Boolean(error?.telegramStatus) ||
      /method not found|unknown method|unsupported method|not found/i.test(error?.telegramDescription || error?.message || "");
    if (!canFallback) throw error;

    // If this Bot API server rejects Rich Messages for any reason, retry as a standard message.
    const ephemeral = options.ephemeralMessageParameters;
    const fallbackChatId = ephemeral?.receiver_user_id ?? chatId;
    const fallbackPayload = {
      chat_id: fallbackChatId,
      text: plainFallbackText(text),
      ...(legacyKeyboard(buttons) ? { reply_markup: legacyKeyboard(buttons) } : {})
    };
    return await telegram("sendMessage", fallbackPayload);
  }
}

async function sendText(chatId, text, replyToMessageId) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (cut < MAX_MESSAGE_LENGTH * 0.5) cut = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  for (let i = 0; i < chunks.length; i++) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      ...(i === 0 && replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }
}

function isOwner(userId) {
  return String(userId ?? "") === config.telegramOwnerId;
}

function isGroup(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function helpText() {
  return `Nabees Agent is connected. Chat normally and your message will be treated as a task.

Active profile: **${selectedProfile}**

- `/agent <name>` — switch agent profile
- `/agents` — list profiles
- `/task <task>` — explicitly submit a task
- `/status` — check progress
- `/help` — show commands

Only the configured owner can run tasks. In groups, buttons return private ephemeral responses when Telegram supports them.`;
}

async function profilesText() {
  const profiles = await listProfiles();
  return `**Available agent profiles**

${profiles.map((profile) => `- **${profile.name}** — ${profile.description}`).join("\n")}

Use `/agent <name>` in the owner's private chat to switch profiles.`;
}

function statusText(groupView = false) {
  if (groupView) {
    return activeTask
      ? "Nabees Agent is currently busy with a task."
      : "Nabees Agent is idle and ready.";
  }
  return activeTask
    ? `**Task is running**

Profile: ${activeTask.profile}
Started: ${activeTask.startedAt}

Task: ${activeTask.task.slice(0, 700)}`
    : `Agent is idle and ready for a task.\n\nActive profile: **${selectedProfile}**`;
}

async function handleCallback(callback) {
  const callbackId = callback.id;
  const userId = callback.from?.id;
  const chat = callback.message?.chat;
  const chatId = chat?.id;
  const data = String(callback.data || "");
  if (!data.startsWith(CALLBACK_PREFIX)) {
    await telegram("answerCallbackQuery", { callback_query_id: callbackId });
    return;
  }

  if (!chatId || (!isOwner(userId) && !isGroup(chat))) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "This agent is private.",
      show_alert: true
    });
    return;
  }

  const groupView = isGroup(chat);
  const action = data.slice(CALLBACK_PREFIX.length);

  // Package installation approvals are persisted and can only be decided by the configured owner in private chat.
  if (action.startsWith("pkg:")) {
    if (!isOwner(userId) || chat?.type !== "private") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Only the owner can approve or reject package installation.",
        show_alert: true
      });
      return;
    }
    const match = action.match(/^pkg:([a-f0-9]{12}):(approve|reject)$/);
    if (!match) {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Invalid approval button." });
      return;
    }
    const result = await decidePackageApproval(match[1], match[2], userId, config.telegramOwnerId);
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: result.ok
        ? (result.status === "approved" ? "Approved. The waiting task may continue." : "Rejected. The package will not be installed.")
        : result.message,
      show_alert: !result.ok
    });
    if (result.ok) {
      const status = result.status === "approved" ? "Approved" : "Rejected";
      await sendRich(chatId, `**Package request ${status.toLowerCase()}**\n\nPackage: \`${result.package}\`\nDecision: ${status}`);
    }
    return;
  }

  // Dynamic task questions use short, one-time callback IDs and only accept the owner in private chat.
  if (action.startsWith("q:")) {
    if (!isOwner(userId) || chat?.type !== "private") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Only the owner can answer this question.",
        show_alert: true
      });
      return;
    }
    const match = action.match(/^q:([a-f0-9]{12}):(\d+)$/);
    if (!match) {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Invalid or expired choice." });
      return;
    }
    const result = resolveUserChoice(match[1], Number(match[2]));
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: result.ok ? `Selected: ${result.selected}. Continuing.` : result.reason,
      show_alert: !result.ok
    });
    return;
  }

  let response;
  let buttons = menuButtons(!groupView);

  if (action === "help") {
    response = groupView
      ? "Nabees Agent supports private owner-only task execution. These group buttons are informational."
      : helpText();
  } else if (action === "status") {
    response = statusText(groupView);
  } else if (action === "profiles") {
    response = await profilesText();
    if (!groupView && isOwner(userId)) {
      const profiles = await listProfiles();
      buttons = profiles.slice(0, 5).map((profile) => ({
        text: profile.name,
        data: `${CALLBACK_PREFIX}profile:${profile.name}`,
        separate: true
      }));
      buttons.push({ text: "Help", data: `${CALLBACK_PREFIX}help`, style: "link" });
    } else {
      buttons = [];
    }
  } else if (action.startsWith("profile:")) {
    if (groupView || !isOwner(userId)) {
      response = "Profile switching is only available to the owner in a private chat.";
      buttons = [];
    } else {
      const requestedProfile = action.slice("profile:".length).toLowerCase();
      try {
        await loadProfile(requestedProfile);
        selectedProfile = requestedProfile;
        response = `Switched to the **${selectedProfile}** profile. Send your next task as a normal message.`;
        buttons = menuButtons();
      } catch (error) {
        response = `${error.message}\n\nUse Profiles to view available profiles.`;
        buttons = menuButtons();
      }
    }
  } else {
    response = "That button action is not recognized.";
    buttons = menuButtons(!groupView);
  }

  await telegram("answerCallbackQuery", { callback_query_id: callbackId });

  if (groupView) {
    // Callback-triggered ephemeral messages can be delivered without making the answer public.
    // Telegram only guarantees this interaction for a short window after the button press.
    await sendRich(chatId, response, [], {
      ephemeralMessageParameters: {
        receiver_user_id: userId,
        callback_query_id: callbackId,
        replace_callback_query_message: true
      }
    });
  } else {
    // Keep the previous response in place and post the next response as a new rich message.
    await sendRich(chatId, response, buttons);
  }
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const senderId = message.from?.id;
  const text = message.text?.trim();
  if (!chatId || !text) return;

  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const name = command?.[1]?.toLowerCase();
  const argument = command?.[2]?.trim() || "";
  const group = isGroup(message.chat);

  // Groups get a small public menu; the menu's button actions reply ephemerally.
  // Task execution and profile changes remain restricted to the owner's private chat.
  if (group) {
    if (name === "start" || name === "help") {
      await sendRich(chatId,
        "Nabees Agent\n\nChoose an option below. Status and help details are returned privately to the person who taps a button.",
        menuButtons(false)
      );
    }
    return;
  }

  if (!isOwner(senderId)) {
    await sendRich(chatId, "This agent is private and is not authorized for this account.");
    return;
  }

  if (name === "start" || name === "help") {
    await sendRich(chatId, helpText(), menuButtons());
    return;
  }
  if (name === "status") {
    await sendRich(chatId, statusText(), menuButtons());
    return;
  }
  if (name === "agents") {
    await sendRich(chatId, await profilesText(), menuButtons());
    return;
  }
  if (name === "agent") {
    if (!argument) {
      await sendRich(chatId, `Current profile: **${selectedProfile}**\n\nChoose Profiles to switch.`, menuButtons());
      return;
    }
    const requestedProfile = argument.toLowerCase();
    try {
      await loadProfile(requestedProfile);
      selectedProfile = requestedProfile;
      await sendRich(chatId, `Switched to the **${selectedProfile}** profile. Send your next task as a normal message.`, menuButtons());
    } catch (error) {
      await sendRich(chatId, `${error.message}\n\nUse Profiles to view available profiles.`, menuButtons());
    }
    return;
  }
  if (name && name !== "task") {
    await sendRich(chatId, "Unknown command. Use Help to see available commands.", menuButtons());
    return;
  }

  const task = name === "task" ? argument : text;
  if (!task) {
    await sendRich(chatId, "Tell me what to do, for example: `/task Inspect the workspace and summarize its files.`", menuButtons());
    return;
  }
  if (activeTask) {
    await sendRich(chatId, "A task is already running. Please wait for it to finish, then send the next task.", menuButtons());
    return;
  }

  activeTask = { task, profile: selectedProfile, startedAt: new Date().toISOString() };
  await sendRich(chatId, `**Task received**\n\nProfile: ${selectedProfile}\nWorking on it now.\n\n${task.slice(0, 700)}`);
  try {
    const result = await runAgent(task, { profile: activeTask.profile, history: conversationHistory });
    if (Array.isArray(result.history)) conversationHistory = result.history;
    await sendRich(chatId, `**Task finished**\n\n${result.answer}\n\n---\nCheckpoint: ${result.checkpoint}`, menuButtons());
  } catch (error) {
    console.error("Agent task execution failed:", describeError(error));
    if (error?.stack) console.error(error.stack);
    await sendRich(chatId, `**Task failed**\n\n${error.message || "Unknown error"}`, menuButtons());
  } finally {
    activeTask = null;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startTelegramController() {
  validateConfig();
  if (!config.telegramBotToken || !config.telegramOwnerId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID in .env.");
  }
  if (!/^\d+$/.test(config.telegramOwnerId)) {
    throw new Error("TELEGRAM_OWNER_ID must be your numeric Telegram user ID.");
  }

  const me = await telegram("getMe");
  console.log(`Telegram controller connected as @${me.username || me.id}`);
  console.log(`Authorized owner ID: ${config.telegramOwnerId}`);
  console.log("Send /start to the bot in Telegram. Press Ctrl+C to stop.");

  registerChoicePromptSender(async ({ id, prompt, choices }) => {
    const buttons = choices.map((choice, index) => ({
      text: choice,
      data: `${CALLBACK_PREFIX}q:${id}:${index}`
    }));
    await sendRich(config.telegramOwnerId, prompt, buttons);
  });

  await initializePackageApprovals();
  registerPackageApprovalNotifier(async ({ id, text }) => {
    await sendRich(config.telegramOwnerId, text, [
      { text: "Approve", data: `${CALLBACK_PREFIX}pkg:${id}:approve`, style: "success" },
      { text: "Reject", data: `${CALLBACK_PREFIX}pkg:${id}:reject`, style: "danger" }
    ]);
  });

  let offset = 0;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if (update.callback_query) {
          void handleCallback(update.callback_query).catch((error) => {
            console.error("Telegram button handling failed:", error.message);
          });
        }
        if (update.message) {
          void handleMessage(update.message).catch(async (error) => {
            console.error("Telegram message handling failed:", describeError(error));
            if (error?.stack) console.error(error.stack);
            try {
              await sendText(config.telegramOwnerId, `Agent error: ${error.message || "Unknown error"}`);
            } catch (notifyError) {
              console.error("Could not notify owner about the error:", describeError(notifyError));
            }
          });
        }
      }
    } catch (error) {
      if (!stopping) {
        console.error("Telegram polling error:", describeError(error));
        await sleep(3000);
      }
    }
  }
  console.log("Telegram controller stopped.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startTelegramController().catch((error) => {
    console.error(`Telegram controller error: ${error.message}`);
    process.exitCode = 1;
  });
}
