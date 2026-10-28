# Nabees Autonomous Agent

Node.js autonomous agent powered by OpenRouter (configurable with an OpenAI-compatible API). It accepts natural-language tasks through Telegram and uses tools to research, inspect files, install project dependencies, work with GitHub, and run project checks.

## Capabilities

- Natural-chat Telegram control with Rich Messages/button callbacks, dynamic choice buttons, owner-only package-install approval prompts, and Markdown profiles in `agents/*.md`.
- Dynamic in-message choice prompts: the agent can pause a task, ask the owner a question with 2–8 context-specific buttons, and continue using the selected answer. Prompts expire after a timeout.
- Workspace file listing, reading, and writing.
- Public web search and readable-page fetching.
- Persistent Nabees identity across task and chat prompts; bounded specialist subagents can be spawned by the main agent only, and subagents cannot create further agents.
- Independent Telegram task sessions: send another task while earlier tasks run, and use `/status` or `/tasks` to inspect active work. Each task gets its own context snapshot and checkpoint.
- Patchright-controlled Chromium with DOM snapshots, JavaScript evaluation, form interaction, upload/download handling, screenshots, links, images, navigation history, tab management, and captured request/response network inspection.
- Send a document, image, audio clip, video, voice note, animation, or sticker to the bot in its private Telegram chat to upload it into `workspace/inbox/` and ask the agent to analyse it. Add a caption to give a specific instruction; otherwise it will attempt a general analysis. Text/code, JSON, CSV, and common office formats (PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, RTF, EPUB) get automatic text extraction where supported; extracted text is capped at 60,000 characters. Images and media are stored for tool-based inspection, but vision/OCR depends on available tools and is not guaranteed. Telegram cloud downloads are limited to 20 MB per file. Unsupported or encrypted formats are stored when Telegram permits, but the agent must report extraction limitations rather than inventing contents.
- Browser downloads and screenshots saved under the configured workspace, with Telegram photo delivery for screenshots and document delivery for downloadable files sent to the configured owner. Document delivery is limited to files in the configured workspace, blocks common secret/key files, and enforces a 45 MB limit.
- GitHub REST API access for repositories, contents, commits, issues, pull requests, releases, and search.
- Owner-requested private-repository updates using `GITHUB_TOKEN`, with fixed-origin validation, a clean-working-tree check, and fast-forward-only pulls.
- Project-local package installation with npm, pnpm, yarn, or bun.
- Controlled one-command-at-a-time execution for development, tests, builds, and Git inspection.
- Local task checkpoints and short-lived conversational context. Agent work automatically continues across up to three batches when it reaches `AGENT_MAX_STEPS`, with a maximum of 60 model steps per task.


## Installable agent skills

The owner can install skills from Telegram by sending a command such as:

```text
install this skill npx rea-agents setup
install this skill npx skills add https://github.com/Leonxlnx/taste-skill --skill design-taste-frontend
```

The agent validates supported installer commands and asks for explicit owner approval before running them. It supports `npx rea-agents setup` and `npx skills add` from a GitHub repository, with optional `--skill` and `--agent` options. It does not support arbitrary shell commands through this feature.

After installation, the agent discovers `SKILL.md` instructions in workspace skill directories such as `.agents/skills/`, `.claude/skills/`, `.codex/skills/`, `.opencode/skills/`, and `skills/`, plus supported home-level skill directories. At the start of a task it provides the agent with a skill index; the agent can read the full instructions for relevant skills using `read_skill`. Third-party skill files are treated as untrusted guidance and cannot override the agent's security policy.

Tools: `list_skills`, `read_skill`, and `install_skill`.

## Browser backends and network inspection

Patchright is the default browser automation backend. It is a Playwright-compatible, Chromium-focused alternative designed to reduce common automation-detection signals. The browser adapter runs Chromium locally inside the Box and does not require a hosted browser service or a separate browser daemon. For a separately installed Chrome/Chromium instance, Nabees can connect through Chrome DevTools Protocol when you configure `BROWSER_CDP_URL`.

Install dependencies and the Chromium build with:

```sh
npm install
npm run browser:install
```

The installer downloads the Chromium build used by Patchright. The Box must also provide the operating-system libraries required by Chromium. On Linux ARM64, use the Chromium build rather than the Google Chrome installer; the Chrome installer has had ARM64 limitations. Patchright can reduce some automation signals, but it does not guarantee access to every site and must not be used to bypass CAPTCHAs or other access-control challenges.

The browser tools support opening/navigating/listing tabs, DOM snapshots, click/type/press/scroll/wait, page-context JavaScript evaluation, native select changes, file upload, screenshots, links, images, downloads, back/forward, refresh, and tab closing. `browser_network` inspects captured requests, response status codes, failures, redacted headers, and optionally text/JSON response bodies. Body inspection is opt-in and truncated. Downloads and screenshots are saved under the configured workspace.

To attach to a separately running Chrome/Chromium instance, launch it with remote debugging enabled and set `BROWSER_CDP_URL` to its DevTools WebSocket endpoint in `.env`. Keep the endpoint private; anyone who can access it may control the browser and inspect its logged-in session. `browser_connect_external` reports an error if no endpoint is configured or connection fails.

`BROWSER_ALLOW_LOCALHOST=false` remains the default. Browser HTTP(S) requests to private/local network targets and metadata hosts are blocked by default.
## Chat providers

