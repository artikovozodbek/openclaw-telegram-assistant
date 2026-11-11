---
name: pm-tasks
description: Task queue for collecting PM tasks before batch JIRA creation
metadata: {"openclaw.emoji":"📝"}
---

# PM Task Queue

Collect tasks throughout conversation, then batch-create JIRA issues.

## Commands

### Add Task
```
tasks add "<description>" [--type text|voice|photo]
```
Add a task to the queue for later processing.

**Parameters:**
- `description`: Task description
- `--type` (optional): Source type - text, voice, or photo

**Examples:**
- `tasks add "Add calendar screen for attendance"`
- `tasks add "Fix login bug on mobile" --type text`

### List Tasks
```
tasks list [--chat <chat_id>]
```
Show all collected tasks. Optionally filter by chat ID.

### Count Tasks
```
tasks count [--chat <chat_id>]
```
Return number of pending tasks.

### Clear Tasks
```
tasks clear [--chat <chat_id>]
```
Remove all pending tasks. Optionally clear only for specific chat.

### Process Tasks
```
tasks process [--chat <chat_id>]
```
Process all collected tasks:
1. Gather JIRA context (workload, experience)
2. Query Brain for PM directives
3. Analyze and assign developers
4. Create JIRA issues
5. Clear queue after successful creation

## Workflow

1. User describes tasks throughout conversation
2. Tasks are collected in queue with `tasks add`
3. When user says "create"/"go"/"stop" -> `tasks process`
4. JIRA issues created with proper assignments
5. Queue cleared after successful creation

## Special Modes

### Brain Mode
```
tasks brain-mode enable [--chat <chat_id>]
tasks brain-mode check [--chat <chat_id>]
tasks brain-mode disable [--chat <chat_id>]
```
When enabled, next message is stored in Brain instead of task queue.

### Collection Mode
```
tasks collection-mode enable [--chat <chat_id>]
tasks collection-mode check [--chat <chat_id>]
tasks collection-mode disable [--chat <chat_id>]
```
When enabled, all messages are added to task queue automatically.

## Storage

Tasks are stored in `agents/default/data/task_queue.json`:
```json
{
  "tasks": [
    {
      "chatId": "123456",
      "text": "Add calendar feature",
      "type": "text",
      "timestamp": "2024-03-01T10:00:00Z"
    }
  ],
  "brain_mode": {},
  "collection_mode": {}
}
```
