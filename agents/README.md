# Agent profiles

Each Markdown file in this directory defines the role and working instructions for one agent profile. The filename (without `.md`) is the profile name.

Included profiles:
- `general.md` — general-purpose tasks (default)
- `coder.md` — software engineering
- `researcher.md` — web research and evidence synthesis

Add your own profile by creating a file such as `designer.md` with a short heading and clear instructions. Then restart or keep running the controller (profiles are loaded for each new task) and select it in Telegram with `/agent designer`. Use `/agents` to list available profiles.

Treat profile files as trusted instructions: anyone who can edit them can change how the agent behaves. Do not put API keys, passwords, or other secrets in profile files.
