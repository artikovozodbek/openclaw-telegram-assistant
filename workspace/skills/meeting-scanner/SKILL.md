---
name: meeting-scanner
description: One-shot meeting watcher. The tg-watcher MTProto daemon listens on the CEO's Telegram; whenever a CEO outgoing DM contains the trigger keyword "meeet" (triple-e), it fetches the chat backlog, transcribes voice notes, and fires one agent turn that classifies the conversation and (if a real meeting is present) creates/updates a Google Calendar event with a T-5min voice reminder.
metadata:
  {"openclaw": {"emoji": "📅"}}
---

# Meeting Scanner (v2 — one-shot trigger)

No activation keyword. No stop keyword. No persistent watches. No polling.

```
CEO's Telegram (MTProto, user-session)
            │
            │  live updates
            ▼
tg-watcher daemon
  On every CEO outgoing DM message:
   - does the text contain "meeet"?  yes ─┐
                                         ▼
   - already processed? (chat, msgId)  no ─┐
                                          ▼
   - fetch last 100 messages / 7 days from chat
   - download + transcribe all voice notes (Gemini)
   - write normalized conversation to
     conversations/<chatId>-<triggerMsgId>.json
   - log the trigger in meeting_watch.json
   - spawn ONE agent turn
            │
            ▼
Agent turn (you):
   - read SKILL.md + state + conversation
   - list other events in same chat (for update/cancel detection)
   - classify: no_meeting | candidate | confirmed | updated | cancelled
   - act: create/update/delete Calendar event (CDP)
   - schedule T-5min cron reminder
   - send CEO confirmation via bot
            │
            ▼
Done. The same chat can trigger again later with a new "meeet".
```

Every `meeet` is atomic and self-contained. No mutable "state per chat" beyond the log of past events.

## Trigger rule

- The daemon watches **only** for CEO outgoing messages in DMs (not groups, not channels)
- The message text must contain the keyword (default `meeet`, case-insensitive)
- The first time a particular `(chatId, triggerMessageId)` is seen, the daemon processes it. The same message id is never processed twice.

## State file

`workspace/agents/default/data/meeting-watch/meeting_watch.json` — single source of truth. Shape:

```json
{
  "version": 2,
  "trigger": { "keyword": "meeet" },
  "events": [
    {
      "chatId": "...",
      "chatTitle": "...",
      "triggerMessageId": "...",
      "triggerText": "...",
      "triggeredAt": "...",
      "processedAt": "...",
      "status": "pending | scheduled | cancelled | no_meeting | ...",
      "conversationFile": "...",
      "conversation": { "messageCount": 42, "voiceCount": 3, ... },
      "analysis": { "status": "confirmed_meeting", "title": "...", "startAt": "...", ... },
      "calendar": { "status": "created", "calendarEventId": "...", "eventUrl": "...", "meetLink": "...", ... },
      "reminders": [ { "kind": "before_5m", "jobId": "...", "at": "..." } ],
      "confirmationSentAt": { "created": "..." }
    }
  ]
}
```

Only the daemon and the agent write through `watcher.js`. Never touch the JSON file directly.

`conversationFile` = per-trigger normalized snapshot in `conversations/<chatId>-<triggerMsgId>.json`.

## State CLI (`watcher.js`)

```
watcher.js init
watcher.js is-processed       --chat-id X --trigger-msg-id N
watcher.js log-trigger        --chat-id X --chat-title "…" --trigger-msg-id N --trigger-text "…" --triggered-at ISO
watcher.js get                --chat-id X --trigger-msg-id N
watcher.js list               [--chat-id X] [--limit N]
watcher.js save-conversation  --chat-id X --trigger-msg-id N --data-file path
watcher.js record-analysis    --chat-id X --trigger-msg-id N --data-file path
watcher.js record-calendar    --chat-id X --trigger-msg-id N --status created|updated|cancelled --calendar-event-id ID --event-url URL --meet-link URL --start-at ISO --end-at ISO --title "…" --location-type online|offline --location-text "…"
watcher.js record-reminder    --chat-id X --trigger-msg-id N --kind before_5m --job-id JOB --at ISO
watcher.js mark-confirmation  --chat-id X --trigger-msg-id N --kind created|updated|cancelled --at ISO
watcher.js prune              [--days 180]
```

**Every write call MUST carry `--chat-id X --trigger-msg-id N`** — that's the event's primary key.

## Agent flow (when invoked by daemon)

The daemon spawns the agent with a prompt that specifies `chatId` and `triggerMessageId`. You must:

