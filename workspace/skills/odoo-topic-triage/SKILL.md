---
name: odoo-topic-triage
description: Use this skill for repeated Odoo-topic intake and triage workflows in Telegram forum discussions.
---

# Odoo Topic Triage

Use this skill when a Telegram topic or chat is handling Odoo-related requests and the recurring need is to classify the request, gather missing context, and turn it into a structured implementation or bug-triage brief.

## When this skill applies

- The request is about Odoo behavior, configuration, bugs, modules, or process changes.
- The conversation mentions or implies one of these module areas: Sales, Inventory, Accounting, CRM, or Website.
- The owner or team needs a clean intake summary before implementation, delegation, or escalation.

## Workflow

1. Identify the Odoo module.
   - First classify into one primary module: Sales, Inventory, Accounting, CRM, or Website.
   - If unclear, state the most likely module and list alternatives.

2. Capture the minimum intake fields.
   - Odoo version
   - Module
   - Current behavior
   - Expected behavior
   - Screenshots or logs available/not available

3. Ask only the missing essentials.
   - If version is missing, ask for version.
   - If the actual problem is vague, ask for exact current behavior and expected behavior.
   - If visual or error evidence would materially help, ask for screenshots or logs.

4. Produce a structured triage brief.
   - Summary of the issue/request
   - Module classification
   - Current behavior
   - Expected behavior
   - Process steps to reproduce or implement
   - Acceptance criteria
   - Risks or dependencies
   - Follow-up questions

5. Keep the output operational.
   - Write in concise business language.
   - Prefer bullet points and checklists.
   - Highlight uncertainties instead of inventing facts.

## Output template

Use this structure when enough information is available:

- **Module:** <primary module>
- **Odoo version:** <version or unknown>
- **Request type:** <bug / configuration / customization / process question>
- **Current behavior:** <observed state>
- **Expected behavior:** <desired state>
- **Process steps:**
  1. ...
  2. ...
- **Acceptance criteria:**
  - ...
  - ...
- **Risks / dependencies:**
  - ...
- **Follow-up questions:**
  - ...
- **Evidence provided:** <screenshots/logs yes-no>

## Safety

- Do not claim Odoo facts that were not provided or verified.
- Do not invent module/version details.
- Do not expose credentials, database access details, tokens, or private logs.
- This skill is procedural only: it helps triage and structure work, but does not perform external writes by itself.
- Prefer existing Telegram routing and any future dedicated Odoo integration over ad hoc browser-first behavior.
