---
name: proxy-chat
description: |
  Delegated Telegram conversation. CEO hands off a chat with a specific peer
  (by @username, phone, or userId) with an objective, persona, and constraints.
  Agent then owns replies in real time via MTProto until CEO says stop.
  Use when CEO says things like "напиши этому человеку", "общайся с ним",
  "ответь за меня", "веди переписку", "handle him", "talk to him", etc.
metadata:
  {"openclaw": {"emoji": "💬"}}
---

# Proxy Chat — Delegated Telegram Conversations

## What this skill does

The CEO can hand off an entire Telegram conversation to you. He points at a
person (by `@username`, phone, or user id) and tells you:
- **what to achieve** (objective)
- **how to behave** (persona / tone)
- **what NOT to do** (constraints)
- **when to escalate** (escalate-on triggers)

You take over. The MTProto daemon (`tg-watcher`) routes every new message
from that peer to you. You draft a reply that respects the objective and
constraints, then send it via MTProto. You log every exchange. The CEO can
close the mandate at any time.

## Architecture

```
CEO (Telegram) ──"пиши @example_user про Odoo"──▶ agent
                                                  ↓
                                    (1) resolve-peer.js @example_user → userId
                                    (2) proxy-chat.js start ...
                                    (3) [optional] send.js opener
                                                  ↓
                                          mandates.json (persisted)

counterparty writes ──▶ tg-watcher (MTProto daemon)
                             ↓
                     findActiveMandateForPeer(peerId)
                             ↓
                     spawn agent with mandate context
                             ↓
                     agent reads mandate + drafts reply
                             ↓
                     send.js → counterparty gets the reply
                             ↓
                     log-message records it
```

## Scripts you use

All under `/home/node/.openclaw/workspace/skills/proxy-chat/scripts/`:

| Script | Purpose |
|---|---|
| `resolve-peer.js --handle "@u" \| "+phone" \| "12345"` | Telegram identifier → peer JSON |
| `proxy-chat.js start --peer-id <id> --objective "..." [flags]` | Create mandate |
| `proxy-chat.js list [--status active\|paused\|closed\|all]` | List mandates |
| `proxy-chat.js get --id <mandateId>` | Full mandate + conversation |
| `proxy-chat.js find-by-peer --peer-id <id>` | Active mandate for a peer (or none) |
| `proxy-chat.js close --id <mandateId> [--reason "..."]` | End mandate |
| `proxy-chat.js pause --id <mandateId> [--reason "..."]` | Pause (stops auto-replies) |
| `proxy-chat.js resume --id <mandateId>` | Re-activate |
| `proxy-chat.js log-message --id <id> --direction incoming\|outgoing --text "..." [--message-id <tgId>]` | Append to conversation log |
| `proxy-chat.js flag --id <id> --reason "..." [--severity high\|medium\|low]` | Mark something concerning |

## Sending messages — **use the tg-watcher HTTP endpoint, not send.js**

The `tg-watcher` daemon keeps a persistent MTProto session and exposes a loopback HTTP endpoint. Always prefer this over spawning `send.js` (which re-authenticates every time and is slower).

```
POST http://127.0.0.1:18792/send-as-ceo
Content-Type: application/json
body: { "chatId": "<peerUserId>", "message": "<text>" }

→ 200 { "ok": true, "messageId": 12345 }
```

Example from agent exec:
```bash
curl -s -X POST http://127.0.0.1:18792/send-as-ceo \
  -H "Content-Type: application/json" \
  -d '{"chatId":"<peerUserId>","message":"Привет"}'
```

Use the returned `messageId` in `log-message --message-id <N>`.

**Fallback:** `scripts/send.js --peer-id <id> --text "..."` — only if the daemon's HTTP endpoint is unreachable (daemon down). Flag the mandate if this happens so the CEO knows infrastructure is degraded.

## Flow A — CEO initiates a mandate

Triggered by CEO instruction in his Telegram session: "пиши ему", "общайся с ним", "ответь на него", etc.

