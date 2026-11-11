---
name: x-com
description: X.com browser automation for reading and researching posts. Use when the user mentions X, Twitter, tweets, posts on x.com, Elon Musk posts, OpenClaw posts, or asks to search X.com and summarize findings.
---

# X.com Browser Automation

URL: `https://x.com/`
Account: use the existing Chrome session through browser automation. Treat this as a read-only research skill unless the user explicitly asks to post, reply, like, repost, follow, or DM.

## Default Research Workflow

1. Navigate to `https://x.com/` and take a fresh snapshot.
2. If X shows a sign-in wall, checkpoint, rate-limit page, or blocked content, report that plainly and stop unless a logged-in session is available.
3. Search with X search URLs first, then fall back to the visible search box if the URL does not load:
   - Elon Musk posts: `https://x.com/search?q=from%3Aelonmusk&src=typed_query&f=live`
   - OpenClaw posts or mentions: `https://x.com/search?q=%22OpenClaw%22%20OR%20openclaw&src=typed_query&f=live`
4. Use `Latest` / live results for recent findings unless the user asks for top or popular posts.
5. Open promising posts in their own page before recording them, so the final report can include a stable post URL.
6. Return concise findings with author display name, handle, date/time if visible, post link, short summary, and any visible engagement counts.

## Elon Musk Searches

- Interpret `Elon Mask` as `Elon Musk` unless the user clearly means another person.
- Prefer the verified `@elonmusk` profile or `from:elonmusk` search operator.
- Do not summarize impersonator accounts as Elon Musk posts. If the handle is not `@elonmusk`, label it as a mention or unrelated result.

## OpenClaw Searches

- Do not assume an official OpenClaw account exists.
- Search both exact-case and lowercase mentions.
- If an account appears official, verify from the profile bio, handle, pinned post, linked website, or repeated branding before calling it official.
- Separate findings into:
  - official-looking OpenClaw posts, if verified enough
  - third-party mentions of OpenClaw
  - unclear/noisy matches

## Interaction Rules

- Use snapshots before clicking and after any navigation error.
- Do not click ads, promoted posts, external links, media overlays, like, repost, reply, follow, subscribe, or message unless explicitly requested.
- Prefer keyboard search only after URL search fails.
- Scroll incrementally and collect a small evidence set rather than dumping the feed.
- If content is stale, hidden, or unavailable, say so and include the search query used.

## Report Format

For each search topic, provide:

```text
Topic: <Elon Musk posts | OpenClaw posts>
Query used: <query or URL>
Findings:
- <author> (@handle), <date/time if visible>: <one-sentence summary> <post URL>
Notes: <login wall/rate limit/no official account/uncertain result, if relevant>
```
