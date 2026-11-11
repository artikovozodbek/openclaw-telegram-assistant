# Topic Intelligence

Topic Intelligence makes OpenClaw adapt to the real work happening inside
Telegram forum topics.

The goal is not to predefine permanent agents for names like Odoo, CRM, or
Design. Topic titles are examples and can change. The system creates a
dedicated generated profile for each discovered Telegram topic, then reads
recent topic activity to detect repeated workflows and missing capabilities.
When safe, it can create or improve local procedural skills and add those skills
only to that topic profile's allowlist.

## Current Safety Policy

- Local markdown skills may be created or improved automatically.
- Generated topic profiles may reuse existing OpenClaw skills, but only through
  their own profile allowlist.
- Third-party plugin, ClawHub, npm, Python, or hook-pack installs are
  recommendations only and need owner approval before execution.
- Secrets and credential files must never be printed or copied into reports.
- Telegram and Google Workspace must reuse existing direct skills before any
  browser-first fallback.

## Runtime State

Daily audit state is intentionally runtime-only:

```text
workspace/memory/topic-intelligence/groups/<group_id>.json
workspace/memory/topic-intelligence/groups/index.json
workspace/memory/topic-intelligence/audits/
```

Those paths are ignored by Git. The committed contract lives here:

```text
workspace/docs/topic-intelligence/
workspace/skills/topic-intelligence/
```

For group setup, `/topic-activate`, owner commands, automation, and the
validation matrix, see
`group-onboarding.md`.

## Known Local Telegram Topics

As of the initial implementation, the configured Telegram forum group has:

| Topic id | Title |
|---:|---|
| 1 | General |
| 4 | Google Workspace |
| 2 | Odoo |

These are observations, not hard-coded product assumptions. The audit must
infer each topic's active domain from messages.

## Daily Audit Job

The runtime cron job should call the main agent once per day with the prompt in
`daily-audit-prompt.md`. The job may write local skills and runtime audit state,
but it must only recommend external plugin installs. The periodic re-onboarding
automation also refreshes each generated topic profile's skill allowlist from
the registry, so newly justified local skills become visible only to the
relevant topic profile.

Each topic registry entry tracks adaptive evidence:

- `evidenceLevel`: `none`, `title_only`, `weak`, `medium`, or `high`.
- `repeatedWorkflows`: workflows observed often enough to consider reusable
  instructions.
- `localSkillsCreated` and `localSkillsUpdated`: safe local markdown skill
  changes.
- `pluginRecommendations`: external packages/plugins/connectors that require
  owner approval and are not installed automatically.

Topic title alone is not enough to create a skill. A local skill needs an owner
request, at least 3 matching workflow instances, or title plus messages proving
a stable domain with high evidence.

Recommended schedule:

```text
30 9 * * * Asia/Tashkent
```

To reinstall the runtime cron job from Windows PowerShell:

```powershell
.\scripts\install-topic-intelligence-cron.ps1
```

For per-group jobs created from onboarded group registries, use
`/topic-activate` from Telegram or the cross-platform installer:

```powershell
node scripts/install-topic-intelligence-cron.mjs --all --dry-run
node scripts/install-topic-intelligence-cron.mjs --all --apply
```

## Automatic Re-Onboarding

Phase 5 keeps onboarded forum groups current as topics are added, renamed,
closed, hidden, or temporarily unavailable. Re-onboarding preserves existing
topic routes by `message_thread_id`, adds adaptive fallback routes for newly
discovered topics, marks closed/hidden topics inactive, and marks previously
known but currently missing topics stale. It never deletes routes.

Install the six-hour re-onboarding cron jobs from the workshop directory:

```powershell
node scripts/install-telegram-topic-onboarding-cron.mjs --all --dry-run
node scripts/install-telegram-topic-onboarding-cron.mjs --all --apply
```

The scheduled job runs the mounted container command:

```sh
node /home/node/.openclaw/workspace/bin/telegram-topic-onboard.mjs --group <group_id> --apply
```

Routine re-onboarding does not announce into the Telegram group; inspect OpenClaw
cron history or logs when debugging.

## Owner Commands

Configured owners/admins can run safe topic commands directly in a configured
Telegram forum group:

```text
/topic-activate
/topic-onboard
/topic-routes
/topic-audit-now
/topic-skills
/topic-plugin-suggestions
```

The commands use existing allowlists from `channels.telegram.allowFrom`,
`channels.telegram.groupAllowFrom`, and group-level owner/admin fields. They do
not expose config, secrets, token values, or raw registry files. `/topic-onboard`
uses safe apply mode only: existing topic routes are preserved unless a developer
runs the CLI with `--force`.

## Manual Checks

Useful validation commands from the workshop directory:

```powershell
node scripts/test-topic-profiles.mjs
node scripts/test-topic-profiles.mjs --runtime
node scripts/test-topic-onboarding.mjs --group -1001234567890
node scripts/test-topic-onboarding.mjs --group -1001234567890 --runtime
node scripts/install-topic-intelligence-cron.mjs --all --dry-run
node scripts/install-telegram-topic-onboarding-cron.mjs --all --dry-run
node scripts/topic-intelligence-skill-loop.mjs --registry workspace/memory/topic-intelligence/groups/-1001234567890.json --dry-run
node workspace/bin/topic-agent-allowlists.mjs --registry workspace/memory/topic-intelligence/groups/-1001234567890.json --config config/openclaw.json --dry-run
docker compose config --quiet
docker exec workshop-openclaw-gateway-1 sh -lc 'node /app/dist/index.js config validate --json'
docker exec workshop-openclaw-gateway-1 sh -c 'PATH=/home/node/.openclaw/workspace/bin:/home/node/.openclaw/workspace/node_modules/.bin:$PATH node /app/dist/index.js skills check --agent main --json'
docker exec workshop-openclaw-gateway-1 sh -lc 'node /app/dist/index.js cron list --json'
```

The runtime test intentionally sets the workspace PATH before running
`skills check`; otherwise a login shell can miss the local `gws` wrapper and
report false missing requirements for Google Workspace skills.
