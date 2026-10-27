import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "./config.js";
import { runAgent } from "./agent.js";
import { listProfiles, loadProfile } from "./profiles.js";
import { registerChoicePromptSender, resolveUserChoice } from "./interaction.js";
import { initializePackageApprovals, registerPackageApprovalNotifier, decidePackageApproval } from "./approvals.js";
import { registerTelegramPhotoSender, registerTelegramDocumentSender } from "./tools.js";

const API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LENGTH = 3900;
const CALLBACK_PREFIX = "na:";
let activeTask = null;
let selectedProfile = "general";
let conversationHistory = [];
let stopping = false;
const pendingFollowups = new Map();

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

function richButtonsHtml(buttons = []) {
  if (!buttons.length) return "";
  const rows = [];
  const regular = buttons.filter((button) => !button.separate).slice(0, 8);
  if (regular.length) rows.push(regular);
  for (const button of buttons.filter((item) => item.separate).slice(0, 20)) rows.push([button]);

  return rows.map((row) => "<tg-button-row align=\"left\">" + row.map((button) => {
    const label = escapeHtml(String(button.text || "Continue").slice(0, 64));
    if (button.url && /^https?:\/\//i.test(button.url)) {
      const style = ["primary", "secondary", "success", "danger", "link"].includes(button.style) ? " style=\"" + button.style + "\"" : "";
      return "<tg-button type=\"url\"" + style + " url=\"" + escapeHtml(button.url) + "\">" + label + "</tg-button>";
    }
    const style = ["primary", "secondary", "success", "danger", "link"].includes(button.style) ? " style=\"" + button.style + "\"" : "";
    return "<tg-button type=\"callback_data\"" + style + " data=\"" + escapeHtml(String(button.data || "").slice(0, 64)) + "\">" + label + "</tg-button>";
  }).join("") + "</tg-button-row>").join("\n");
}

async function sendRich(chatId, text, buttons = [], options = {}) {
  const html = markdownToHtml(text) + richButtonsHtml(buttons);
  const payload = {
    chat_id: chatId,
    rich_message: { html: String(html || "&nbsp;").slice(0, 28000) },
    ...(options.ephemeralMessageParameters
      ? { ephemeral_message_parameters: options.ephemeralMessageParameters }
      : {}),
    ...(options.replyParameters ? { reply_parameters: options.replyParameters } : {})
  };
  try {
    return await telegram("sendRichMessage", payload);
  } catch (error) {
    const canFallback = Boolean(error?.telegramStatus) ||
      /method not found|unknown method|unsupported method|not found|http 404/i.test(error?.telegramDescription || error?.message || "");
    if (!canFallback) throw error;

    // Never fall back to ordinary inline keyboards: preserve the user's rich-button requirement.
    const ephemeral = options.ephemeralMessageParameters;
    const fallbackChatId = ephemeral?.receiver_user_id ?? chatId;
    return await telegram("sendMessage", {
      chat_id: fallbackChatId,
      text: plainFallbackText(text)
    });
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownToHtml(markdown) {
  const inline = (value) => escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");

  const source = String(markdown ?? "").replace(/\r/g, "");
  const chunks = source.split("\x60\x60\x60");
  return chunks.map((chunk, chunkIndex) => {
    if (chunkIndex % 2 === 1) {
      const code = chunk.replace(/^[\w+-]*\n/, "").replace(/^\n|\n$/g, "");
      return "<pre>" + escapeHtml(code) + "</pre>";
    }

    const lines = chunk.split("\n");
    const rendered = [];
    let paragraph = [];
    let list = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        rendered.push(paragraph.map((line) => inline(line)).join("<br>"));
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list.length) {
        rendered.push(list.map((item) => "• " + inline(item)).join("<br>"));
        list = [];
      }
    };
    const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      // Render Markdown tables as readable label/value lines. Telegram rich
      // messages do not reliably preserve table column alignment on phones.
      if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushParagraph();
        flushList();
        const headers = tableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const cells = tableCells(lines[i]);
          const label = inline(cells[0] || "");
          const detail = cells.slice(1).map((cell, index) =>
            (headers[index + 1] ? "<b>" + inline(headers[index + 1]) + ":</b> " : "") + inline(cell)
          ).join(" ");
          rows.push("• <b>" + label + "</b>" + (detail ? " — " + detail : ""));
          i++;
        }
        rendered.push(rows.join("<br>"));
        i--;
        continue;
      }

      const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        rendered.push("<b>" + inline(heading[1]) + "</b>");
        continue;
      }

      if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
        flushParagraph();
        flushList();
        rendered.push("────────");
        continue;
      }

      const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (item) {
        flushParagraph();
        list.push(item[1]);
        continue;
      }

      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return rendered.join("<br><br>");
  }).join("<br><br>");
}

