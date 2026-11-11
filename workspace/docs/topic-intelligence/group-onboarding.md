# Telegram Forum Group Onboarding

This guide covers the handoff-safe path for making a configured Telegram forum
group usable with OpenClaw topic routing and topic intelligence. The main
assistant remains unchanged; each discovered Telegram topic gets its own
dedicated topic profile.

## Setup

1. Add the Telegram supergroup id to `config/openclaw.json` under
   `channels.telegram.groups`.
2. Keep the group mention-gated with `requireMention: true`.
3. Make sure the owner/admin Telegram user id is present in
   `channels.telegram.allowFrom` or `channels.telegram.groupAllowFrom`.
4. In Telegram/BotFather, allow the bot to work in groups and make sure the
   group has topics enabled.
5. Start or recreate Compose services with the `mtproto` profile when
   `tg-watcher` is needed.

## Activate From Telegram

After the group id is present in config, an allowed owner/admin can run this
inside the Telegram forum group:

```text
/topic-activate
```

Activation discovers topics, creates one profile per topic, generates the
profile workspaces, routes each topic to its own profile, refreshes topic-agent
skill allowlists, and installs the per-group audit and re-onboarding automation.

External plugins/packages are never installed by this command. Topic
intelligence can recommend them for owner approval later.

## Onboard From CLI

Run a preview first:

```powershell
node scripts/onboard-telegram-topics.mjs --group -100NEWGROUP --dry-run
```

Apply only after the preview looks right:

```powershell
node scripts/onboard-telegram-topics.mjs --group -100NEWGROUP --apply
```

For all configured forum groups:

```powershell
node scripts/onboard-telegram-topics.mjs --all --dry-run
node scripts/onboard-telegram-topics.mjs --all --apply
```

The apply path creates a config backup, writes the runtime registry under
`workspace/memory/topic-intelligence/groups/`, creates or updates generated
topic profiles under `config/workspaces/topic_*`, preserves existing custom
topic routes, and keeps `requireMention: true`.

## Install Automation

`/topic-activate` installs both jobs automatically. Use the CLI installers only
for maintenance or repair.

Install daily topic intelligence audits:

```powershell
node scripts/install-topic-intelligence-cron.mjs --all --dry-run
node scripts/install-topic-intelligence-cron.mjs --all --apply
```

Install periodic re-onboarding:

```powershell
node scripts/install-telegram-topic-onboarding-cron.mjs --all --dry-run
node scripts/install-telegram-topic-onboarding-cron.mjs --all --apply
```

Re-onboarding adds newly discovered topics, preserves routes by topic id, marks
closed/hidden topics inactive, and never deletes old routes automatically.

## Owner Commands

Configured owners/admins can use these commands in a configured Telegram forum
group:

```text
/topic-activate
/topic-onboard
/topic-routes
/topic-audit-now
/topic-skills
/topic-plugin-suggestions
```

The replies summarize state and changes without dumping config, secrets, raw
registry files, or token values.

## Validate

Static validation:

```powershell
node scripts/test-topic-profiles.mjs
node scripts/test-topic-onboarding.mjs --group -100NEWGROUP
```

Runtime validation:

```powershell
node scripts/test-topic-onboarding.mjs --group -100NEWGROUP --runtime
```

The runtime command confirms:

- the group is configured,
- Bot API `getChat` reports `is_forum: true`,
- `tg-watcher` can discover forum topics,
- the dry-run route plan preserves existing routes,
- each topic routes to a dedicated `topic_<group>_<thread>` profile,
- the General topic gets a topic profile with safe general-purpose skills,
- Google Workspace-like topics get a topic profile with the relevant `gws-*`
  skills in that profile's allowlist,
- unknown topics get adaptive topic profiles with topic intelligence enabled.

## Validation Matrix

| Case | Expected |
|---|---|
| Group id absent from config | Onboarding refuses. |
| Group is not forum-enabled | Onboarding refuses with a clear message. |
| MTProto cannot see group | Runtime validation reports topic discovery failure. |
| New forum group with topics | Dry-run lists topic routes; apply writes registry. |
| General topic present | Routes to a dedicated generated topic profile. |
| Google Workspace-like topic present | Routes to a dedicated topic profile with `gws-*` skills. |
| Unknown topic present | Routes to an adaptive dedicated topic profile. |
| Existing custom route | Preserved unless `--force` is used. |
| Re-run onboarding | Idempotent when topics and routes are unchanged. |
| New topic added later | Added by re-onboarding with adaptive fallback. |
| Topic renamed | Route remains tied to topic id. |
| Repeated workflow | Topic intelligence may create/update a local skill and add it to that topic profile's allowlist. |
| Plugin gap identified | Recommendation only; no automatic install. |
