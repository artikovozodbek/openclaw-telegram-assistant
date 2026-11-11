---
name: notion-web
description: Notion browser automation — read pages, create notes, search workspace. Use when user mentions Notion, notes, wiki, documentation, or workspace pages.
---

# Notion Web Automation

URL: `https://www.notion.so/`
Account: already logged into user's workspace.

## Read a Page

1. Navigate to the page URL directly, or find via sidebar/search
2. `snapshot` to read content blocks
3. `scroll down` for long pages (content loads lazily)

## Create a New Page

1. Navigate to Notion
2. `snapshot` — find "New page" or "+" button in left sidebar
3. Click it — new blank page opens with "Untitled" placeholder
4. `type` the page title → press Enter
5. Cursor moves to body. `type` content directly
6. For formatting: type `/` to open slash command menu, then type block type (e.g., `/heading`, `/todo`, `/bullet`)

## Search Workspace

1. `snapshot` — find "Search" in left sidebar (or use keyboard shortcut)
2. Click Search — modal appears
3. `type` search query
4. Results appear in real-time — click a result to navigate

## Gotchas

- **`contenteditable` blocks** — Notion has a custom editor. Must use keyboard `type` action (sends real key events). Setting innerHTML/textContent directly WILL NOT WORK
- **Block structure** — each paragraph, heading, list item is a separate block. Press Enter to create new blocks, arrow keys to move between them
- **Slash commands** — type `/` to trigger the command palette for headings, lists, toggles, etc.
- **Lazy loading** — long pages don't load all content until scrolled. Scroll + snapshot to get full content
- **React-based DOM** — nodes may be recreated during re-renders. Always re-snapshot after navigation or significant interaction
- **After any element error** → re-snapshot immediately
