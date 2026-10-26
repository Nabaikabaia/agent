# Nabees Autonomous Agent

A structured Node.js autonomous agent powered by Oxion AI's OpenAI-compatible API and native tool calling. It can plan tasks, use its available tools, inspect results, and continue until the task is done or it reaches its step limit.

## Current capabilities

- Natural-chat Telegram control: send a normal message; no task prefix is required.
- Optional commands for status, help, and switching between Markdown agent profiles.
- Separate agent profiles in `agents/*.md`, each with its own role and skill instructions.
- Native model tool-calling loop.
- Read, create, and edit files inside a configured workspace.
- Search the public web using DuckDuckGo HTML results.
- Run a limited set of project checks and read-only Git commands.
- Save task checkpoints locally.
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

## Run

Check syntax:

```sh
npm run check
```

Start Telegram polling:

```sh
npm run telegram
```

Open the bot and send `/start`. After that, **just chat normally**. For example, send:

```text
Look through my workspace and explain how the project works.
```

The controller treats normal text as a task, and keeps the last 10 user/agent exchanges as conversational context for follow-up messages. This chat context currently lives in memory and resets when the controller restarts. Commands are optional:

- `/agents` — list Markdown profiles.
- `/agent coder` — use the coding profile for the next messages.
- `/agent researcher` — use the research profile.
- `/agent general` — return to the general profile.
- `/agent` — show the selected profile.
- `/status` — check the current task.
- `/help` — show help.
- `/task <task>` — explicitly submit a task if you prefer.

Only one task runs at a time. The selected profile and recent chat context currently reset when the Telegram controller restarts. Keep the controller process running in your Box or configure the Box to start `npm run telegram` automatically. Do not run multiple controller instances with the same bot token. If the bot has a webhook configured, remove it before using this long-polling controller.

## Create your own agent profile

Add a Markdown file to the `agents/` directory. The filename (without `.md`) becomes the profile name. For example, create `agents/designer.md`:

```md
# Design Agent

You are a product and UI design specialist. Review existing design constraints before proposing changes.
Prefer polished, accessible, responsive interfaces and clear implementation steps.
```

Then send `/agents` in Telegram and select it with `/agent designer`. The profile is read for each task, so edits to an existing profile apply to the next task without rebuilding the code. Profiles are role instructions, not new tools; they can only use capabilities currently exposed to the agent.

Included profiles:
- `agents/general.md` — general-purpose assistant (default)
- `agents/coder.md` — software engineering
- `agents/researcher.md` — research and evidence synthesis

Treat profile files as trusted instructions: anyone who can edit them can change agent behavior. Do not put API keys, passwords, or other secrets in profile files.

## Security boundaries

- Only messages from `TELEGRAM_OWNER_ID` in a private chat can control the agent.
- Keep the Oxion API key and Telegram bot token in `.env`, never in source control.
- File tools reject paths that resolve outside `AGENT_WORKSPACE`.
- Shell access is intentionally narrow: only approved test/build scripts and read-only Git inspection commands are exposed.
- The agent does not deploy, delete user data, change credentials, make purchases, or perform other high-impact actions automatically.
- Run in a disposable/containerized environment for untrusted repositories. A workspace path check is not a full operating-system sandbox; project scripts can execute code when run.

## Layout

```text
src/
  config.js    Environment loading and validation
  oxion.js     OpenAI-compatible API client
  tools.js     Explicit tool schemas and guarded implementations
  agent.js     Agent loop and local checkpoint
  profiles.js  Markdown profile loader
  index.js     Terminal entry point
  telegram.js  Owner-only Telegram chat controller
agents/
  general.md
  coder.md
  researcher.md
  README.md
```
