---
name: autonomous-browser-auth
description: Use Nabees' existing Playwright browser tools to handle website signup, login, account onboarding, authenticated web tasks, session-aware workflows, and step-by-step task reporting.
---

# Nabees Autonomous Browser & Authentication

## Purpose

When Sir asks Nabees to sign up, log in, complete onboarding, or do work on a website, use the existing browser tools and complete the task end-to-end where the site permits it. Do not merely provide instructions when you can perform the steps.

This skill is guidance for the browser tools already installed in Nabees. Do not claim capabilities that are not present in the runtime.

## Standard workflow

1. Identify the exact site and the requested outcome. If the user has not supplied a URL and the destination is ambiguous, ask one concise question.
2. Call `browser_list_tabs` before opening a new tab. Reuse an already-authenticated tab for the same site when appropriate.
3. If needed, call `browser_open` with the site URL. Use `browser_snapshot` to inspect visible text, links, buttons, and form fields before interacting.
4. Prefer existing authenticated sessions in open browser tabs. The current browser implementation does not provide a dedicated persistent storageState/session-file API; do not claim that a login will survive a browser restart unless the configured external browser itself preserves its profile.
5. For unknown sites, infer selectors from the current snapshot. Use `browser_fill` or `browser_type` for fields and `browser_click` for buttons. Use `browser_wait` when the page needs time to update, then take a fresh snapshot.
6. Verify the outcome from visible page state, URL, or a success message before reporting success. If the site requires profile completion, continue through it when it is part of the user's request.
7. For tasks after login, continue using the same authenticated tab and verify important changes before finishing.
8. If an action fails, inspect the latest snapshot and recover once or try a grounded alternative. Do not repeatedly click blindly or claim success without evidence.

## Signup and account creation

- Only create an account when Sir explicitly asks to create/register one or when it is a necessary, clearly implied step in the task.
- Prefer an email address and account details provided or approved by Sir. Ask before inventing identity details, using a real person's information, or choosing consequential account settings.
- Disposable inboxes may be used only where the website permits them and where they do not evade account limits, eligibility checks, or abuse prevention. The current runtime has no built-in temp.tf inbox client; do not claim one exists. If email verification is required and no supported inbox is available, ask Sir to provide an inbox or handle the verification step.
- Never print passwords, OTPs, recovery codes, session cookies, or tokens in ordinary progress messages. Do not place secrets in source files, logs, or task recordings.
- Do not create multiple accounts to evade quotas, bans, trial limits, or identity/eligibility requirements.
- Before clicking a final purchase, subscription, paid upgrade, public post, or other consequential irreversible action, ask Sir to confirm unless he has already clearly authorized that exact action.

## Login and verification

- Reuse an authenticated tab when available. If the session appears expired, use the site's normal login flow.
- Ask Sir for credentials or a one-time code only when genuinely required. Do not ask him to send passwords into public channels or save them in workspace files.
- For email magic links or OTPs, use an inbox Sir has authorized and can access. Verify that the message and link belong to the expected service before opening them.
- If the page presents a CAPTCHA or verification challenge, first inspect the available tools and installed skills for a configured, supported solver integration. If one exists, the site permits its use, and the challenge type is supported, invoke that solver tool and follow its documented interface; do not invent solver commands, APIs, or parameters. Keep API keys in configured secrets/environment variables, never in prompts, source files, or progress messages.
- A solver tool is not currently registered among this agent's built-in tools, so do not claim a solver is available merely because a skill mentions one. If no configured solver integration is found, wait briefly for ordinary browser verification and then ask Sir to complete the challenge through the site's normal verification flow.
- Do not forge or inject challenge tokens, defeat Turnstile or other anti-bot protections, or use a solver to evade site restrictions, quotas, eligibility checks, or account protections. For MFA or phone verification, use the site's supported flow and ask Sir for the required action when needed.
- Never describe a challenge as solved until the site visibly accepts it.

## Browser interaction rules

- Always inspect the page before acting on unfamiliar UI.
- Use `browser_snapshot` after navigation, form submission, authentication, and important state changes.
- Use the browser's supported tools instead of inventing functions such as `ensureLoggedIn`, `solveCaptchas`, `recordTask`, or `storageState` that are not available in this repository.
- Browser downloads are saved by the current browser tool under the workspace's `browser-downloads/` directory. Inspect `browser_downloads` to find them.
- Use `browser_screenshot` when a visual check would help.
- Browser JavaScript evaluation is for inspecting or interacting with the current page in the permitted scope; never use it to steal credentials, read unrelated private data, or defeat a site's access controls.
- Do not access localhost, private-network hosts, cloud metadata endpoints, or unrelated accounts through the browser.

## Recording and reporting

- The current runtime does not include the supplied Xvfb/FFmpeg tutorial recorder as a built-in tool. Do not claim an MP4 was recorded unless a supported recording implementation was actually installed and successfully produced the file.
- If Sir requests a recording and recording tools are unavailable, complete the browser task if possible, explain the limitation briefly, and offer a screenshot or concise step-by-step report instead.
- Report the site, completed actions, and verifiable result. Mention blockers plainly. Do not expose provider names, internal diagnostics, passwords, OTPs, cookies, or tokens.

## Example intents

- "Sign up for this service" -> inspect the URL and registration flow, ask for missing identity or inbox details, complete the allowed form, pause for human verification if needed, and verify the resulting account state.
- "Log in and download my report" -> inspect open tabs, reuse a valid session, log in through the normal flow if needed, locate the report, download it, and verify the downloaded file.
- "Complete my profile on this site" -> inspect the current profile page, update only the requested fields, save, and verify the displayed values.
- "Do this task on the website" -> navigate, inspect, perform the requested steps, and verify the final state.
- "Record this task" -> use a recording tool only if one is actually available; otherwise offer screenshots and a step-by-step report.
