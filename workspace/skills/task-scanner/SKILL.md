---
name: task-scanner
description: One-shot JIRA task watcher. Triggered by the word "taskk" in the CEO's Telegram DM. The tg-watcher MTProto daemon captures the chat backlog, transcribes voice notes, and fires this agent to extract task details, create a JIRA issue assigned to the DM counterparty, and post a confirmation message in that DM "as the CEO" (via MTProto send) plus a summary to the CEO via the bot.
metadata:
  {"openclaw": {"emoji": "📝", "requires": { "env": ["JIRA_URL", "JIRA_USERNAME", "JIRA_PASSWORD"] } }}
---

# Task Scanner

## Trigger

CEO sends an **outgoing** message in a **DM** that contains `taskk` (double-k). The daemon picks it up in real time via MTProto, fetches the last 20 messages (including transcribed voice notes), and spawns the agent with `chatId` and `triggerMessageId`.

There is no persistent watch state — each `taskk` is one atomic run. Re-sending the same trigger message is a no-op (deduped by `(chatId, triggerMessageId)`).

## Architecture

```
CEO & Team Member chat naturally in DM
  CEO: "Abror, sign off the EMU pricing page by Friday"
  Abror: "ok"
  CEO: "taskk"                             ← trigger
          │
          ▼
tg-watcher:
  - fetch last 20 msgs
  - transcribe voice notes via Gemini
  - save normalized conversation
  - spawn agent with task-scanner prompt
          │
          ▼
Agent (this skill):
  - extract task details from conversation
  - map counterparty → developer (developers.json)
  - resolve project key (jira projects → match context)
  - jira create --summary --description --assignee --due --sp --project
  - send confirmation IN THE DM as CEO via daemon's /send-as-ceo endpoint
  - send CEO a summary via the bot
  - NO_REPLY
```

The assignee is **the DM counterparty** — not the one whose name appears in the text of the message, but the actual Telegram user the CEO is DM'ing. That's the standing convention: "if you want to delegate, DM the person."

## State files

```
workspace/agents/default/data/task-scanner/
├── task_log.json                              # event log (single source of truth)
└── conversations/
    └── <chatId>-<triggerMsgId>.json           # per-trigger normalized conversation
```

Event shape in `task_log.json`:
```json
{
  "chatId": "...",
  "chatTitle": "...",
  "triggerMessageId": "...",
  "triggerText": "...",
  "triggeredAt": "...",
  "processedAt": "...",
  "status": "pending | extracted | created | unassignable | failed",
  "conversationFile": "...",
  "conversation": { "messageCount": 17, "voiceCount": 2, ... },
  "extraction": { "status": "ready|unassignable|...", "title": "...", "assigneeDev": {...}, "project": {...}, "dueDate": "...", ... },
  "jira": { "status": "created", "issueKey": "EMU-123", "issueUrl": "...", "assignee": "Abror", "projectKey": "EMU", "dueDate": "2026-04-19", "storyPoints": 5 },
  "notifications": {
    "assignee_mtproto": { "at": "...", "ref": "MSG_ID" },
    "ceo_bot":          { "at": "...", "ref": "MSG_ID" }
  }
}
```

All writes to `task_log.json` go through `task-watcher.js`.

## State CLI (`task-watcher.js`)

```
task-watcher.js init
task-watcher.js is-processed     --chat-id X --trigger-msg-id N
task-watcher.js log-trigger      --chat-id X --chat-title "…" --trigger-msg-id N --trigger-text "…" --triggered-at ISO
task-watcher.js get              --chat-id X --trigger-msg-id N
task-watcher.js list             [--chat-id X] [--limit N]
task-watcher.js save-conversation  --chat-id X --trigger-msg-id N --data-file path
task-watcher.js record-extraction  --chat-id X --trigger-msg-id N --data-file path
task-watcher.js record-jira        --chat-id X --trigger-msg-id N --status created --issue-key KEY --issue-url URL --assignee JIRA_ID --project-key KEY --due-date YYYY-MM-DD --sp N
task-watcher.js mark-notification  --chat-id X --trigger-msg-id N --kind assignee_mtproto|ceo_bot --at ISO --ref MSG_ID
task-watcher.js prune              [--days 180]
```

Every write call MUST carry `--chat-id X --trigger-msg-id N`.

## Agent flow (when invoked)

You'll be spawned with a prompt that contains `chatId`, `triggerMessageId`, and the path to the conversation file. Do the following IN ORDER:

