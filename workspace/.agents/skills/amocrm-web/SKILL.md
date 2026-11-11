---
name: amocrm-web
description: amoCRM browser automation — leads, deals, contacts, companies, tasks, pipeline. Use when user mentions amoCRM, CRM, lead, deal, сделка, воронка, контакт, компания, клиент, задача по клиенту, покупатель, pipeline, стадия, этап, менеджер продаж, продажи, pipeline stage, conversion, или просит что-то сделать/посмотреть в CRM.
---

# amoCRM Web

URL: `https://your-subdomain.amocrm.ru/` (replace with your company's amoCRM URL)
Account: whatever amoCRM account your Chrome profile is signed into

## Sections

- `/leads/pipeline/` — sales pipeline (канбан со сделками по стадиям)
- `/leads/list/` — сделки списком с фильтрами
- `/contacts/` — контакты и компании
- `/tasks/` — задачи по сделкам/контактам
- `/stats/` — аналитика и отчёты продаж
- `/settings/` — настройки воронок, полей, пользователей
- `/mail/` — почта внутри CRM

## Orientation

amoCRM is a Russian sales CRM. Core entities: **Lead (Сделка)**, **Contact (Контакт)**, **Company (Компания)**, **Task (Задача)**. Leads live in pipelines (воронки) and move through stages (этапы). Each lead has linked contacts/company, tasks, notes, and a chat feed.

The left sidebar has the main navigation. Top bar has search (ищет по всем сущностям). Filter panel on the right for list views.

## How to work with it

- Use the already-open amoCRM tab (`browser tabs` → switch). Don't open a new one.
- `snapshot` BEFORE any click. Re-`snapshot` AFTER any error. amoCRM is React-based — DOM nodes get recreated.
- Navigation: change URL directly (`https://your-subdomain.amocrm.ru/leads/list/?...`) is faster than clicking through.
- Pipeline view: drag-drop stage changes are fragile — prefer opening the lead card and changing stage from the dropdown.
- Search: top-bar search is global; use it for "find deal with X" / "найти сделку по номеру".
- When filtering lead lists, prefer the URL query params if you can read them off an existing filter; hand-building them is error-prone.

## Gotchas

- **Russian UI** — labels, buttons, and placeholders are in Russian. Don't match on English strings.
- **React re-renders** — stale element refs. Always fresh snapshot after an action.
- **Modal dialogs** cover the page for lead creation / task creation — handle them before continuing anything else.
- **Don't delete or bulk-edit** without confirming with the user first — destructive in amoCRM is hard to undo.
- **Do not touch settings** (`/settings/`) unless the user explicitly asks.
