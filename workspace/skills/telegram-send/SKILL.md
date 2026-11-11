---
name: telegram-send
description: |
  Fast one-off Telegram DM sending from the owner's MTProto account. Use when
  the owner asks to message, write, text, reply, or send a Telegram DM to a
  specific existing visible chat/person and the action is a simple direct send.
  For reading, searching, media, groups, channels, scheduling, forwarding, admin
  actions, public lookup, or routing decisions, use the broader telegram skill.
metadata:
  {"openclaw": {"emoji": "✉️"}}
---

# Telegram Send

Use this skill only for simple one-off Telegram DMs from the owner's account to
an existing visible chat/person.

For broader Telegram work, use `telegram`.

## Fast Path

The `tg-watcher` daemon keeps a persistent MTProto session open. Use its wrapper
instead of Telegram Web, generic message tools, inline Python, or ad hoc
Telethon:

```sh
tg-send resolve --query "<visible chat name>"
tg-send send --query "<visible chat name>" --text "<message>"
```

This resolves existing dialogs by visible dialog/entity name by default. Public
username lookup is allowed only when the owner explicitly provides an
`@username`.

## Saved Messages (self-chat)

In Telegram, "Saved Messages" is not a special destination — it is the chat with
your own account. So the owner's own numeric user id IS the Saved Messages
target, and a normal send reaches it:

```sh
tg-send send --peer-id <owner numeric user id> --text "<message>"
```

The owner refers to it as: Saved Messages, Избранное, Сохранённые, or in Uzbek
o'zimga / o'zimning xabarlarim ("to myself").

Do NOT resolve Saved Messages with `tg-send resolve --query "Saved Messages"` —
its dialog title is localized to the account's language, so the query is
unreliable. Use the numeric id directly.

The `jarvis` direct-command prompt supplies the owner's id, so prefer the id you
were given over looking it up.

## Resolution Rules

- For a normal person or chat name, resolve exact existing visible-dialog
  matches first:
  `tg-send resolve --query "<name>"`.
- If there is exactly one clear match and message text is present, send.
- If there are multiple matches, ask which one before sending.
- If there is no exact match, do not guess a public username. Ask for a clearer
  visible name, `@username`, phone, or numeric peer id.
- If the owner explicitly provides an `@username`, pass it as the query.
- Use `--partial` only to list candidates or when the owner asks for partial
  search.
- Use `--allow-ambiguous` only after the owner explicitly selected or confirmed
  the target.

## Safety Rules

Ask before sending when:

- Message text is missing.
- A private chat, group, and channel all plausibly match.
- The target appears to be a group/channel and the request did not clearly say
  to post there.
- The send is bulk, sensitive, or to a new external recipient.

Never use Telegram Web for this workflow unless the owner explicitly asks for
Telegram Web UI behavior or `tg-send` is unavailable and direct Telegram MCP
cannot complete the task.

Never spawn inline Python/Telethon for this workflow unless `tg-send` reports
the watcher is unreachable and Telegram MCP is unavailable or insufficient.

## Examples

Exact visible name:

```sh
tg-send resolve --query "Ali Karimov"
tg-send send --query "Ali Karimov" --text "Hello, test message from AI"
```

Candidate lookup without sending:

```sh
tg-send resolve --query "Ali" --partial
```

Known peer id:

```sh
tg-send send --peer-id <peer-id> --text "Hello"
```

## Why

This is the fastest current path for simple existing-chat DMs because it reuses
the already-connected MTProto client in `tg-watcher`; there is no browser
startup, Python startup, new MTProto login, or repeated dialog warmup.