### 1. Read everything
```
read /home/node/.openclaw/workspace/skills/task-scanner/SKILL.md
exec node /home/node/.openclaw/workspace/skills/task-scanner/scripts/task-watcher.js get --chat-id <X> --trigger-msg-id <N>
read /home/node/.openclaw/workspace/agents/default/data/task-scanner/conversations/<X>-<N>.json
read /home/node/.openclaw/workspace/agents/default/data/developers.json
```

### 2. Identify the assignee (DM counterparty)

The conversation's `chat.title` is the counterparty's Telegram display name. The chat's id is also the counterparty's Telegram user id.

Match against `developers.json` (the `developers` array), in order:
1. Exact `telegram_id === chatId`
2. Case-insensitive `name` substring match against `chat.title` (strip emojis/styling)
3. Case-insensitive `jira_id` substring match
4. `trello_username` / `telegram_username` substring match

If no match → `extraction.status = "unassignable"`, skip JIRA creation, notify CEO only (see §6), exit `NO_REPLY`.

If matched → capture `assigneeDev = { id, name, jira_id, telegram_id, position, level }`.

### 3. Extract task details from conversation

Read the entire conversation (text + voice transcripts). Build this analysis object and write to `/tmp/openclaw/uploads/task_extract_<X>_<N>.json`:

```json
{
  "status": "ready | unassignable | insufficient_context",
  "title": "EMU: доработать страницу тарифов (финальная вёрстка + текст)",
  "description": "Полное описание задачи в нескольких предложениях. Включи важные детали из беседы — ссылки, требования, что именно нужно сделать.\n\nContext from chat:\n- CEO: <quote>\n- Abror: <quote>",
  "assigneeDev": { "name": "Abror", "jira_id": "Abror", "telegram_id": "..." },
  "project": { "hint": "EMU" | null, "key": "EMU", "id": "10018", "name": "EMU" },
  "dueDate": "2026-04-19",
  "storyPoints": 3,
  "priority": "medium",
  "confidence": "high | medium | low",
  "evidenceMessageIds": ["6027..."]
}
```

Rules:
- **Title**: short, action-oriented, in the same language the CEO used (Russian/Uzbek/English). Prefer short noun phrases. Include project hint if present.
- **Description**: copy the relevant conversation context (text + voice transcripts). Multi-line is fine. Enough that a developer can act on it without reading Telegram.
- **Due date** (`dueDate`): Asia/Tashkent timezone. Parse "завтра", "к пятнице", "до 25-го", "next Monday", etc. If unspecified, default by priority: critical=+1d, high=+3d, medium=+7d, low=+14d. Never a past date.
- **Story points**: infer from complexity (1/2/3/5/8). Default 3 if unclear.
- **Priority**: default `medium`. Raise to `high` if words like "срочно / urgent / asap" appear; `critical` if explicit emergency.
- **Project resolution** (`project.key`, `project.id`, `project.name`):
  1. Look in conversation for explicit project hint (name/key) — e.g. "for Project A", "на сайте Project B"
  2. If found → `exec node /home/node/.openclaw/workspace/skills/pm-jira/scripts/jira.js projects` → find the matching entry by `key` or case-insensitive `name`
  3. If no hint, or no match found → use default `JIRA_PROJECT_KEY`
  4. Always capture `{ key, id, name }` in the extraction JSON

Save:
```
exec node /home/node/.openclaw/workspace/skills/task-scanner/scripts/task-watcher.js record-extraction --chat-id <X> --trigger-msg-id <N> --data-file /tmp/openclaw/uploads/task_extract_<X>_<N>.json
```

### 4. Create the JIRA issue

```
exec node /home/node/.openclaw/workspace/skills/pm-jira/scripts/jira.js create \
  --summary "<title>" \
  --description "<description>" \
  --assignee "<assigneeDev.jira_id>" \
  --sp <storyPoints> \
  --due "<YYYY-MM-DD>" \
  --project "<project.key>"
```

Capture the returned `{ key, id, url }` from stdout JSON. Then:
```
exec node .../task-watcher.js record-jira \
  --chat-id <X> --trigger-msg-id <N> \
  --status created \
  --issue-key <KEY> \
  --issue-url <URL> \
  --assignee <assigneeDev.jira_id> \
  --project-key <project.key> \
  --due-date <YYYY-MM-DD> \
  --sp <N>
```

### 5. Post the assignee notification IN THE DM, AS the CEO (via MTProto)

Use the daemon's HTTP endpoint. Build the assignee message (Russian, concise):

