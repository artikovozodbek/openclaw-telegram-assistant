# Daily Topic Audit Workflow

This reference is used by cron jobs and manual audits.

## Inputs

- Telegram group id or title.
- Known topic ids and titles, if available.
- Audit window, normally the last 24 hours.
- Current OpenClaw skills list and agent skill visibility.

## Outputs

- Updated per-group runtime registry at
  `/home/node/.openclaw/workspace/memory/topic-intelligence/groups/<group_id>.json`.
- Markdown audit report under
  `/home/node/.openclaw/workspace/memory/topic-intelligence/audits/`.
- New or updated local skills under
  `/home/node/.openclaw/workspace/skills/` when safe and justified.
- Plugin recommendations only; no automatic plugin installs.

## Decision Rules

- Topic title is weak evidence. Title alone is insufficient for skill creation.
- Record title-only topics with `evidenceLevel: "title_only"` and no local skill
  change.
- A local skill is justified only by at least three similar workflow instances,
  one explicit owner request, or title plus messages proving a stable domain
  with high evidence.
- Prefer `gws-*` for Google Workspace and `telegram`/`telegram-send` for
  Telegram. Do not recreate those capabilities.
- Prefer a narrow skill for a recurring workflow over a broad generic skill.
- If the required improvement needs executable code, package installs, browser
  extensions, or external credentials, write a recommendation instead of making
  the change.
- Name generated skills with lowercase hyphenated topic/domain-scoped names,
  such as `odoo-topic-triage`. Avoid names that imply an unofficial skill is an
  official vendor or plugin.
- Validate generated skills before writing them: YAML frontmatter, matching
  `name`, no secrets, no raw long transcript blocks, and a Safety section.

## Registry Fields

Use this stable per-group shape:

```json
{
  "groupId": "-1000000000000",
  "title": "Example Group",
  "isForum": true,
  "topics": {
    "2": {
      "title": "Odoo",
      "status": "active",
      "agentId": "general",
      "routingMode": "adaptive",
      "inferredDomain": "odoo",
      "evidenceLevel": "high",
      "skills": ["telegram", "telegram-send", "topic-intelligence"],
      "repeatedWorkflows": [
        {
          "name": "Odoo triage",
          "description": "Classify by module, version, current behavior, expected behavior, logs, and acceptance criteria.",
          "repeatedWorkflowCount": 3,
          "evidenceLevel": "high",
          "ownerRequestedLocalSkill": false,
          "stableWorkflow": true,
          "requiresExternalInstall": false
        }
      ],
      "localSkillsCreated": [
        {
          "name": "odoo-topic-triage",
          "path": "workspace/skills/odoo-topic-triage/SKILL.md",
          "workflow": "Odoo triage",
          "createdAt": "2026-05-25T00:00:00.000Z",
          "updatedAt": "2026-05-25T00:00:00.000Z"
        }
      ],
      "localSkillsUpdated": [],
      "pluginRecommendations": [],
      "lastAuditAt": "2026-05-25T00:00:00.000Z"
    }
  },
  "pluginSuggestions": [],
  "lastAuditAt": "2026-05-25T00:00:00.000Z",
  "updatedAt": "2026-05-25T00:00:00.000Z"
}
```
