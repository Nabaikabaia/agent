import { config, validateConfig } from "./config.js";
import { runAgent } from "./agent.js";

const API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 3900;
let activeTask = null;
let stopping = false;

async function telegram(method, payload = {}) {
  const response = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API HTTP ${response.status}`);
  }
  return data.result;
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

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const senderId = message.from?.id;
  const text = message.text?.trim();
  if (!chatId || !text) return;

  // The controller is intentionally restricted to the configured owner's private chat.
  if (String(senderId) !== config.telegramOwnerId || message.chat?.type !== "private") {
    if (message.chat?.type === "private") {
      await sendText(chatId, "This agent is private and is not authorized for this account.");
    }
    return;
  }

  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const name = command?.[1]?.toLowerCase();
  const argument = command?.[2]?.trim() || "";

  if (name === "start" || name === "help") {
    await sendText(chatId,
      "Nabees Agent is connected. Send a task as a message or use /task <task>.\n\n" +
      "/task <task> — run a task\n/status — show whether a task is running\n/help — show commands\n\n" +
      "Only your configured Telegram account can control this agent.");
    return;
  }
  if (name === "status") {
    await sendText(chatId, activeTask
      ? `Task is running.\nTask: ${activeTask.task.slice(0, 700)}\nStarted: ${activeTask.startedAt}`
      : "Agent is idle and ready for a task.");
    return;
  }
  if (name && name !== "task") {
    await sendText(chatId, "Unknown command. Use /help to see available commands.");
    return;
  }

  const task = name === "task" ? argument : text;
  if (!task) {
    await sendText(chatId, "Tell me what to do, for example: /task Inspect the workspace and summarize its files.");
    return;
  }
  if (activeTask) {
    await sendText(chatId, "A task is already running. Please wait for it to finish, then send the next task.");
    return;
  }

  activeTask = { task, startedAt: new Date().toISOString() };
  await sendText(chatId, `Task received. Working on it now.\n\n${task.slice(0, 700)}`, message.message_id);
  try {
    const result = await runAgent(task);
    await sendText(chatId, `Task finished.\n\n${result.answer}\n\nCheckpoint: ${result.checkpoint}`);
  } catch (error) {
    await sendText(chatId, `Task failed: ${error.message || "Unknown error"}`);
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

  let offset = 0;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if (update.message) {
          try {
            await handleMessage(update.message);
          } catch (error) {
            console.error("Telegram message handling failed:", error.message);
          }
        }
      }
    } catch (error) {
      if (!stopping) {
        console.error("Telegram polling error:", error.message);
        await sleep(3000);
      }
    }
  }
  console.log("Telegram controller stopped.");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startTelegramController().catch((error) => {
    console.error(`Telegram controller error: ${error.message}`);
    process.exitCode = 1;
  });
}
