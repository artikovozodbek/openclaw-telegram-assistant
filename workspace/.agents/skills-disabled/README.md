# Disabled Legacy Skills

This directory stores browser automation skills that used to live in
`../skills/` but should not be active.

They are kept for reference only. OpenClaw should not discover them from this
directory during normal skill loading.

Disabled on 2026-05-15:

- `gmail`
- `google-analytics`
- `google-calendar`
- `google-meet`
- `telegram-web`

Use `workspace/skills/gws-*` for Google Workspace and
`workspace/skills/telegram` / `workspace/skills/telegram-send` for Telegram.
Google Analytics has no active dedicated skill at the moment; use browser
automation only when explicitly requested or add a direct API skill later.