### 1. Read context
```
read /home/node/.openclaw/workspace/skills/meeting-scanner/SKILL.md
exec node .../watcher.js get --chat-id <X> --trigger-msg-id <N>
read /home/node/.openclaw/workspace/agents/default/data/meeting-watch/conversations/<X>-<N>.json
exec node .../watcher.js list --chat-id <X>          # prior events in same chat
```

The conversation is already normalized: `{version, chat, trigger, messages[{messageId, timestamp, senderRole: ceo|counterparty, direction, kind: text|voice|audio|..., text, transcript, searchableText, hasMedia}], summary}`.

Voice messages have their transcript under `transcript`. The search should use `searchableText` which merges text + transcript.

### 2. Classify

Read the ENTIRE conversation. The trigger word is a bookmark — the meeting details can be anywhere in the captured backlog, from either party, in text or voice.

Produce analysis JSON (write to `/tmp/openclaw/uploads/meeting_analysis_<X>_<N>.json`):

```json
{
  "status": "no_meeting | candidate_meeting | confirmed_meeting | updated_meeting | cancelled_meeting",
  "title": "...",
  "participants": ["Owner", "Counterparty Name"],
  "startAt": "2026-04-16T15:00:00+05:00",
  "endAt":   "2026-04-16T16:00:00+05:00",
  "durationMinutes": 60,
  "locationType": "online | offline",
  "locationText": "Google Meet" /* or physical address */,
  "needsGoogleMeet": true,
  "summary": "Краткое описание",
  "evidenceMessageIds": ["1033", "1035"],
  "confidence": "low | medium | high"
}
```

Classification rules:
- `confirmed_meeting` requires ALL of: bilateral agreement, resolvable datetime in Asia/Tashkent, clear participants.
- Bilateral agreement can be minimal — e.g., counterparty proposes, CEO says "ok" → confirmed. Either side can propose.
- `updated_meeting` is valid ONLY if an earlier event in this same chat (from `list --chat-id`) already has `calendar.calendarEventId`, AND this trigger's details meaningfully change it (time/location/title).
- `cancelled_meeting` is valid ONLY if an earlier event exists AND the conversation explicitly cancels it.
- Past datetime → never `confirmed`/`updated`. If only candidate time is in the past → use `candidate_meeting`.
- Doubt → `candidate_meeting`. Doing nothing is safe; creating the wrong event is not.

Save:
```
exec node .../watcher.js record-analysis --chat-id <X> --trigger-msg-id <N> --data-file /tmp/openclaw/uploads/meeting_analysis_<X>_<N>.json
```

### 3. Act on the status

#### confirmed_meeting (no prior calendarEventId for this trigger)
1. Open in CDP browser:
   `https://calendar.google.com/calendar/r/eventedit?text=ENCODED_TITLE&dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS&details=ENCODED_DETAILS`
2. snapshot → if `needsGoogleMeet` and `locationType=online`, click "Add Google Meet video conferencing"
3. snapshot → verify Meet link captured
4. Click "Save" (ARIA labels, never CSS classes)
5. Navigate to the event to grab `eid=` from URL → decode if needed → that's `calendarEventId`
6. `watcher.js record-calendar --chat-id <X> --trigger-msg-id <N> --status created --calendar-event-id ... --event-url ... --meet-link ... --start-at ... --end-at ... --title "..." --location-type ... --location-text ...`
7. **Schedule the reminder cron** — use the `cron` tool directly, NOT the `exec` CLI. Exact shape:
   ```
   cron:
     action: add
     job:
       name: "meet-remind-<X>-<YYYYMMDDTHHMM>"
       schedule: { kind: "at", at: "<startAt minus 5 minutes, ISO>" }
       session: "isolated"
       deleteAfterRun: true
       message: "<reminder prompt — see template below>"
   ```
   Capture the returned `jobId` from the tool result.
8. `watcher.js record-reminder --chat-id <X> --trigger-msg-id <N> --kind before_5m --job-id <jobId> --at <startAt-5m>`
9. `watcher.js mark-confirmation --chat-id <X> --trigger-msg-id <N> --kind created --at <ISO>`
10. Send CEO confirmation via `message` tool (see template)
11. `NO_REPLY`

