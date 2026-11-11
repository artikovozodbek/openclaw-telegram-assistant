---
name: pm-developers
description: Developer information, stats, and workload analysis
metadata: {"openclaw.emoji":"👥"}
---

# PM Developers

Query developer information and statistics.

## Commands

### Get Developer Info
```
dev info "<name or jira_id>"
```
Returns developer profile:
- Name, position, level
- Preferred tasks, skills
- Current workload
- Telegram ID
- Language preference

**Example:** `dev info "alex"`

### Get Developer Stats
```
dev stats "<name>"
```
Returns detailed statistics:
- Open issues count and SP
- Completed this week/month
- Average velocity
- WIP count
- Utilization percentage

**Example:** `dev stats "Gulom"`

### Get All Developers
```
dev list [--type dev|pm]
```
Returns summary of all developers. Optionally filter by type.

**Examples:**
- `dev list` - All team members
- `dev list --type dev` - Only developers
- `dev list --type pm` - Only project managers

### Get Developer Workload
```
dev workload "<name>"
```
Returns current assignments:
- Open issues with due dates
- Story points assigned
- Issues in progress
- Utilization vs capacity

**Example:** `dev workload "alex"`

### Find Best Developer
```
dev find-best --discipline "<backend|mobile|frontend>" --sp <points> --urgency "<critical|high|medium|low>"
```
Returns ranked candidates for a task based on:
- Skill match
- Current workload
- Experience with similar tasks
- Profile fit (preferences, weaknesses)

**Example:** `dev find-best --discipline "mobile" --sp 5 --urgency "high"`

## Data Source

Developer profiles loaded from `agents/default/data/developers.json`.

JIRA workload queried in real-time.

## Developer Profile Fields

```json
{
  "id": "1",
  "name": "Alex",
  "telegram_id": null,
  "jira_id": "alex_back",
  "type": "dev",
  "position": "Backend php laravel",
  "language": "English",
  "level": 2,
  "main_tech": "PHP Laravel",
  "secondary_tech": "JS",
  "expertise_tags": "",
  "max_parallel_tasks": 2,
  "urgent_ok": true,
  "preferred_tasks": "Laravel API development...",
  "avoid_tasks": "mobile UI work...",
  "weaknesses": "documentation",
  "handles_time_pressure": "yes",
  "learns_fast": "yes",
  "responsibility": "yes",
  "capacity_sp_per_week": 7.5
}
```

## Level Reference
- Level 1: Junior - Simple tasks, needs review
- Level 2: Mid - Standard tasks, some autonomy
- Level 3: Senior - Complex tasks, can mentor
- Level 4: Lead - Architecture, critical systems
