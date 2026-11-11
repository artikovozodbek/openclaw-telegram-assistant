---
name: whatsapp-web
description: WhatsApp Web browser automation — read chats, send messages, check unread. Use when user mentions WhatsApp, WA, or messaging via WhatsApp.
---

# WhatsApp Web Automation

URL: `https://web.whatsapp.com/`
Account: already paired to user's phone.

## Read Chats / Check Unread

1. Navigate to or switch tab to WhatsApp Web
2. `snapshot` — left panel shows chat list. Unread chats have green badge with count
3. Click on a chat to open it
4. `snapshot` to read messages in right panel
5. Scroll up for older messages

## Send a Message

1. Open the target chat (click in left panel or search)
2. `snapshot` — find message input at bottom of right panel
3. Click the message input (it's a `contenteditable` div)
4. Use `type` action to type the message (keyboard events)
5. Press Enter to send

## Search for a Contact/Chat

1. `snapshot` — find search bar at top of left panel
2. Click search bar → type contact name or phone number
3. Click on the result to open chat

## Send Media

1. Open the target chat
2. Click the attach button (+ or paperclip icon) near message input
3. Select media type (Photos & Videos, Document, etc.)
4. Use `upload` action for the file input
5. Add optional caption in the preview
6. Click Send (green arrow)

## Gotchas

- **QR pairing already done** — session persists in Chrome profile. If expired (~14 days inactivity), user must re-scan QR
- **Message input is `contenteditable`** — must use keyboard `type`, not `.value`
- **Encryption notice** — "Messages are end-to-end encrypted" banner at top of new chats, can be ignored
- **Phone number format** — include country code when searching by number
- **After any element error** → re-snapshot immediately