1. **Parse the instruction.** Extract:
   - The peer identifier (usually a @username or name)
   - The objective
   - Constraints (пусть не говорит X, не обещает Y)
   - Escalation triggers (если скажет X — доложи)
   - Whether to open immediately or wait for counterparty

2. **Resolve the peer:**
   ```
   exec node /home/node/.openclaw/workspace/skills/proxy-chat/scripts/resolve-peer.js --handle "@example_user"
   ```
   Grab `userId` from the result.

3. **Check for existing active mandate:**
   ```
   exec node /home/node/.openclaw/workspace/skills/proxy-chat/scripts/proxy-chat.js find-by-peer --peer-id <userId>
   ```
   If one exists, ask the CEO whether to replace it or extend. Never create two active mandates for the same peer.

4. **Create the mandate:**
   ```
   exec node /home/node/.openclaw/workspace/skills/proxy-chat/scripts/proxy-chat.js start \
     --peer-id <userId> --username <u> --name "<display>" \
     --objective "<what to achieve>" \
     --persona "<tone/style>" \
     --context "<background>" \
     --constraint "..." --constraint "..." \
     --escalate-on "..." --escalate-on "..." \
     [--opening "<initial message text>"]
   ```
   Pass each constraint / escalate-on as a separate `--constraint` / `--escalate-on` flag.

5. **Send opener (only if CEO said to initiate, not wait):**
   If the CEO said "напиши ему про X" — send now. If "обработай когда он напишет" — skip; mandate is armed and will fire when peer writes.
   ```
   exec curl -s -X POST http://127.0.0.1:18792/send-as-ceo \
     -H "Content-Type: application/json" \
     -d '{"chatId":"<userId>","message":"<opener>"}'
   ```
   Parse `messageId` from the JSON response, then log it:
   ```
   exec node .../proxy-chat.js log-message --id <mandateId> --direction outgoing --text "<opener>" --message-id <messageId>
   ```

6. **Confirm to CEO** in his TG: "Готово, сэр. Взял переписку с <name>. Доложу по ходу."

## Flow B — Counterparty writes (watcher-invoked)

When the mandated peer sends a new message, `tg-watcher` spawns you with full mandate context. Your job:

1. **Read SKILL.md first** (this file), then:
   ```
   exec node .../proxy-chat.js get --id <mandateId>
   ```
   Study: `objective`, `persona`, `constraints`, `escalateOn`, full `conversation` history.

2. **Log the incoming message immediately** (before deciding what to do):
   ```
   exec node .../proxy-chat.js log-message --id <mandateId> --direction incoming --text "<their message text>" --message-id <tgMessageId>
   ```

3. **Check escalate-on triggers.** If the incoming text matches any escalate-on term (case-insensitive substring match is fine):
   ```
   exec node .../proxy-chat.js flag --id <mandateId> --reason "escalate trigger '<term>' matched" --severity high
   exec node .../proxy-chat.js pause --id <mandateId> --reason "escalate trigger hit"
   ```
   Then **DM the CEO** on Telegram (at the configured `CEO_TG_ID`) with:
   - What the counterparty said (verbatim or close)
   - Which trigger matched and why it's a problem
   - Your suggested response or question
   - Wait for his decision — do NOT reply to the counterparty.

4. **Draft the reply respecting everything:**
   - Match the persona (tone)
   - Serve the objective
   - Stay within constraints (money, dates, legal, promises, etc.)
   - Keep it concise and natural — messaging app style, not email
   - Use the same language the counterparty is writing in (Russian / Uzbek / English)

5. **Send it via the daemon HTTP endpoint (single persistent MTProto session):**
   ```
   exec curl -s -X POST http://127.0.0.1:18792/send-as-ceo \
     -H "Content-Type: application/json" \
     -d '{"chatId":"<peerUserId>","message":"<your reply>"}'
   ```
   Parse `messageId` from response. For multi-paragraph replies, just use `\n\n` in the JSON string — no need for temp files.

6. **Log the outgoing:**
   ```
   exec node .../proxy-chat.js log-message --id <mandateId> --direction outgoing --text "<your reply>" --message-id <returned messageId>
   ```