function humanizeTool(name) {
  return String(name || "agent action")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function draftLabelForTask(task, event = "") {
  const text = String(task || "").toLowerCase();
  if (event) return event;
  if (/\b(?:image|photo|picture|screenshot|screenshots)\b/.test(text)) return /\bscreenshot/.test(text) ? "Opening the website and capturing a screenshot…" : "Analyzing your image…";
  if (/\b(?:voice|audio|transcri|listen)\b/.test(text)) return "Listening to the audio…";
  if (/\b(?:pdf|document|attachment|file)\b/.test(text)) return "Reading your file…";
  if (/\b(?:website|webpage|browser|browse|https?:\/\/|url)\b/.test(text)) return "Opening the website…";
  if (/\b(?:code|repository|repo|github|script|debug|implement|build|deploy)\b/.test(text)) return "Working on your code…";
  return "Thinking…";
}

function progressMessage(task, profile, events, state = "working", answer = "", checkpoint = "", buttons = []) {
  const details = [
    "<details><summary>Activity log</summary>",
    "<p><b>Profile:</b> " + escapeHtml(profile) + "</p>",
    "<p><b>Request:</b> " + escapeHtml(String(task).slice(0, 500)) + "</p>",
    "<ul>" + events.slice(-12).map((event) => "<li>" + escapeHtml(event) + "</li>").join("") + "</ul>",
    checkpoint ? "<p><b>Saved log:</b> <code>" + escapeHtml(checkpoint) + "</code></p>" : "",
    "</details>"
  ].filter(Boolean).join("\n");

  if (state === "working") {
    return "<tg-thinking>" + escapeHtml(draftLabelForTask(task, events.at(-1))) + "</tg-thinking>";
  }

  const buttonHtml = buttons.length
    ? "\n<tg-button-row align=\"left\">" + buttons.map((button, index) => {
        const style = index === 0 ? "primary" : "success";
        return "<tg-button type=\"callback_data\" style=\"" + style + "\" data=\"" + escapeHtml(button.data) + "\">" + escapeHtml(button.text) + "</tg-button>";
      }).join("") + "</tg-button-row>"
    : "";
  const body = state === "failed"
    ? "<h3>I couldn’t complete that request</h3>\n" + markdownToHtml(answer || "No response was returned.")
    : markdownToHtml(answer || "No response was returned.");
  // Details appear first and remain collapsed until tapped; the answer stays clean.
  return details + "\n" + body + buttonHtml;
}

async function sendRichDraft(chatId, draftId, html) {
  return telegram("sendRichMessageDraft", {
    chat_id: chatId,
    draft_id: draftId,
    rich_message: { html: String(html || "<tg-thinking>Thinking…</tg-thinking>").slice(0, 28000) },
    can_stop: true
  });
}

async function sendRichHtml(chatId, html) {
  return telegram("sendRichMessage", {
    chat_id: chatId,
    rich_message: { html: String(html || "&nbsp;").slice(0, 28000) }
  });
}

function suggestFollowups(task, answer) {
  const source = String(task + "\n" + answer).toLowerCase();
  let choices = [];
  if (/\b(error|failed|failure|exception|bug|issue|doesn't work|not working)\b/.test(source)) {
    choices = ["Investigate the error", "Try a fix and verify it"];
  } else if (/\b(code|repository|repo|file|implementation|function|script|build|deploy|commit)\b/.test(source)) {
    choices = ["Review the changes", "Test the implementation"];
  } else if (/\b(plan|steps|roadmap|first step|next step|workflow)\b/.test(source)) {
    choices = ["Start the next step", "Expand the plan"];
  } else if (/\b(explain|meaning|how does|what is|why does|concept)\b/.test(source)) {
    choices = ["Give me a practical example", "Explain it more simply"];
  }
  if (/\b(compare|versus|\bvs\b|options|alternatives)\b/.test(source)) {
    choices = ["Compare the options in more detail", "Recommend the best option"];
  }
  return [...new Set(choices)].slice(0, 2);
}

function createFollowupButtons(task, answer) {
  const choices = suggestFollowups(task, answer);
  if (!choices.length) return [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingFollowups.set(id, { task, choices });
  while (pendingFollowups.size > 30) pendingFollowups.delete(pendingFollowups.keys().next().value);
  return choices.map((choice, index) => ({
    text: choice,
    data: `${CALLBACK_PREFIX}f:${id}:${index}`
  }));
}

async function sendProgressMessage(chatId, text) {
  try {
    return await telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  } catch (error) {
    // Older Telegram clients/API servers may not support expandable blockquotes.
    if (!/parse entities|unsupported start tag|can't parse/i.test(error?.message || "")) throw error;
    return telegram("sendMessage", { chat_id: chatId, text: text.replace("<blockquote expandable>", "<blockquote>").replace("</blockquote>", "</blockquote>"), parse_mode: "HTML" });
  }
}

async function editProgressMessage(chatId, messageId, text, buttons = []) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: buttons.length ? legacyKeyboard(buttons) : { inline_keyboard: [] }
    });
  } catch (error) {
    if (/message is not modified/i.test(error?.message || "")) return null;
    if (/parse entities|unsupported start tag|can't parse/i.test(error?.message || "")) {
      return telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.replace("<blockquote expandable>", "<blockquote>"),
        parse_mode: "HTML",
        reply_markup: buttons.length ? legacyKeyboard(buttons) : { inline_keyboard: [] }
      });
    }
    throw error;
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

