---
name: gmail
description: Gmail browser automation — read inbox, compose emails, search mail. Use when user mentions email, Gmail, inbox, or wants to send/read emails.
---

# Gmail Automation

URL: `https://mail.google.com/mail/u/0/#inbox`
Account: whatever Gmail your Chrome profile is signed into

## Read Inbox

1. Navigate to or switch tab to Gmail inbox
2. `snapshot` — email list shows sender, subject, snippet, date
3. Click an email to open it
4. `snapshot` to read full content
5. Navigate back to inbox when done

## Compose an Email

1. `snapshot` — find "Compose" button in left sidebar
2. Click Compose — floating compose window opens at bottom-right
3. `snapshot` — find To field, Subject field, Body area
4. Click "To" field → type recipient email
5. Click "Subject" field → type subject
6. Click body area (`contenteditable` div with `aria-label="Message Body"`) → `type` the message
7. Click "Send"

## Search Mail

1. `snapshot` — find search bar at top (`aria-label="Search mail"`)
2. Click search bar → type query → Enter
3. Results appear in main email list

## Reply to an Email

1. Open the email
2. `snapshot` — find "Reply" button at bottom of email
3. Click Reply — reply box appears
4. `type` your reply in the body area
5. Click "Send"

## Gotchas

- **Obfuscated DOM** — Gmail uses Closure Compiler. NEVER use CSS class selectors. Always use ARIA labels: `aria-label="Compose"`, `aria-label="Message Body"`, `aria-label="To recipients"`, `aria-label="Search mail"`
- **Body is `contenteditable`** — use keyboard `type` action, not DOM manipulation
- **Compose window may be inside iframe** — check frame context
- **Auto-save drafts** — can cause DOM mutations while interacting
- **After any element error** → re-snapshot immediately
