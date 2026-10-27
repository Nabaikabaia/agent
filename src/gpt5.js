import { randomUUID } from "node:crypto";

const BASE = "https://android.chat.openai.com";
const TIMEOUT_MS = 90_000;
const DEVICE_ID = randomUUID();
let sessionCookie = "";
let conversationId = null;
let parentMessageId = randomUUID();
let sessionPromise = null;

const cleanText = (value) => String(value ?? "")
  .replace(/\u0000/g, "")
  .replace(/<\|[^|]+\|>/g, "")
  .trim();

function baseHeaders(extra = {}) {
  return {
    "User-Agent": "ChatGPT/1.2026.272 (Android 10; SM-G960U1; build 2627220)",
    "OAI-Package-Name": "com.openai.chatgpt",
    "OAI-Client-Type": "android",
    "OAI-Device-Id": DEVICE_ID,
    "Accept-Language": "en-US",
    "X-Device-Tier": "3",
    "Content-Type": "application/json",
    ...extra
  };
}

async function request(path, body, headers = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: baseHeaders(headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`GPT-5 chat request failed: ${error.message || "network error"}`, { cause: error });
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`GPT-5 chat endpoint returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  return { response, raw };
}

async function ensureSession() {
  if (sessionCookie) return;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const { response, raw } = await request("/backend-anon/sentinel/chat-requirements", {
      device_id: DEVICE_ID
    }, { Accept: "application/json" });

    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error("GPT-5 chat endpoint returned an invalid session response.");
    }

    const cookies = response.headers.getSetCookie?.() || [
      response.headers.get("set-cookie") || ""
    ];
    const cookieParts = cookies.flatMap((item) => item.split(/,(?=[^;]+=[^;]+)/g))
      .map((item) => item.split(";")[0].trim())
      .filter(Boolean);
    const token = data.token || data.session_token || "";
    if (token && !cookieParts.some((item) => item.startsWith("oai-sc="))) {
      cookieParts.push(`oai-sc=${token}`);
    }
    sessionCookie = cookieParts.join("; ");
    if (!sessionCookie) {
      throw new Error("GPT-5 chat endpoint did not provide a session cookie.");
    }
  })();
  try {
    await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

function extractTextFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content?.parts)) {
    return content.parts.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).join("");
  }
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : (part?.text || "")).join("");
  }
  return typeof content?.text === "string" ? content.text : "";
}

function parseSse(raw) {
  let conversation = conversationId;
  let nextParent = parentMessageId;
  const messages = new Map();
  let latestText = "";

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }

    if (event.conversation_id) conversation = event.conversation_id;
    const message = event.message || event.value;
    if (message && typeof message === "object") {
      const id = message.id || event.message_id;
      const role = message.author?.role || message.role;
      const text = extractTextFromMessage(message);
      if (id && role === "assistant" && text) {
        messages.set(id, text);
        nextParent = id;
        latestText = text;
      } else if (role === "assistant" && text) {
        latestText = text;
      }
    }

    const path = Array.isArray(event.path) ? event.path.join(".") : String(event.path || "");
    if (/messages\.[^.]+\.content\.parts/.test(path) && typeof event.value === "string") {
      const match = path.match(/messages\.([^.]+)/);
      const id = match?.[1];
      if (id) {
        const prior = messages.get(id) || "";
        const op = String(event.op || event.type || "").toLowerCase();
        const text = op === "append" ? prior + event.value : event.value;
        messages.set(id, text);
        latestText = text;
        nextParent = id;
      }
    }
    if (event.type === "message" && event.message?.author?.role === "assistant") {
      const text = extractTextFromMessage(event.message);
      if (text) {
        latestText = text;
        if (event.message.id) nextParent = event.message.id;
      }
    }
  }

  if (conversation) conversationId = conversation;
  if (nextParent) parentMessageId = nextParent;
  return cleanText(latestText || [...messages.values()].at(-1) || "");
}

/**
 * Uses the previously shared Android ChatGPT anonymous endpoint for ordinary
 * conversational replies. This is an undocumented client endpoint, not an
 * official OpenAI API, and may change or impose its own limits.
 */
export async function replyWithGpt5(text, history = []) {
  const input = String(text || "").trim();
  if (!input) throw new Error("A message is required.");

  await ensureSession();
  const userMessageId = randomUUID();
  const recentContext = Array.isArray(history)
    ? history.filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string").slice(-8)
    : [];
  const contextText = recentContext.length
    ? `Previous conversation for context (do not answer these again unless relevant):\n${recentContext.map((item) => `${item.role}: ${item.content}`).join("\n")}\n\nNew message: ${input}`
    : input;

  const payload = {
    action: "next",
    messages: [{
      id: userMessageId,
      author: { role: "user" },
      content: { content_type: "text", parts: [contextText] },
      metadata: {}
    }],
    model: "auto",
    parent_message_id: parentMessageId,
    force_use_sse: true,
    supported_encodings: ["v1"],
    supports_buffering: true,
    stream: true,
    timezone: "Africa/Lagos",
    timezone_offset_min: -60,
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: false
  };
  if (conversationId) payload.conversation_id = conversationId;

  const { raw } = await request("/backend-anon/f/conversation", payload, {
    Accept: "text/event-stream",
    Cookie: sessionCookie,
    "Cache-Control": "no-cache"
  });
  const answer = parseSse(raw);
  if (!answer) throw new Error("GPT-5 chat endpoint returned no assistant text.");
  return answer;
}