- /agent <name> — switch agent profile
- /agents — list profiles
- /task <task> — explicitly submit a task
- /status — check progress
- /help — show commands

Only the configured owner can run tasks. In groups, buttons return private ephemeral responses when Telegram supports them.`;
}

async function profilesText() {
  const profiles = await listProfiles();
  return `**Available agent profiles**

${profiles.map((profile) => `- **${profile.name}** — ${profile.description}`).join("\n")}

Use /agent <name> in the owner's private chat to switch profiles.`;
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

  // Contextual follow-up buttons are generated from the completed answer and run
  // as a continuation by editing the same Telegram message.
  if (action.startsWith("f:")) {
    if (!isOwner(userId) || chat?.type !== "private") {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Only the owner can continue this task.", show_alert: true });
      return;
    }
    const match = action.match(/^f:([a-z0-9]+):(\d+)$/i);
    const entry = match ? pendingFollowups.get(match[1]) : null;
    const index = match ? Number(match[2]) : -1;
    if (!entry || !Number.isInteger(index) || index < 0 || index >= entry.choices.length) {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "This follow-up has expired.", show_alert: true });
      return;
    }
    const selected = entry.choices[index];
    pendingFollowups.delete(match[1]);
    await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Continuing: " + selected });
    const followupTask = selected + " for the previous request. Original request: " + entry.task + ". Use the previous conversation and result as context, then carry this out.";
    await handleMessage({
      chat,
      from: callback.from,
      text: "/task " + followupTask,
      message_id: callback.message?.message_id
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

async function handleMessage(message, taskOptions = {}) {
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
  const progressEvents = ["Request received."];
  const draftId = Math.max(1, Date.now() % 2147483647);
  let progressTimer = null;
  let draftUpdateBusy = false;
  let draftAvailable = false;
  const updateDraft = async (eventText = "") => {
    if (eventText) {
      progressEvents.push(eventText);
      if (progressEvents.length > 30) progressEvents.splice(0, progressEvents.length - 30);
    }
    if (draftUpdateBusy) return;
    draftUpdateBusy = true;
    try {
      await sendRichDraft(chatId, draftId, "<tg-thinking>" + escapeHtml(draftLabelForTask(task, eventText || progressEvents.at(-1))) + "</tg-thinking>");
      draftAvailable = true;
    } catch (error) {
      if (draftAvailable) console.warn("Telegram rich draft update failed:", describeError(error));
      draftAvailable = false;
    } finally {
      draftUpdateBusy = false;
    }
  };

  try {
    await updateDraft(draftLabelForTask(task));
    progressTimer = setInterval(() => { void updateDraft(); }, 5_000);
    const result = await runAgent(task, {
      profile: activeTask.profile,
      history: conversationHistory,
      onProgress: (event) => {
        if (event.type === "tool_start" || event.type === "model_start") {
          void updateDraft(event.message || draftLabelForTask(task));
        } else if (event.type === "tool_done") {
          void updateDraft(event.message || (humanizeTool(event.tool) + " finished."));
        } else if (event.type === "continuation") {
          void updateDraft("Continuing with the remaining work…");
        }
      }
    });
    if (Array.isArray(result.history)) conversationHistory = result.history;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;

    if (result.status === "failed" || result.status === "step_limit") {
      progressEvents.push(result.status === "step_limit" ? "Work paused at the execution limit." : "The request ended with an error.");
      await sendRichHtml(chatId, progressMessage(task, activeTask.profile, progressEvents, "failed", result.answer, result.checkpoint));
      return;
    }

    progressEvents.push("Finished.");
    const followupButtons = createFollowupButtons(task, result.answer);
    await sendRichHtml(chatId, progressMessage(task, activeTask.profile, progressEvents, "done", result.answer, result.checkpoint, followupButtons));
  } catch (error) {
    console.error("Agent task execution failed:", describeError(error));
    if (error?.stack) console.error(error.stack);
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
    progressEvents.push("The request ended with an error.");
    await sendRichHtml(chatId, progressMessage(task, activeTask.profile, progressEvents, "failed", error.message || "Unknown error"));
  } finally {
    if (progressTimer) clearInterval(progressTimer);
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

  registerTelegramPhotoSender(async ({ filePath, caption }) => {
    const ext = path.extname(filePath).toLowerCase();
    const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[ext];
    if (!mime) throw new Error("Unsupported photo format.");
    const bytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("chat_id", config.telegramOwnerId);
    form.append("photo", new Blob([bytes], { type: mime }), path.basename(filePath));
    if (caption) form.append("caption", caption);
    let response;
    try {
      response = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`Telegram sendPhoto network request failed: ${describeError(error)}`, { cause: error });
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error(`Telegram sendPhoto returned non-JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || !data.ok) throw new Error(data.description || `Telegram sendPhoto failed (HTTP ${response.status}).`);
    return { sent: true, chat_id: config.telegramOwnerId, photo_id: data.result?.photo?.at(-1)?.file_id || null };
  });

  registerTelegramDocumentSender(async ({ filePath, caption }) => {
    const bytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("chat_id", config.telegramOwnerId);
    form.append("document", new Blob([bytes]), path.basename(filePath));
    if (caption) form.append("caption", caption);
    let response;
    try {
      response = await fetch(`${API()}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(`Telegram sendDocument network request failed: ${describeError(error)}`, { cause: error });
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error(`Telegram sendDocument returned non-JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || !data.ok) throw new Error(data.description || `Telegram sendDocument failed (HTTP ${response.status}).`);
    return {
      sent: true,
      chat_id: config.telegramOwnerId,
      file_name: path.basename(filePath),
      document_id: data.result?.document?.file_id || null
    };
  });

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
