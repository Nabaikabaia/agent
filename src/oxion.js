import { config } from "./config.js";

export async function chatCompletion(messages, tools) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false
    }),
    signal: AbortSignal.timeout(120_000)
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Oxion returned non-JSON (HTTP ${response.status}). Check the API base URL and model.`);
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(`Oxion API error: ${message}`);
  }

  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error("Oxion response did not contain choices[0].message.");
  return choice.message;
}