7. **End with `NO_REPLY`.** Do not send anything back to the gateway. The reply went directly to the counterparty via MTProto; the CEO does not need a "status update" on every exchange.

## Flow C — CEO asks for status or closes mandate

| CEO says | Do |
|---|---|
| "как там с Dostonом?" | `proxy-chat.js list --status active`, find relevant mandate, `get --id <id>`, summarize last N exchanges to CEO |
| "останови / хватит / закрывай с ним" | `proxy-chat.js close --id <id> --reason "CEO stopped"`, confirm "Готово, закрыл переписку с <name>." |
| "поставь на паузу" | `proxy-chat.js pause --id <id>` |
| "вернись к нему" | `proxy-chat.js resume --id <id>`; resume replies on next incoming |

## Hard rules

- **One active mandate per peer.** The CLI enforces this; if CEO wants a new mandate on someone you're already handling, `close` the old one first and state the reason.
- **Never invent facts the CEO didn't give you.** If the counterparty asks for a date, price, or technical detail you don't have and constraints forbid guessing — say you need to check with the CEO, flag the mandate, and wait.
- **Never commit to money, legal, or binding dates** unless the CEO explicitly allowed it in constraints.
- **Escalate-on triggers are absolute.** Even if the message "seems fine", if the text contains a trigger term — pause, flag, ping CEO.
- **Stay in one language per exchange.** If they wrote in Uzbek, reply in Uzbek; in Russian, reply in Russian. Never mix.
- **Keep replies messaging-app sized** (usually 1–3 sentences). Not email.
- **No voice notes back** unless the CEO explicitly asked. Text only.
- **Log every message both ways.** This is how the CEO audits you.

## Escalation message format (when pinging CEO)

On Telegram at the configured `CEO_TG_ID`, short and structured:

```
⚠️ Мандат <peerName>: сработал escalate-триггер «<term>»

Он написал: "<их сообщение>"
Причина флага: <почему это важно>
Мандат поставлен на паузу — жду вашего решения, сэр.

Предложение: <что я бы ответил, если разрешите>
```

## Example CEO instructions and what you do

**"Пиши @example_user про Odoo тарифы. Цель — понять бюджет и сроки, согласовать звонок. Тон дружелюбный. Цены не называй конкретные. Если начнёт давить или упоминать юриста — эскалируй."**

```
resolve-peer → userId=12345
proxy-chat start --peer-id 12345 --username example_user --name "Doston"
  --objective "понять бюджет по Odoo, согласовать 15-минутный звонок"
  --persona "дружелюбный, деловой, без воды"
  --context "потенциальный клиент, обсуждали вчера тарифы"
  --constraint "не называть конкретные цифры — всегда предлагать созвон"
  --constraint "не обещать сроков внедрения"
  --escalate-on "юрист"
  --escalate-on "суд"
  --escalate-on "отмен"
  --opening "Doston, привет! Доступны завтра в 15:00 или 16:00 на 15 минут? Расскажу варианты под ваш объём."
```

**"Обрабатывай @clientX когда напишет — спокойно разбирайся с его жалобой по предыдущему проекту, соглашайся пересмотреть этапы, но без скидок."**

```
proxy-chat start --peer-id <id> --username clientX
  --objective "разобраться с жалобой, согласовать план пересмотра этапов"
  --persona "спокойный, извиняющийся, конструктивный"
  --constraint "никаких скидок и возвратов"
  --constraint "не признавать вины письменно — только предлагать решения"
  --escalate-on "суд"
  --escalate-on "lawyer"
  --escalate-on "вернуть деньги"
  # no --opening — mandate is armed, we wait for his first message
```

## State & persistence

- Mandates: `/home/node/.openclaw/workspace/agents/default/data/proxy-chat/mandates.json`
- Each mandate includes the full conversation log (both directions)
- Past closed mandates stay in the file as history — future mandates on the same peer can reference them via `list --status all`

## Dependencies

- `TG_API_ID`, `TG_API_HASH`, `TG_USER_SESSION` in `.env` (already set)
- `telegram` npm package (gramjs) in `workspace/node_modules` (already installed)
- `tg-watcher` docker service must be running for inbound message routing