- Ordinary conversational messages (for example, greetings and general questions) use the previously shared Android ChatGPT anonymous endpoint through `src/gpt5.js`; this path does not use the OpenRouter API key or its free-model quota.
- Tool-using tasks and autonomous planning continue to use the OpenRouter-compatible endpoint configured in `.env`.
- The Android ChatGPT endpoint is undocumented and is **not an official OpenAI API**. It can change, fail, or impose separate limits. It does not provide tool calling to this agent; autonomous tool execution remains handled by the agent loop.

## Setup

Requires Node.js 20+ and a running Box/workspace.

1. Copy `.env.example` to `.env`.
2. Create an API key at [OpenRouter](https://openrouter.ai/keys) and set `OPENROUTER_API_KEY` in `.env`. The default model is `nvidia/nemotron-3-ultra-550b-a55b:free`; free model availability and quotas can change. You can set `OPENROUTER_MODEL` to another model from the OpenRouter catalog. Slow models can use `AI_REQUEST_TIMEOUT_MS=300000` (5 minutes; maximum 600000 ms).
3. Install dependencies and Chromium: `npm install` then `npm run browser:install`.
4. Create a bot with Telegram **@BotFather** and find your numeric Telegram user ID.
5. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`.
6. Optional: set `GITHUB_TOKEN` to a fine-grained token with **Contents: Read-only** access to `Nabaikabaia/agent` for private repository API access and authenticated updates. Public GitHub API access works without it. Keep the token only in `.env`.

Never paste credentials into chat or commit `.env`.

## Run

```sh
npm run check
npm run telegram
```

Send `/start` to the bot, then chat normally. Telegram replies use Rich Messages with native buttons for Status, Help, and Profiles. During a task, the agent can also create custom choice buttons when it needs your decision; selecting one resumes the paused task. In groups, `/start` or `/help` posts a small menu; tapping its buttons returns an ephemeral response visible only to the person who tapped it. Task execution and profile switching remain restricted to the configured owner's private chat. Rich Messages require a Telegram Bot API server that supports them; if `sendRichMessage` is unavailable, the controller falls back to regular messages with inline callback buttons. During task execution, the controller maintains one Telegram progress message with an expandable blockquote containing the task, profile, and recent agent/tool steps. It edits that message as work proceeds, then sends the final answer separately. Set `AI_REQUEST_TIMEOUT_MS` in `.env` to change the AI provider request timeout (default 300000 ms / 5 minutes; allowed range 30 seconds–10 minutes). Ephemeral replies require a compatible Bot API server. Example tasks:

- Inspect this project, install its dependencies, run its tests, and fix errors.
- Research a library, read its documentation, inspect its GitHub repository, and assess whether it fits my project.
- Clone my public repository into the workspace and explain its structure.

The Telegram controller stores recent conversation context and can run multiple independent task sessions concurrently. Use `/status` or `/tasks` to list active sessions. Each task receives its own context snapshot; new tasks can be submitted without waiting for existing tasks to finish. In-flight work is not automatically resumed after a process restart. `AGENT_MAX_STEPS` sets the size of each model-step batch; if a task is still underway at a batch boundary, the agent automatically continues from the current tool results for up to three batches (maximum 60 model steps total). Package installation requests pause until the configured owner taps **Approve** or **Reject**. Approval records are stored in `.agent-state/package-approvals.json`; expired, stale, or interrupted requests never install a package. If the process restarts, an in-flight task cannot resume automatically, so its pending request is marked interrupted and must be requested again.

## Commands

- `/agents` — list profiles.
- `/agent coder`, `/agent researcher`, `/agent general` — switch profile.
- `/agent` — show active profile.
- `/status` — check progress.
- `/help` — show commands.
- `/task <task>` — explicit task submission.

## Tool boundaries

- Package installation is project-local; global installs are unsupported. Each package installation request requires explicit owner approval in Telegram. Rejecting, timing out, or restarting while awaiting a decision does not install the package.
- Commands run without a shell, have a supported executable list, timeouts, and output limits. Pipes and redirections are unsupported.
- Patchright-controlled Chromium renders JavaScript-heavy pages and can interact with ordinary page controls. Screenshots are saved to disk and can be sent to the configured Telegram owner using `send_telegram_photo`; image-based reasoning depends on the configured model supporting vision, which is not assumed by this code.
- Browser HTTP(S) requests to private/local network targets and metadata hosts are blocked by default. Do not enable local access except in a trusted development workflow.
- GitHub API access supports public repository endpoints; private access needs `GITHUB_TOKEN`.
- When the owner requests an agent update, `update_repository` uses `GITHUB_TOKEN` only for the fixed `https://github.com/Nabaikabaia/agent` origin. It refuses uncommitted local changes and uses `git pull --ff-only`; it does not configure a credential-bearing remote URL, print the token, or automatically update on every push. The workspace must already be a Git clone with that HTTPS origin.
- Dependency installation and project scripts can execute third-party code. Inspect unfamiliar scripts and use a disposable, isolated container for untrusted code.
- The agent must ask before deployment, remote pushes, destructive operations, credential changes, purchases, or other high-impact actions. It must not bypass CAPTCHAs or other anti-abuse/access-control protections. Tool restrictions are not a full OS sandbox.

## Create profiles

Add `agents/designer.md` with role-specific instructions, then select it using `/agent designer`. Profiles provide guidance and use the tools exposed by the runtime. Keep secrets out of profile files.
