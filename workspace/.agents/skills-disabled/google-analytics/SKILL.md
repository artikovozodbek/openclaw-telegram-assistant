---
name: google-analytics
description: Google Analytics browser automation — read traffic reports, check metrics, view audience data. Use when user mentions analytics, site stats, traffic, visitors.
---

# Google Analytics Automation

URL: `https://analytics.google.com/`
Account: whatever Google account your Chrome profile is signed into. The property selector at top-left lets you switch between properties you own.

## View Overview / Key Metrics

1. Navigate to or switch tab to Google Analytics
2. `snapshot` — Home page shows key metrics: active users, events, new users, revenue
3. Data is for the default date range (usually last 28 days)

## View Specific Reports

1. `snapshot` — find "Reports" in left sidebar
2. Click "Reports" — sub-navigation appears:
   - **Realtime** — live visitors right now
   - **Acquisition** → Traffic acquisition, User acquisition
   - **Engagement** → Events, Pages and screens, Landing pages
   - **Monetization** → Revenue
   - **Retention** → User retention
3. Click desired report category → sub-report
4. `snapshot` to read metrics, charts, and tables

## Change Date Range

1. Find the date range picker at top-right of the report
2. Click it → select preset (Last 7 days, Last 28 days, etc.) or custom range
3. Click "Apply"
4. Wait 2-3 seconds for data to load, then `snapshot`

## Gotchas

- **Async data loading** — charts and tables load asynchronously. Wait 2-3 seconds after navigation before snapshot
- **Obfuscated DOM** — Google product, use ARIA labels from snapshot, not CSS classes
- **Property selector** — if wrong property shown, click the property name at top-left to switch
- **Data lag** — GA4 data typically lags 12-24 hours behind real events
- **After any element error** → re-snapshot immediately
