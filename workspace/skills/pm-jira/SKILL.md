---
name: pm-jira
description: 'JIRA Server integration for PM workflows - search, create, manage issues. Use when user asks about JIRA issues, workload, creating tasks, or searching issues. Scripts are in the workspace skills folder.'
metadata:
  {
    "openclaw": { "emoji": "📋", "requires": { "env": ["JIRA_URL","JIRA_USERNAME","JIRA_PASSWORD"] } }
  }
---

# PM JIRA Integration

Full JIRA Server integration for project management.

## Commands

### Search Issues
```
jira search "<JQL>"
```
Run JQL query, returns issues with key, summary, assignee, status, story points, due date.

**Examples:**
- `jira search "project = TEST AND assignee = john.doe AND statusCategory != Done"`
- `jira search "project = TEST AND created >= -7d"`
- `jira search "project = TEST AND status = 'In Progress'"`

### Create Issue
```
jira create --summary "<title>" --description "<desc>" --assignee "<jira_id>" --sp <points> --due "<YYYY-MM-DD>" [--project KEY]
```
Creates a new JIRA issue and returns the issue key and URL.

**Parameters:**
- `--summary` (required): Issue title
- `--description` (optional): Full description
- `--assignee` (required): JIRA username
- `--sp` (optional): Story points (default: 3)
- `--due` (optional): Due date in YYYY-MM-DD format
- `--project` (optional): Project key (e.g. `TEST`, `PROJ`). Defaults to `JIRA_PROJECT_KEY` env.

### Get Project Info
```
jira project-info
```
Returns project name, key, and lead of the default project (from `JIRA_PROJECT_KEY`).

### List All Projects
```
jira projects
```
Returns every project visible to the authenticated user: `[{ id, key, name, lead }]`. Use this to resolve a project name mentioned in conversation (e.g. user says "PROJ") to the correct project key before calling `jira create --project KEY`.

### Get Assignable Users
```
jira users
```
Returns list of users who can be assigned issues in this project.

### Get Workload
```
jira workload
```
Returns current workload for all developers:
- Open issues count
- Total story points
- WIP (Work In Progress) count
- Issues by status

### Attach File
```
jira attach <ISSUE_KEY> <FILE_PATH>
```
Attaches a file to an existing issue.

**Example:** `jira attach TEST-123 ./screenshot.png`

## Usage Notes
- All queries use Basic Auth for JIRA Server
- Story points are stored in custom field (customfield_10107)
- Default SP = 3 when not specified
- Pagination is automatic for large result sets

## How to Run Commands

Use the **bash** tool to run JIRA commands. The script is located in the workspace.

```bash
# Search issues
bash workdir:/home/node/.openclaw/workspace command:"node skills/pm-jira/scripts/jira.js search 'project = TEST AND statusCategory != Done'"

# Get workload
bash workdir:/home/node/.openclaw/workspace command:"node skills/pm-jira/scripts/jira.js workload"

# Create issue
bash workdir:/home/node/.openclaw/workspace command:"node skills/pm-jira/scripts/jira.js create --summary 'Fix login bug' --assignee 'alex' --sp 3 --due '2024-03-15'"

# Get users
bash workdir:/home/node/.openclaw/workspace command:"node skills/pm-jira/scripts/jira.js users"
```

## Environment Variables Required
Configured in `.env` file in workspace:
- `JIRA_URL`: JIRA Server URL
- `JIRA_USERNAME`: JIRA username
- `JIRA_PASSWORD`: JIRA password
- `JIRA_PROJECT_KEY`: Default project key
