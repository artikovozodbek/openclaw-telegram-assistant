---
name: telegram-web
description: Telegram Web fallback only. Use only when the user explicitly asks for Telegram Web/browser UI, or after reading the telegram skill and confirming Telegram MCP/MTProto/telegram-send cannot complete the action.
---

# Telegram Web Automation

## Hard Gate

For any Telegram request, first read and follow:

```text
/home/node/.openclaw/workspace/skills/telegram/SKILL.md
```

For simple one-off DMs, also read and follow:

```text
/home/node/.openclaw/workspace/skills/telegram-send/SKILL.md
```

Do not navigate to `https://web.telegram.org/k/`, inspect Telegram Web tabs, or
use browser automation for normal Telegram reading/sending/searching. Use this
skill only when:

- The owner explicitly asks for Telegram Web, browser UI, or visual browser
  behavior.
- The `telegram` skill has already been read and direct Telegram MCP/MTProto
  tooling is unavailable or insufficient for the specific action.

If this skill was selected for a normal Telegram task, stop and route to the
`telegram` or `telegram-send` skill instead.

URL: `https://web.telegram.org/k/` (Web K version — simpler DOM, better for automation)
Account: already linked to user's phone.

## Read Chats / Check Unread

1. Navigate to or switch tab to `https://web.telegram.org/k/`
2. `snapshot` — left sidebar shows chat list with unread badges (numbers)
3. Click on a chat to open it
4. `snapshot` to read messages in the center pane

## Send a Message

1. Open the target chat (click in sidebar or search)
2. `snapshot` — find the message input at bottom of center pane
3. Click the message input field (it's a `contenteditable` div, NOT an `<input>`)
4. Use `type` action to type the message (keyboard events, not DOM manipulation)
5. Press Enter to send (or click the Send button)

## Search for a Chat/Contact

1. `snapshot` — find the search bar at top of left sidebar
2. Click the search bar
3. Type the contact/group name
4. Click on the result

## Send Media

1. Open the target chat
2. Click the attach icon (paperclip) in the message input area
3. Use `upload` action for the file input
4. Add optional caption
5. Click Send

## Gotchas

- **Message input is `contenteditable`** — must use keyboard `type`, not `.value` assignment
- **Rich text**: Ctrl+B (bold), Ctrl+I (italic) work in the input
- **Web K vs Web A** — always use `/k/` path. DOM structures differ between versions
- **Session can expire** after ~14 days of inactivity
- **After any element error** → re-snapshot immediately
