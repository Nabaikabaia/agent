import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { requestUserChoice } from "../interaction.js";
import { getWhatsAppSocket } from "./socket-state.js";

const registryFile = path.join(config.stateDir, "whatsapp-capabilities.json");
const deniedMethods = new Set([
  "end", "logout", "requestPairingCode", "sendNode", "query", "waitForSocketOpen",
  "ws", "ev", "authState", "signalRepository", "user", "generateMessageTag"
]);
const readOnlyPrefixes = /^(?:fetch|get|onWhatsApp|groupMetadata|groupFetch|profilePictureUrl|newsletterMetadata|newsletterFetch|chatModify)$/i;

function validMethod(method) {
  return typeof method === "string" &&
    /^[a-z][A-Za-z0-9]{1,80}$/.test(method) &&
    !deniedMethods.has(method) &&
    !method.startsWith("_");
}

function effectiveRisk(method, requestedRisk) {
  if (readOnlyPrefixes.test(method)) return "read";
  return requestedRisk === "destructive" ? "destructive" : "write";
}

async function readRegistry() {
  try {
    const value = JSON.parse(await fs.readFile(registryFile, "utf8"));
    return Array.isArray(value) ? value.filter(item =>
      item && typeof item.name === "string" && validMethod(item.method)
    ) : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[Nabees WhatsApp] Capability registry could not be read:", error.message);
    return [];
  }
}

async function writeRegistry(entries) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = registryFile + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, registryFile);
}

export async function discoverWhatsAppApi() {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected. Pair the account first.");
  let version = "unknown";
  try {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("node_modules/@whiskeysockets/baileys/package.json"), "utf8"));
    version = packageJson.version || version;
  } catch {}
  const methods = Object.keys(sock).filter(key => typeof sock[key] === "function" && validMethod(key)).sort();
  return {
    package: "@whiskeysockets/baileys",
    version,
    publicSocketMethods: methods,
    note: "Method availability does not document its arguments. Verify the installed version's official documentation and type declarations before registering or invoking a method."
  };
}

export async function listWhatsAppCapabilities() {
  const entries = await readRegistry();
  return entries.map(({ name, method, description, risk, argumentsDescription }) => ({
    name, method, description, risk, argumentsDescription
  }));
}

export async function registerWhatsAppCapability(args = {}) {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected. Pair the account first.");
  const name = String(args.name || "").trim().toLowerCase();
  const method = String(args.method || "").trim();
  const description = String(args.description || "").trim();
  const argumentsDescription = String(args.arguments_description || "").trim();
  if (!/^[a-z][a-z0-9_]{2,48}$/.test(name)) throw new Error("Capability name must be a short lowercase identifier.");
  if (!validMethod(method) || typeof sock[method] !== "function") throw new Error("That method is not an available public method on the connected Baileys socket.");
  if (description.length < 8 || description.length > 500) throw new Error("Provide a useful capability description (8–500 characters).");
  if (argumentsDescription.length > 1200) throw new Error("Argument guidance must be under 1200 characters.");
  const risk = effectiveRisk(method, args.risk);
  const entries = await readRegistry();
  if (entries.some(item => item.name === name)) throw new Error("A capability with that name already exists.");
  const approval = await requestUserChoice({
    prompt: "Nabees wants to register a reusable WhatsApp capability.\n\nName: " + name +
      "\nBaileys method: " + method + "\nRisk: " + risk + "\nDescription: " + description +
      "\nArguments: " + (argumentsDescription || "No argument notes supplied.") +
      "\n\nThis adds a method wrapper to Nabees's WhatsApp tool registry. Calls that change account or group state will still require approval.",
    choices: ["Approve capability", "Cancel"],
    timeout_seconds: 300
  });
  if (approval.timed_out || approval.selected !== "Approve capability") {
    return { registered: false, approval: approval.timed_out ? "expired" : "rejected", name };
  }
  entries.push({
    name, method, description, risk, argumentsDescription,
    registeredAt: new Date().toISOString()
  });
  await writeRegistry(entries);
  return { registered: true, name, method, risk, description };
}

function serializable(value) {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : JSON.parse(json);
  } catch {
    return String(value);
  }
}

export async function executeRegisteredWhatsAppCapability(args = {}) {
  const sock = getWhatsAppSocket();
  if (!sock) throw new Error("WhatsApp is not connected. Pair the account first.");
  const name = String(args.name || "").trim().toLowerCase();
  const entries = await readRegistry();
  const capability = entries.find(item => item.name === name);
  if (!capability) throw new Error("That WhatsApp capability is not registered. Discover the API and register it first.");
  if (typeof sock[capability.method] !== "function") throw new Error("This Baileys method is unavailable in the currently installed version.");
  const methodArgs = Array.isArray(args.args) ? args.args : [];
  if (methodArgs.length > 12 || JSON.stringify(methodArgs).length > 12_000) throw new Error("Capability arguments exceed the safety limit.");
  const risk = effectiveRisk(capability.method, capability.risk);
  if (risk !== "read") {
    const approval = await requestUserChoice({
      prompt: "Approve WhatsApp capability **" + capability.name + "**?\n\n" +
        capability.description + "\nMethod: " + capability.method + "\nArguments: " +
        JSON.stringify(methodArgs).slice(0, 1500),
      choices: ["Approve action", "Cancel"],
      timeout_seconds: 300
    });
    if (approval.timed_out || approval.selected !== "Approve action") {
      return { executed: false, approval: approval.timed_out ? "expired" : "rejected" };
    }
  }
  const result = await sock[capability.method](...methodArgs);
  return { executed: true, capability: capability.name, result: serializable(result) };
}
