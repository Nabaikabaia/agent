import { randomBytes } from "node:crypto";

let promptSender = null;
const pendingChoices = new Map();

export function registerChoicePromptSender(sender) {
  if (typeof sender !== "function") throw new TypeError("Choice prompt sender must be a function.");
  promptSender = sender;
}

export async function requestUserChoice({ prompt, choices, timeout_seconds = 300 }) {
  if (!promptSender) throw new Error("Telegram choice prompts are not connected.");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A non-empty prompt is required.");
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 8) {
    throw new Error("Provide between 2 and 8 button choices.");
  }

  const normalizedChoices = choices.map((choice) => String(choice ?? "").trim());
  if (normalizedChoices.some((choice) => !choice || choice.length > 64)) {
    throw new Error("Each choice must contain 1–64 characters.");
  }

  const id = randomBytes(6).toString("hex");
  const timeoutMs = Math.min(300, Math.max(10, Number(timeout_seconds) || 300)) * 1000;

  return await new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      pendingChoices.delete(id);
      resolve({ timed_out: true, message: "The user did not choose before the timeout." });
    }, timeoutMs);
    timer.unref?.();

    pendingChoices.set(id, {
      choices: normalizedChoices,
      resolve: (index) => {
        clearTimeout(timer);
        pendingChoices.delete(id);
        resolve({ selected: normalizedChoices[index], index });
      }
    });

    try {
      await promptSender({ id, prompt: prompt.trim(), choices: normalizedChoices });
    } catch (error) {
      clearTimeout(timer);
      pendingChoices.delete(id);
      reject(error);
    }
  });
}

export function resolveUserChoice(id, index) {
  const pending = pendingChoices.get(String(id));
  const selectedIndex = Number(index);
  if (!pending || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= pending.choices.length) {
    return { ok: false, reason: "This question has expired or that choice is invalid." };
  }
  const selected = pending.choices[selectedIndex];
  pending.resolve(selectedIndex);
  return { ok: true, selected };
}
