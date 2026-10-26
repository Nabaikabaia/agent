# Nabees Autonomous Agent

Node.js autonomous agent powered by Oxion AI. It accepts natural-language tasks through Telegram and uses tools to research, inspect files, install project dependencies, work with GitHub, and run project checks.

## Capabilities

- Natural-chat Telegram control and Markdown profiles in `agents/*.md`.
- Workspace file listing, reading, and writing.
- Public web search and readable-page fetching.
- GitHub REST API access for repositories, contents, commits, issues, pull requests, releases, and search.
- Project-local package installation with npm, pnpm, yarn, or bun.
- Controlled one-command-at-a-time execution for development, tests, builds, and Git inspection.
- Local task checkpoints and short-lived conversational context.

## Setup

Requires Node.js 20+ and a running Box/workspace.

1. Copy `.env.example` to `.env`.
2. Set `OXION_API_KEY` and verify `OXION_MODEL` in your Oxion dashboard.
3. Create a bot with Telegram **@BotFather** and find your numeric Telegram user ID.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`.
5. Optional: set `GITHUB_TOKEN` to a least-privilege token for private repositories and higher API limits. Public GitHub API access works without it.

Never paste credentials into chat or commit `.env`.

## Run

```sh
npm run check
npm run telegram
```

Send `/start` to the bot, then chat normally. Example tasks:

- Inspect this project, install its dependencies, run its tests, and fix errors.
- Research a library, read its documentation, inspect its GitHub repository, and assess whether it fits my project.
- Clone my public repository into the workspace and explain its structure.

The Telegram controller keeps up to 10 exchanges in memory; context resets when it restarts. Only one task runs at a time.

## Commands

- `/agents` — list profiles.
- `/agent coder`, `/agent researcher`, `/agent general` — switch profile.
- `/agent` — show active profile.
- `/status` — check progress.
- `/help` — show commands.
- `/task <task>` — explicit task submission.

## Tool boundaries

- Package installation is project-local; global installs are unsupported.
- Commands run without a shell, have a supported executable list, timeouts, and output limits. Pipes and redirections are unsupported.
- Web fetching reads public pages but does not render JavaScript-heavy sites like a full browser automation engine.
- GitHub API access supports public repository endpoints; private access needs `GITHUB_TOKEN`.
- Dependency installation and project scripts can execute third-party code. Inspect unfamiliar scripts and use a disposable, isolated container for untrusted code.
- The agent must ask before deployment, remote pushes, destructive operations, credential changes, purchases, or other high-impact actions. Tool restrictions are not a full OS sandbox.

## Create profiles

Add `agents/designer.md` with role-specific instructions, then select it using `/agent designer`. Profiles provide guidance and use the tools exposed by the runtime. Keep secrets out of profile files.
