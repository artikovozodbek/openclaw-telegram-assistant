---
name: instagram-web
description: Instagram browser automation — post photos, read/send DMs, check notifications. Use when user mentions Instagram, IG, posting photos, or DMs.
---

# Instagram Web Automation

URL: `https://www.instagram.com/`
Account: already logged in via Chrome CDP.

## Post a Photo

1. Navigate to `https://www.instagram.com/`
2. `snapshot` — find the "Create" or "+" icon in left sidebar
3. Click Create → click "Post" in dropdown
4. Modal appears: "Drag photos and videos here" + "Select from computer" button
5. Use `upload` action on the hidden file input (NOT click "Select from computer")
6. After upload: crop screen → click "Next"
7. Filters screen → click "Next"
8. Caption screen → click caption textarea → type caption
9. Click "Share"

**Important:** Use `upload` browser action for file input, not clicking the select button.

## Read DMs

1. Navigate to `https://www.instagram.com/direct/inbox/`
2. `snapshot` — left panel = conversation list, right panel = active chat
3. Click a conversation to open
4. `snapshot` to read messages
5. To reply: click message input at bottom → type → Enter or Send

## Send a New DM

1. Navigate to DM inbox
2. Click the compose/new message icon (pencil icon)
3. Search for username → select user
4. Click "Chat" → type message → Send

## Check Notifications

1. From main page, `snapshot` — find heart icon in left sidebar
2. Click it — notification panel slides out
3. `snapshot` to read

## Gotchas

- **Cookie consent banner** — dismiss before interacting
- **Dynamic DOM** — Instagram uses React with obfuscated classes. Use accessibility tree from snapshots
- **Cannot post Stories or Reels** from desktop web — only regular photo/video posts
- **After any element error** → re-snapshot immediately
- **Rate limiting** — add realistic delays between actions (2-3 seconds)
