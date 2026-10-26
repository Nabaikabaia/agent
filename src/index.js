import { config, validateConfig } from "./config.js";
import { runAgent } from "./agent.js";

const task = process.argv.slice(2).join(" ").trim();

try {
  validateConfig();
  if (!task) {
    console.error('Usage: npm start -- "Describe the task for the agent"');
    process.exitCode = 2;
  } else {
    console.log(`Nabees Agent | model: ${config.model}`);
    console.log(`Workspace: ${config.workspace}`);
    const result = await runAgent(task);
    console.log("\n--- Result ---\n");
    console.log(result.answer);
    console.log(`\nCheckpoint: ${result.checkpoint}`);
  }
} catch (error) {
  console.error(`Agent error: ${error.message}`);
  process.exitCode = 1;
}
