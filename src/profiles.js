import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export async function listProfiles() {
  await fs.mkdir(config.agentsDir, { recursive: true });
  const entries = await fs.readdir(config.agentsDir, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!PROFILE_NAME.test(name)) continue;
    const content = (await fs.readFile(path.join(config.agentsDir, entry.name), "utf8")).trim();
    if (!content) continue;
    profiles.push({ name, description: content.split(/\r?\n/).find((line) => line.trim())?.replace(/^#\s*/, "") || name });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProfile(name = "general") {
  if (typeof name !== "string" || !PROFILE_NAME.test(name)) {
    throw new Error("Invalid agent profile name. Use letters, numbers, hyphens, or underscores.");
  }
  const file = path.join(config.agentsDir, `${name}.md`);
  let content;
  try {
    content = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      const available = (await listProfiles()).map((profile) => profile.name).join(", ");
      throw new Error(`Agent profile "${name}" was not found. Available profiles: ${available || "none"}.`);
    }
    throw error;
  }
  if (!content) throw new Error(`Agent profile "${name}" is empty.`);
  return content;
}
