# Nabees Autonomous Agent

A structured Node.js autonomous agent powered by Oxion AI's OpenAI-compatible API and native tool calling. It can plan tasks, use its available tools, inspect results, and continue until the task is done or it reaches its step limit.

## Current capabilities

- Native model tool-calling loop.
- Read, create, and edit files inside a configured workspace.
- Search the public web using DuckDuckGo HTML results.
- Run a limited set of project checks and read-only Git commands.
- Save task checkpoints locally.
- Telegram long-polling controller for sending tasks and checking status.
- Telegram control is restricted to one configured numeric owner ID.
- No third-party Node dependencies.

## Setup

Requires Node.js 20+.

1. Copy `.env.example` to `.env`.
2. Add your Oxion API key to `OXION_API_KEY`.
3. Confirm the model ID shown in your Oxion dashboard and set `OXION_MODEL` accordingly.
4. Create a Telegram bot with Telegram's official **@BotFather**: send `/newbot`, follow the prompts, and copy the bot token.
5. Find your numeric Telegram user ID (for example, with **@userinfobot**).
6. Put the bot token and your numeric user ID in `.env`:

```env
OXION_API_KEY=your_oxion_key
OXION_BASE_URL=https://www.oxionai.com/v1
OXION_MODEL=deepseek-v4-flash-0731
TELEGRAM_BOT_TOKEN=your_botfather_token
TELEGRAM_OWNER_ID=your_numeric_telegram_user_id
```

Keep `.env` private; never paste the tokens into chat or commit them.

### Run from the terminal

```sh
npm run check
npm start -- "Inspect the workspace and explain what is there"
```

### Run through Telegram

Start the long-polling controller in the Box terminal:

```sh
npm run telegram
```

Open the new bot in Telegram and send `/start`. Then send a task as a normal message or use:

```text
/task Inspect the workspace and summarize its files
/status
/help
```

The controller stays running while it polls Telegram. Keep that process alive in your Box session or configure the Box to start `npm run telegram` automatically. Do not run multiple controller instances with the same bot token. The bot uses long polling; if a webhook is configured for that bot, remove it before using this controller.

## Security boundaries

- Only messages from `TELEGRAM_OWNER_ID` in a private chat can control the agent.
- Keep the Oxion API key and Telegram bot token in `.env`, never in source control.
- File tools reject paths that resolve outside `AGENT_WORKSPACE`.
- Shell access is intentionally narrow: only approved test/build scripts and read-only Git inspection commands are exposed.
- The agent does not deploy, delete user data, change credentials, make purchases, or perform other high-impact actions automatically.
- Run in a disposable/containerized environment for untrusted repositories. A workspace path check is not a full operating-system sandbox; project scripts can execute code when run.

## Current scope

Telegram currently supports one task at a time, plain-text task requests, `/task`, `/status`, and `/help`. It does not yet support cancellation, approvals through Telegram, GitHub branch/PR automation, browser automation, remote memory, or image generation. Oxion must be reachable and the configured model must be available for AI tasks to work.

## Layout

```text
src/
  config.js    Environment loading and validation
  oxion.js     OpenAI-compatible API client
  tools.js     Explicit tool schemas and guarded implementations
  agent.js     Agent loop and local checkpoint
  index.js     Terminal entry point
  telegram.js  Owner-only Telegram command controller
```