```json
{
  "chatId": "<X>",
  "message": "📝 <assigneeDev.name>, сделай task: <issueKey>\n\n<title>\n\n📅 Дедлайн: <DD.MM.YYYY>\n⏱ <storyPoints> SP\n🔗 <issueUrl>"
}
```

Write it to `/tmp/openclaw/uploads/task_assignee_<X>_<N>.json`, then:
```
exec curl -s -X POST http://127.0.0.1:18792/send-as-ceo \
  -H "Content-Type: application/json" \
  -d @/tmp/openclaw/uploads/task_assignee_<X>_<N>.json
```

Capture `messageId` from the JSON response. Then:
```
exec node .../task-watcher.js mark-notification \
  --chat-id <X> --trigger-msg-id <N> --kind assignee_mtproto --ref <messageId>
```

If the send fails (`ok: false`), record `mark-notification` anyway with `--ref error:<short reason>` so we don't lose audit. Still proceed to step 6.

### 6. Send CEO summary via the bot

Use the `message` tool (not exec):
```
channel: telegram
to: <CEO_TG_ID — from env, or the sender ID that triggered this scan>
message: <see template below>
buttons: []
```

Template — task created successfully:
```
✓ Задача <issueKey> создана
📝 <title>
👤 Назначена: <assigneeDev.name> (<position>)
📁 Проект: <project.name>
📅 Дедлайн: <DD.MM.YYYY>
⏱ <storyPoints> SP
🔗 <issueUrl>
```

Template — unassignable (step 2 failed):
```
⚠️ Задача не создана
Не смог определить исполнителя из этого чата.
<chat.title> не найден в developers.json.
Если всё же нужно — назначьте вручную (jira_id).
```

Template — jira create failed:
```
⚠️ Задача распознана, но не создана в JIRA
📝 <title>
👤 <assigneeDev.name>
Ошибка: <short message>
```

After sending, record:
```
exec node .../task-watcher.js mark-notification \
  --chat-id <X> --trigger-msg-id <N> --kind ceo_bot --ref <messageId-or-none>
```

### 7. NO_REPLY

End the agent turn with exactly `NO_REPLY`. Nothing else.

## Hard rules

- **DM only** — daemon already filters. Agent can assume.
- **CEO outgoing only** — daemon already filters.
- **No assignee match → NEVER create a JIRA issue.** Better to notify CEO than to create a wrongly-assigned ticket.
- **No project match → fall back to `JIRA_PROJECT_KEY`** (TEST) silently. Don't ask.
- **Never send the assignee message via the bot.** Always via MTProto `/send-as-ceo`. That's how they see it's from the CEO in their existing DM.
- **Never modify `task_log.json` directly.** Always through `task-watcher.js`.
- **Idempotent:** daemon's `is-processed` guard ensures one trigger = one run. If interrupted and re-invoked, missing notifications mean the message wasn't sent.
- **Language:** respond to CEO in Russian by default. Use whatever language the team member uses in the DM for the assignee notification (match their tone).

## Edge cases

- **Voice-only content**: the daemon already transcribed voice notes into `transcript`. Use `searchableText` which merges text + transcript when scanning.
- **Counterparty mentions a third person** ("передай Abror'у задачу") → assignee STILL defaults to DM counterparty. If the CEO wants the task re-assigned, they can move it in JIRA. Do NOT parse "to: X" from message text.
- **No clear task in conversation** → `extraction.status = "insufficient_context"`, skip JIRA, notify CEO: "⚠️ Не смог выделить задачу из контекста — детали нужны явнее".
- **Multiple projects mentioned** → pick the one most recently mentioned with action words near it.
- **Due date in past** → bump to today + priority default days, with note in description.
- **Counterparty has no jira_id in developers.json** (rare) → unassignable.

## Operations

Daemon (shared with meeting-scanner):
```
docker compose logs -f tg-watcher
docker compose restart tg-watcher
```

Reset task-scanner state only:
```
rm workspace/agents/default/data/task-scanner/task_log.json
rm workspace/agents/default/data/task-scanner/conversations/*.json
docker compose exec tg-watcher node /home/node/.openclaw/workspace/skills/task-scanner/scripts/task-watcher.js init
```

Inspect a specific event:
```
docker compose exec tg-watcher node .../task-watcher.js get --chat-id X --trigger-msg-id N
```

Change the trigger keyword:
Edit `.env`: `TASK_TRIGGER=yourword`, then `docker compose up -d --force-recreate tg-watcher`.
