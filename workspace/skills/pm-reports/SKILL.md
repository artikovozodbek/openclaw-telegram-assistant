---
name: pm-reports
description: Generate PM reports - daily status, developer profiles, analytics
metadata: {"openclaw.emoji":"📊"}
---

# PM Reports

Generate comprehensive PM reports.

## Commands

### Daily Report
```
report daily
```
End-of-day status report containing:
- Today's completed issues
- In-progress issues
- Blocked issues
- Tomorrow's priorities
- Team velocity snapshot

**Trigger words:** "daily report", "end of day", "eod report", "дневной отчет"

### Full Report
```
report full
```
Complete developer profiles containing:
- Each developer's current workload
- Performance scores
- Skill summary
- Recent completed work
- Capacity utilization

**Trigger words:** "full report", "developer profiles", "team report", "полный отчет"

### Analytics Report
```
report analytics
```
Strategic insights containing:
- Velocity trends
- Capacity forecast
- Risk assessment
- Team health scores
- Predictions and recommendations

**Trigger words:** "analytics", "strategic", "forecast", "trends", "аналитика"

### Trello Daily Report
```
report trello-daily
```
Trello board snapshot report using mapped Trello developers only.

### Trello Full Report
```
report trello-full
```
Full Trello developer workload profile report based on current board state.

### Trello Analytics Report
```
report trello-analytics
```
Snapshot-based analytics for Trello board WIP, overdue load, and SP distribution.

## Output

Reports are generated as text files and sent as documents via Telegram.

Format:
```
📊 Daily Report | 2024-03-01
📄 12,345 characters
⏰ Generated at 18:00 (Tashkent)
```

Reports are also:
1. Sent to PM group chat (if configured)
2. Stored in Brain for future queries
3. Saved locally for debugging

## Report Structure

### Daily Report Sections
1. Executive Summary
2. Today's Completed Work
3. Work In Progress
4. Blocked/At Risk
5. Tomorrow's Priorities
6. Team Notes

### Full Report Sections
1. Team Overview
2. Individual Developer Profiles
   - Current assignments
   - Performance metrics
   - Strengths/weaknesses
   - Recommendations
3. Workload Distribution
4. Skill Coverage Analysis

### Analytics Report Sections
1. Executive Summary
2. Velocity Trends (weekly/monthly)
3. Capacity Analysis
4. Risk Assessment
5. Strategic Recommendations
6. Predictions

## Brain Integration

Before generating reports, queries Brain for context:
- Previous report findings
- PM directives and priorities
- Historical patterns
- Strategic context
