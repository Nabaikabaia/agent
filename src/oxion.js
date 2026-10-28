import { config } from "./config.js";

const PREFERRED_FREE_TOOL_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling-small:free",
  "thinkingmachines/inkling:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "recursive/flint-v1.0:free"
];

let freeModelCache = { expiresAt: 0, ids: [] };

function isDailyFreeQuotaError(message = "") {
  return /free-models-per-day|free model.*(daily|day).*limit|daily.*free.*model.*limit/i.test(message);
}

function isRetryable(status, message = "") {
  if (!status) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
  return (status === 400 || status === 404) &&
    /model.{0,40}(not found|not available|unavailable|does not exist)|no endpoints|provider.{0,30}(unavailable|error)|tool.{0,30}(unsupported|not supported)/i.test(message);
}

function quotaMessage() {
  return "OpenRouter's daily free-model quota is exhausted. OpenRouter applies this limit across free models, so switching to another :free model will not bypass it. Wait for the daily allowance to reset or use a separately available non-free model. Adding credits is optional.";
}

async function getFreeToolModelIds() {
  if (freeModelCache.expiresAt > Date.now() && freeModelCache.ids.length) {
    return freeModelCache.ids;
  }

  const available = new Set();
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const payload = await response.json();
      for (const model of payload?.data || []) {
        const id = model?.id;
        const pricing = model?.pricing;
        const parameters = model?.supported_parameters;
        if (
          typeof id === "string" &&
          id.endsWith(":free") &&
          pricing?.prompt === "0" &&
          pricing?.completion === "0" &&
          Array.isArray(parameters) &&
          parameters.includes("tools")
        ) {
          available.add(id);
        }
      }
    }
  } catch {
    // Use the curated list when OpenRouter model discovery is unavailable.
  }

  const discovered = [
    ...PREFERRED_FREE_TOOL_MODELS.filter((id) => available.has(id)),
    ...[...available].filter((id) => !PREFERRED_FREE_TOOL_MODELS.includes(id)).sort()
  ];
  const ids = discovered.length ? discovered : PREFERRED_FREE_TOOL_MODELS;
  freeModelCache = { expiresAt: Date.now() + 5 * 60_000, ids };
  return ids;
}

async function requestModel(model, messages, tools, signal) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        stream: false
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.aiRequestTimeoutMs)]) : AbortSignal.timeout(config.aiRequestTimeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      model,
      status: 0,
      error: new Error(timeout
        ? `Request timed out after ${Math.round(config.aiRequestTimeoutMs / 1000)} seconds.`
        : (error.message || "Network request failed."))
    };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      model,
      status: response.status,
      error: new Error(`Provider returned non-JSON (HTTP ${response.status}).`)
    };
  }

  if (!response.ok) {
    return {
      model,
      status: response.status,
      error: new Error(data?.error?.message || data?.message || `HTTP ${response.status}`)
    };
  }

  const choice = data?.choices?.[0];
  if (!choice?.message) {
    return {
      model,
      status: response.status,
      error: new Error("Provider response did not contain choices[0].message.")
    };
  }

  return { model, message: choice.message };
}

export async function chatCompletion(messages, tools, options = {}) {
  if (options.signal?.aborted) throw new Error("Task cancelled.");
  const provider = config.provider || "openrouter";
  const primary = config.model;
  const first = await requestModel(primary, messages, tools, options.signal);
  if (first.message) return first.message;

  const firstError = first.error?.message || "Unknown provider error";

  if (provider === "openrouter" && isDailyFreeQuotaError(firstError)) {
    throw new Error(quotaMessage());
  }

  // Model discovery and :free failover are OpenRouter-specific. Never send
  // OpenRouter model IDs to another provider after its request fails.
  if (provider !== "openrouter") {
    console.warn("[Nabees] Primary model request failed:", first.status, firstError);
    throw new Error("Execution model unavailable.");
  }

  if (!isRetryable(first.status, firstError)) {
    console.warn("[Nabees] Model request could not be retried:", first.status, firstError);
    throw new Error("Execution model unavailable.");
  }

  const discovered = await getFreeToolModelIds();
  const fallbacks = discovered.filter((id) => id !== primary).slice(0, 5);

  if (!fallbacks.length) {
    console.warn("[Nabees] No alternate tool-capable models were discovered:", firstError);
    throw new Error("No alternate execution model is currently available.");
  }

  const failures = [`${primary}: ${firstError}`];
  console.warn(`[OpenRouter] Model ${primary} failed; trying up to ${fallbacks.length} free tool-capable fallback model(s).`);

  for (const model of fallbacks) {
    if (options.signal?.aborted) throw new Error("Task cancelled.");
    const result = await requestModel(model, messages, tools, options.signal);
    if (result.message) {
      console.warn(`[OpenRouter] Fallback succeeded with model ${model}.`);
      return result.message;
    }

    const message = result.error?.message || "Unknown provider error";
    if (isDailyFreeQuotaError(message)) throw new Error(quotaMessage());

    failures.push(`${model}: ${message}`);
  }

  console.warn("[Nabees] All model attempts failed:", failures.join(" | "));
  throw new Error("All available execution models failed.");
}
