import crypto from "node:crypto";

const uuid = () => crypto.randomUUID();
const DEFAULT_BASE = "https://android.chat.openai.com";
const REQUEST_TIMEOUT_MS = 120_000;

// Keep the anonymous session and conversation together so each Telegram message
// can continue the same chat. These values live only in process memory.
let conversationState = null;

function parseCookies(headers) {
  const out = {};
  const lines = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") || ""];

  for (const line of lines) {
    const first = line.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

function clean(text) {
  return String(text || "")
    .replace(/\uE200entity\uE202([^\uE201]+)\uE201/g, (_match, payload) => {
      try {
        const parsed = JSON.parse(payload);
        return parsed[1] || parsed[0] || "";
      } catch {
        return "";
      }
    })
    .replace(/\uE200[^\uE201]*\uE201/g, "")
    .trim();
}

async function newSession(base) {
  const deviceId = uuid();
  let res;

  try {
    res = await fetch(base + "/backend-anon/sentinel/chat-requirements", {
      method: "POST",
      headers: {
        "User-Agent": "ChatGPT/1.2026.181 (Android 16; Neo/1.0; build 2222222)",
        "OAI-Package-Name": "com.openai.chatgpt",
        "OAI-Client-Type": "android",
        "OAI-Device-Id": deviceId,
        "Accept-Language": "en-US,en;q=0.9",
        "X-Device-Tier": "upper_mid",
        "ChatGPT-Account-Id": "default",
        "ChatGPT-Residency-Region": "no_constraint",
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw new Error("AI session initialization request failed: " + (error.message || "network error"));
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 180);
    throw new Error("AI session initialization failed (HTTP " + res.status + ")" + (detail ? ": " + detail : "") + ".");
  }

  const cookies = parseCookies(res.headers);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("AI session initialization returned invalid JSON.");
  }

  let cookie = Object.entries(cookies).map(([key, value]) => key + "=" + value).join("; ");
  if (!cookies["oai-sc"] && data?.token) {
    cookie = "oai-sc=0" + data.token + (cookie ? "; " + cookie : "");
  }

  if (!cookie) {
    throw new Error("AI session initialization returned no session cookie or token.");
  }

  return { cookie, deviceId, parentMessageId: uuid() };
}

function applyEvent(event, state) {
  if (event.conversation_id) state.chatId = event.conversation_id;
  const path = event.p !== undefined ? event.p : state.lastPath;
  const operation = event.o !== undefined ? event.o : state.lastOp;
  if (event.p !== undefined) state.lastPath = event.p;
  if (event.o !== undefined) state.lastOp = event.o;

  let changed = false;
  if (operation === "add" && event.v?.message?.author?.role === "assistant") {
    state.assistantMessageId = event.v.message.id || state.assistantMessageId;
    const parts = event.v.message.content?.parts;
    if (Array.isArray(parts) && typeof parts[0] === "string") {
      state.result = parts[0];
      changed = true;
    }
  } else if (operation === "patch" && Array.isArray(event.v)) {
    for (const item of event.v) {
      const itemPath = String(item.p || "");
      if (item.o === "append" && typeof item.v === "string" && itemPath.startsWith("/message/content/parts/")) {
        state.result += item.v;
        changed = true;
      } else if (item.o === "replace" && itemPath.startsWith("/message/content/parts/0") && typeof item.v === "string") {
        state.result = item.v;
        changed = true;
      }
    }
  } else if (operation === "append" && typeof event.v === "string" && String(path || "").startsWith("/message/content/parts/")) {
    state.result += event.v;
    changed = true;
  }
  return changed;
}

/**
 * Adapter for the supplied Android ChatGPT anonymous endpoint format.
 * This is an undocumented client endpoint, not an official OpenAI API, and
 * can change or impose its own access limits.
 */
export async function askNabeesAI(prompt, previous, config, onDelta = async () => {}) {
  const base = (config?.ai?.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const auth = previous?.auth || await newSession(base);
  if (!auth.deviceId) auth.deviceId = uuid();
  if (!auth.parentMessageId) auth.parentMessageId = uuid();

  const body = {
    action: "next",
    messages: [{
      id: uuid(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      status: "finished_successfully",
      recipient: "all"
    }],
    model: "auto",
    history_and_training_disabled: false,
    enable_message_followups: true,
    force_use_sse: true,
    supported_encodings: ["v1"],
    supports_buffering: true,
    timezone: config?.ai?.timezone || "Africa/Lagos",
    timezone_offset_min: Number(config?.ai?.timezoneOffsetMinutes ?? -60),
    no_auth_ad_preferences: { personalization_enabled: true, history_enabled: true },
    client_prepare_state: "none",
    stream: true
  };

  if (previous?.chatId) {
    body.conversation_id = previous.chatId;
    body.parent_message_id = auth.parentMessageId;
  }

  let res;
  try {
    res = await fetch(base + "/backend-anon/f/conversation", {
      method: "POST",
      headers: {
        "User-Agent": "ChatGPT/1.2026.181 (Android 16; Neo/1.0; build 2222222)",
        "OAI-Package-Name": "com.openai.chatgpt",
        "OAI-Client-Type": "android",
        "OAI-Device-Id": auth.deviceId,
        "Accept-Language": "en-US,en;q=0.9",
        "X-Device-Tier": "upper_mid",
        "ChatGPT-Account-Id": "default",
        "ChatGPT-Residency-Region": "no_constraint",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Cookie": auth.cookie
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error("AI conversation request failed: " + (error.message || "network error"));
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 180);
    throw new Error("AI provider returned HTTP " + res.status + (detail ? ": " + detail : ""));
  }

  const state = {
    result: "",
    chatId: previous?.chatId || null,
    assistantMessageId: null,
    lastPath: null,
    lastOp: null
  };
  let lineBuffer = "";
  let lastAt = 0;
  let lastLength = 0;

  const consume = async (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (applyEvent(event, state)) {
      const now = Date.now();
      if (state.result.length - lastLength >= 120 || now - lastAt >= 700) {
        lastAt = now;
        lastLength = state.result.length;
        await onDelta(state.result);
      }
    }
  };

  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        lineBuffer += decoder.decode(item.value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) await consume(line);
      }
      lineBuffer += decoder.decode();
      if (lineBuffer.trim()) await consume(lineBuffer);
    } finally {
      reader.releaseLock?.();
    }
  } else {
    for (const line of (await res.text()).split("\n")) await consume(line);
  }

  if (state.assistantMessageId) auth.parentMessageId = state.assistantMessageId;
  const response = clean(state.result);
  if (!response) throw new Error("The AI provider returned an empty response.");

  return {
    response,
    chatId: state.chatId,
    auth
  };
}

export async function replyWithGpt5(text, history = []) {
  const input = String(text || "").trim();
  if (!input) throw new Error("A message is required.");

  // Inject shared Telegram history on every call. The agent planner and this
  // GPT chat adapter are separate providers, so GPT cannot infer task results
  // from its own remote conversation alone.
  let prompt = input;
  if (Array.isArray(history) && history.length) {
    const context = history
      .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      .slice(-12)
      .map((item) => item.role + ": " + item.content)
      .join("\n");
    if (context) prompt = "Shared recent conversation and agent-task context:\n" + context + "\n\nCurrent owner message:\n" + input;
  }

  const result = await askNabeesAI(prompt, conversationState, {
    ai: {
      baseUrl: DEFAULT_BASE,
      timezone: "Africa/Lagos",
      timezoneOffsetMinutes: -60
    }
  });

  conversationState = {
    auth: result.auth,
    chatId: result.chatId
  };
  return result.response;
}
