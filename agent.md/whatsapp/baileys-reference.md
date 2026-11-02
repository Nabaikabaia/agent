# Baileys Reference

## Source of truth

- Official repository: https://github.com/WhiskeySockets/Baileys
- Official documentation: https://baileys.wiki
- Migration guide: https://whiskey.so/migrate-latest
- npm package: https://www.npmjs.com/package/@whiskeysockets/baileys

The current integration pins `@whiskeysockets/baileys` to `7.0.0-rc14`. Baileys 7 contains breaking changes. Always inspect the installed package version and its own declarations before writing code. Do not copy v6 examples without checking migration notes.

## Connection lifecycle

- The linked WhatsApp account is Nabees's sending/receiving identity.
- The separately configured controller number is the only private chat authorised to control Nabees.
- Pairing is initiated from the Telegram owner's private chat with `/pair`.
- The owner supplies the linked account's international phone number and their controller phone number.
- Use WhatsApp **Linked devices → Link with phone number** and enter the returned pairing code.
- Auth files live under `.agent-state/whatsapp-auth/`; never commit or print them.
- The owner JID is persisted in `.agent-state/whatsapp-owner.json`.

## Events

The controller listens to `connection.update`, `creds.update`, and `messages.upsert`. Reconnect after transient disconnects; do not reconnect after a logged-out status. Ignore group chats, messages from the linked account itself, and any private sender other than the configured owner JID.

## Existing built-in operations

The initial adapter exposes messaging, group listing and metadata, group setting changes, participant actions, invite links, and block-list operations. Check the live method list before assuming an operation exists.
