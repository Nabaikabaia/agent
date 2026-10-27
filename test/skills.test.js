import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantSkills } from "../src/skills.js";

test("selectRelevantSkills prefers a skill whose name and description match the task", () => {
  const skills = [
    { name: "design-taste-frontend", description: "Frontend design, visual hierarchy, responsive landing pages", content: "Use spacing, typography, and layout principles." },
    { name: "database-migrations", description: "PostgreSQL schema migrations and indexes", content: "Apply migrations carefully." }
  ];
  const selected = selectRelevantSkills("Design a responsive frontend landing page", skills);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "design-taste-frontend");
});

test("selectRelevantSkills returns no unrelated skills", () => {
  const skills = [
    { name: "database-migrations", description: "PostgreSQL schema migrations and indexes", content: "Apply migrations carefully." }
  ];
  assert.deepEqual(selectRelevantSkills("Write a birthday poem", skills), []);
});
