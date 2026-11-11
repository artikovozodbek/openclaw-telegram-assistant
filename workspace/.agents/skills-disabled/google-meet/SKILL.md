---
name: google-meet
description: Google Meet browser automation — start instant meetings, get share links, end meetings. Use when user mentions Meet, video call, meeting link.
---

# Google Meet Automation

URL: `https://meet.google.com/`
Account: whatever Google account your Chrome profile is signed into

## Start an Instant Meeting

1. Navigate to `https://meet.google.com/`
2. `snapshot` — find "New meeting" button
3. Click "New meeting" — dropdown appears:
   - "Create a meeting for later" → generates link without joining
   - "Start an instant meeting" → creates and joins immediately
   - "Schedule in Google Calendar" → redirects to Calendar
4. Click desired option
5. `snapshot` — dialog shows the meeting URL (`https://meet.google.com/xxx-xxxx-xxx`)
6. Extract and share the URL

## Get a Share Link (without joining)

1. Click "New meeting" → "Create a meeting for later"
2. The link appears in a dialog — copy it

## End a Meeting

1. While in meeting, `snapshot` — find the Leave/End button at bottom center (red phone icon)
2. Click it

## Gotchas

- **Mic/camera permission prompts** — may appear, dismiss them
- **Pre-join screen** — after starting, shows camera preview + "Join now" button. Must click "Join now" to actually enter
- **"Microphone not found" dialog** — dismiss by clicking Close
- **After any element error** → re-snapshot immediately
