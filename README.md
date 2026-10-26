# Nabees Autonomous Agent

A small, structured Node.js agent that uses Oxion AI's OpenAI-compatible API and native function calling to plan work, call tools, inspect results, and continue until the task is complete or it reaches its step limit.

## Current capabilities

- Native model tool-calling loop (no JSON-in-prose parsing).
- Read, create, and edit files inside a configured workspace.
- Search the web using DuckDuckGo HTML results.
- Run a limited set of checks and read-only Git commands.
- Save task checkpoints locally so the last run can be inspected.
- Keeps the Oxion API key in environment configuration, never in source control.

## Setup

Requires Node.js 20+.

1. Copy `.env.example` to `.env`.
2. Add your Oxion API key to `OXION_API_KEY` in `.env`.
3. Confirm the model ID shown in your Oxion dashboard and set `OXION_MODEL` accordingly.
4. Run:

```sh
npm run check
npm start -- "Inspect the workspace and explain what is there"
```

The agent creates the workspace directory if it does not exist. Set `AGENT_WORKSPACE` to the project directory you want it to work on.

## Security boundaries

- Do not paste API keys into prompts or source files. Keep `.env` private.
- File tools reject paths that resolve outside `AGENT_WORKSPACE`.
- Shell access is intentionally narrow: only approved test/build scripts and read-only Git inspection commands are exposed.
- The agent does not deploy, delete repositories, change credentials, or perform other high-impact actions automatically. Those actions need a separately designed approval flow.
- Run this in a disposable/containerized environment for untrusted repositories. A workspace path check is not a full operating-system sandbox; project scripts can execute code when run.

## Current scope

This is the first working foundation, not the finished Telegram-controlled agent. It does not yet include Telegram, Playwright/browser interaction, GitHub branch/PR automation, remote memory, or image generation. Add those as separate modules after validating the Oxion connection and tool loop.

## Layout

```text
src/
  config.js   Environment loading and validation
  oxion.js    OpenAI-compatible API client
  tools.js    Explicit tool schemas and guarded implementations
  agent.js    Agent loop and local checkpoint
  index.js    CLI entry point
```
