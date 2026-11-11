---
name: google-calendar
description: Google Calendar browser automation — create events, check schedule, add Google Meet links. Use when user mentions calendar, events, meetings, schedule.
---

# Google Calendar Automation

URL: `https://calendar.google.com/`
Account: whatever Google account your Chrome profile is signed into

## Create an Event

**Fastest method — URL parameters:**
```
https://calendar.google.com/calendar/r/eventedit?text=EVENT+TITLE&dates=20260327T100000/20260327T110000&details=Description+here
```
Navigate to this URL with filled parameters — pre-populates the event form. Just click Save.

**Manual method:**
1. Navigate to `https://calendar.google.com/`
2. `snapshot` — find "Create" or "+" button
3. Click Create — quick-add popup appears
4. Type event title, set date/time
5. For detailed event: click "More options" to open full editor
6. To add Google Meet: click "Add Google Meet video conferencing" in the event editor
7. Click "Save"

## Check Schedule

1. Navigate to calendar
2. `snapshot` — main grid shows today's events
3. Use view selector (Day/Week/Month) at top to change timeframe
4. Click on an event to see details popup

## Gotchas

- **URL parameter method is most reliable** — avoids interacting with obfuscated DOM
- **Date format**: `YYYYMMDDTHHMMSS` (no dashes, T separator)
- **Obfuscated DOM** — Google uses Closure Compiler. NEVER use CSS class selectors. Use ARIA labels and roles from snapshot
- **Custom date/time pickers** — these are Google widgets, not native inputs. Multiple clicks needed
- **After any element error** → re-snapshot immediately