#### updated_meeting (prior event in same chat, time/title/location changed)
1. Open `https://calendar.google.com/calendar/r/eventedit/<calendarEventIdOfPriorEvent>` in CDP
2. Edit changed fields, save
3. `record-calendar --status updated --calendar-event-id <same>` on the CURRENT trigger's event record (not the prior one)
4. If `startAt` changed: `cron rm <oldJobId>` then schedule new T-5min cron → `record-reminder`
5. `mark-confirmation --kind updated`
6. Send CEO "Обновлено" message

#### cancelled_meeting (prior event, conversation cancels)
1. Delete the calendar event (open it, delete)
2. `cron rm <reminder jobId>` if pending
3. `record-calendar --status cancelled` on current event
4. `mark-confirmation --kind cancelled`
5. Send CEO cancellation message

#### candidate_meeting / no_meeting
Just `record-analysis` and exit with `NO_REPLY`. No calendar action, no message to CEO. The next `meeet` in the same chat (or more messages before) will re-trigger the analysis.

### 4. Idempotency & dedup

- Before sending any CEO confirmation, check `event.confirmationSentAt[kind]`. If already set for this kind on this event, skip.
- The daemon's `is-processed` check guarantees a given trigger message fires once. If you crash mid-flow and are re-invoked, treat missing `confirmationSentAt` as permission to send.

## Templates

### Meet link rule (applies to BOTH templates below)

The `🔗 Google Meet: …` line appears **only when `calendar.meetLink` is a real URL** (starts with `https://meet.google.com/`). For offline meetings, or when no Meet link was created, **omit the entire line** — do not include placeholders like `—`, `no`, `offline`, etc.

### Reminder prompt (passed via `cron` tool's `message` field)
```
Ты — JARVIS. Напомни сэру о встрече. Работай МОЛЧА.

1) exec mkdir -p /tmp/openclaw/uploads
2) exec node /home/node/.openclaw/workspace/skills/tts-send/tts-send.js "[matter-of-fact] Сэр, через 5 минут встреча «<TITLE>». <LOCATION>. <PARTICIPANTS>." /tmp/openclaw/uploads/meet_remind_<X>_<N>.mp3
3) message:
   channel: telegram
   to: <CEO_TG_ID>
   message: <see format below>
   buttons: []
4) message:
   channel: telegram
   to: <CEO_TG_ID>
   media: /tmp/openclaw/uploads/meet_remind_<X>_<N>.mp3
   asVoice: true
   buttons: []
5) NO_REPLY
```

Reminder text body — build conditionally:
```
📅 Через 5 минут встреча «<TITLE>».
📍 <LOCATION>
👥 <PARTICIPANTS>
[if meetLink present:] 🔗 <MEET_LINK>
```

### CEO confirmation message (created)

Build conditionally — omit the Meet line entirely when offline or no link:

Online with real Meet link:
```
📅 Встреча: <TITLE>
🕐 <DD.MM.YYYY HH:MM> (Asia/Tashkent)
📍 <LOCATION_TEXT>
👥 <PARTICIPANTS>
🔗 Google Meet: <MEET_LINK>

Календарь ✓ Напоминание за 5 минут ✓
```

Offline (or online without a captured Meet link):
```
📅 Встреча: <TITLE>
🕐 <DD.MM.YYYY HH:MM> (Asia/Tashkent)
📍 <LOCATION_TEXT>
👥 <PARTICIPANTS>

Календарь ✓ Напоминание за 5 минут ✓
```

- For `updated`: prepend "Обновлено:" and mention what changed
- For `cancelled`: "Встреча отменена. Напоминание удалено."

## Hard rules

- DM only. Never groups/channels.
- CEO outgoing only (the daemon already filters this; the agent can assume).
- Past meetings → never create/update. Agent classifies as `no_meeting` or `candidate_meeting`.
- ARIA labels for Google Calendar UI; Telegram is entirely handled by the daemon.
- All writes to `meeting_watch.json` go through `watcher.js`. Never edit the file directly.
- Agent prompt ALWAYS carries `chatId` and `triggerMessageId`; every `watcher.js` write call must include both.

## Operations

### Daemon control
```
docker compose logs -f tg-watcher
docker compose restart tg-watcher
docker compose stop tg-watcher
```

### Disabling agent invocation (keep capture, no acting)
Set `OPENCLAW_AGENT_TRIGGER=skip` in `.env`, restart `tg-watcher`. The daemon still fetches + transcribes + saves, but doesn't spawn the agent. Useful for debugging.

### Reset everything (wipe history)
```
rm workspace/agents/default/data/meeting-watch/meeting_watch.json
rm workspace/agents/default/data/meeting-watch/conversations/*.json
docker compose restart tg-watcher
```
