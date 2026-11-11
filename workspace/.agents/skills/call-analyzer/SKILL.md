---
name: call-analyzer
description: Sales-call audit via Gemini 3.1 Pro. Pulls voice recordings from whatever CRM is currently open (amoCRM / Bitrix24 / Kommo / any CRM with call logs), transcribes them, scores manager performance, and produces an executive report. Use when the user asks to analyze calls, audit the call center, review manager conversations, score salespeople, get transcripts, or any variant of: проанализируй звонки, разбери разговоры, оцени менеджеров, как работает колл-центр, скрипт разговора, транскрипт, что обсуждали в звонке, analyze call recordings, audit calls, review call center.
---

# Sales Call Analyzer

Audits call-center recordings from the user's CRM. Output: per-call scoring, strengths / weaknesses, management-level recommendations, and on request a cleaned transcript.

## When to use this

User says things like:
- «проанализируй звонки», «разбери разговоры call-центра»
- «оцени, как работают менеджеры», «как наш колл-центр работает»
- «analyze the call recordings», «audit our sales calls»
- «дай скрипт звонка», «что они обсуждали», «gimme the transcript»

Pair with `amocrm-web` or the matching CRM skill to actually fetch the recordings.

## Which CRM

Use whichever CRM tab is already open. Don't assume amoCRM — check first.

- **amoCRM / Kommo** — recordings live on lead / contact cards in the event feed, next to «Входящий звонок» / «Исходящий звонок» entries. Look for `<audio>` elements.
- **Bitrix24** — call history in `/crm/call/` or on deal cards.
- **Any other CRM** — look for a calls / telephony section or a call log inside individual records.

Rules:
- Answered calls usually have a playable recording; missed / no-answer calls usually don't — say so to the user when you skip them.
- Don't hardcode tab IDs or URLs. `browser tabs` → switch → `snapshot` → find the audio.

## Download

For each recording:
1. `snapshot` the record feed
2. Find the `<audio>` element and extract its `src` URL via `browser evaluate`
3. Fetch it with the page's session cookies — either `fetch()` inside the tab via CDP and pipe base64 out, or pull cookies from CDP and download in a Node script in the container
4. Save to `workspace/output/call_recordings/YYYY-MM-DD_<direction>_<phone>.mp3`

Reuse existing Gemini upload logic in `workspace/skills/competitor-analyzer/scripts/gemini-video-analyze.js` — same resumable-upload pattern works for audio.

## Model: Gemini 3.1 Pro (not 2.5 flash)

- Model id: `gemini-3.1-pro-preview`
- Env: `GEMINI_API_KEY` (already in `.env`)
- Language hint: Russian + Uzbek + English mixed (speakers often switch mid-sentence)

`meeting-scanner/scripts/transcribe.js` uses 2.5-flash — that's for quick Telegram voice notes, not for call audits. Call analysis needs 3.1 Pro's depth.

## Output schema (per call)

Match `workspace/output/call_recordings/gemini_call_analysis.json`:

```json
{
  "id": "call_N",
  "file": "...mp3",
  "meta": { "date": "YYYY-MM-DD", "direction": "inbound|outbound", "duration": "MM:SS", "phone": "+998..." },
  "analysis": {
    "language": "Uzbek | Russian | English",
    "transcript": "timestamped transcript",
    "brief_summary": "...",
    "call_purpose": "...",
    "outcome": "...",
    "manager_performance": {
      "greeting_and_tone":  { "score": 1-10, "notes": "" },
      "needs_discovery":    { "score": 1-10, "notes": "" },
      "clarity_of_offer":   { "score": 1-10, "notes": "" },
      "objection_handling": { "score": 1-10, "notes": "" },
      "next_step_control":  { "score": 1-10, "notes": "" },
      "overall":            { "score": 1-10, "notes": "" }
    },
    "customer_signals": [ "..." ],
    "mistakes": [ "..." ],
    "strengths": [ "..." ],
    "recommended_improvements": [ "..." ]
  }
}
```

Combined results → `workspace/output/call_recordings/gemini_call_analysis.json`.

## Deliverables to the user

In this order:

**1. Short verdict in chat** (voice + text via standard reply):
- 3 headline scores: Operational quality, Sales depth, Follow-up discipline (all /10)
- What's good (4 bullets), what's weak (4 bullets)
- Per-call one-liner
- Management conclusion ("работает как лёгкая координация, а не консультативные продажи" style)

**2. Detailed markdown report** → `workspace/output/call_recordings/call_center_audit_report_YYYY-MM-DD.md`

Follow the shape of `call_center_audit_report_2026-04-07.md` exactly:
- Sample size + limitation note
- Calls reviewed (list)
- Executive summary
- Overall impression (tone / context understanding / offer clarity / objections / next-step / qualification)
- Average scores across all calls
- Call-by-call: what happened / what was good / what was missing / verdict
- Call-center strengths + weak points
- Management conclusion
- Assessment (operational quality, sales depth, follow-up discipline)
- Concrete recommended improvements (numbered checklist)
- Bottom line

Attach the file via the `message` tool.

**3. Transcript file on request** → `workspace/output/call_recordings/call_transcripts_<lang>_YYYY-MM-DD.md`

Only when user asks for «скрипт», «транскрипт», «что обсуждали», «what they discussed». Per call:
- Brief «What they discussed» bullets
- Full cleaned transcript (timestamped, original language)

## Prior art — reference these

- `workspace/output/call_recordings/gemini_call_analysis.json` — schema reference
- `workspace/output/call_recordings/call_center_audit_report_2026-04-07.md` — report reference
- `workspace/output/call_recordings/call_transcripts_uz_2026-04-07.md` — transcript reference

Match their shape when generating new ones.

## Gotchas

- **Gemini 3.1 Pro**, not 2.5 flash. 2.5-flash is for quick Telegram voice transcription.
- **20 MB cap** per file (`messages.tts.maxBytes` mirrors this) — long calls need chunking or use the resumable upload API.
- **Missed calls** have no audio — tell the user which ones you skipped.
- **Small samples must be flagged.** If you only analyzed 2-3 calls, say so explicitly in the report — don't generalize to the whole call center.
- **Uzbek.** If the speakers are Uzbek, don't mistranscribe as Russian. Pass the right language hint to Gemini.
- **Don't invent scores.** If a dimension wasn't demonstrated in the call (e.g. no objections came up), say "not tested" in notes rather than picking a number.
- **Don't analyze without permission for bulk runs.** For 20+ calls, confirm with user first — Gemini costs + time add up.
- **Artifacts are confidential.** Call recordings contain customer data. Don't share paths outside the current session.
