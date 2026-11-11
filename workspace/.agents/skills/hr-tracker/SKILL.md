---
name: hr-tracker
description: HR / Time Tracker browser automation template. Edit this file to point at your company's HR system. Use when the user asks about attendance, time logs, overtime, late arrivals, or HR.
---

# HR Time Tracker (Template)

URL: (set to your company's HR/time tracker)

Edit this skill:
1. Change the URL above to your HR system.
2. Update the Pages table below to match your system's routes.
3. The "Common Operations" section is a pattern — the agent will discover the actual DOM from snapshots.

## Pages (example — replace with yours)

| Page | URL | What it shows |
|------|-----|---------------|
| Dashboard | `/` | Overview stats |
| Employees | `/employees` | Employee list |
| Time Logs | `/time-logs` | Clock in/out records |

## Common Operations

### Check who's at work today
1. Navigate to your HR dashboard
2. `snapshot` to read the check-ins panel

### Check late arrivals / overtime
Navigate, snapshot, ask the agent to read the numbers.

## Gotchas
- **READ ONLY by default.** Don't let the agent create/edit/delete HR records unless explicitly requested.
- **After any element error** → re-snapshot immediately
