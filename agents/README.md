# Agent profiles

Each `.md` file in this directory is a role profile. The filename (without `.md`) is its name. Profiles provide role guidance; tools are provided by the agent runtime.

Available tools currently include:
- Workspace file listing, reading, and writing.
- Public web search and readable-page fetching.
- GitHub REST API access (public endpoints; private repositories if `GITHUB_TOKEN` is configured).
- Project-local dependency installation with npm, pnpm, yarn, or bun.
- Controlled command execution for project setup, tests, builds, and Git operations.

Create a profile such as `designer.md`, then use `/agent designer` in Telegram. Keep secrets out of profiles. Treat profile instructions as trusted because they influence agent behavior.
