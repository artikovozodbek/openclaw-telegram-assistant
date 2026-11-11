---
name: competitor-analyzer
description: 'Competitor intelligence — register, analyze web/social presence, detect changes. Use when user asks about competitors, competitor analysis, market intelligence, or конкуренты.'
metadata:
  {
    "openclaw": { "emoji": "🔍" }
  }
---

# Competitor Analyzer

Track competitors across web and social media. Deep analysis on first run, change detection on subsequent runs.

## Commands

Run via exec tool:
```bash
node skills/competitor-analyzer/scripts/competitor.js <command> [args]
```

### Register Competitor
```
competitor add "<name>" --website "<url>" --instagram "<handle>" --telegram "<url>"
```
All source flags are optional. Add what you have.

### List Competitors
```
competitor list
```

### Load Snapshot
```
competitor snapshot "<name>"
```
Returns stored snapshot + flags (`hasSnapshot`, `firstAnalysisComplete`, `discoveryComplete`).

### Save Snapshot
```
competitor save "<name>" --data-file <path>
```
Save scraped data. Write JSON to a temp file first, pass the path. The script computes hashes and sets timestamps automatically.

### Diff Against Snapshot (LLM-driven, auto-Gemini)
```
competitor diff "<name>" --data-file <path>
```
Runs the periodic comparison in three stages:

1. **Structural diff** — cheap mechanical pass: metric deltas, website-section hash compare, new-post counts. Always runs.
2. **Auto video analysis** — scans `newData.instagram.posts` for `type: "video"` entries that are newer than `oldSnapshot.instagram.lastVideoDate` AND not already in `oldSnapshot.videoAnalyses` (matched by URL). Each candidate is exported via Chrome CDP and run through Gemini 3.1 Pro. Results are appended to `newData.videoAnalyses` so the next stage can compare them. **The diff itself is now responsible for ensuring video analyses are fresh — the agent no longer needs to call `analyze-instagram-video` separately during scrape.**
3. **Semantic diff via GPT-5.4** — one focused LLM call per source (website, instagram, telegram, linkedin, facebook, videos). For each source: reads old vs new state and emits business-meaningful signals (pricing changes, hiring, partnerships, content shifts, tone shifts in videos) instead of raw counts.

Flags:
- `--no-llm` — skip the semantic stage, return structural only (instant)
- `--no-video-analyze` — skip the auto-Gemini stage (use when scrape already analyzed reels)

Output shape:
```json
{
  "competitor": "...",
  "previousAnalysis": "ISO",
  "daysSinceLastAnalysis": 1,
  "structural": { "metrics": {...}, "website": {...}, "newContent": {...} },
  "videoAutoAnalysis": {
    "triggered": 2,
    "analyzed": 2,
    "errors": [],
    "candidates": [{ "reelUrl": "...", "date": "..." }]
  },
  "semantic": {
    "hasChanges": true,
    "comparedAt": "ISO",
    "executiveSummary": "1-2 предложения резюме на русском",
    "topSignals": [
      { "source": "website", "type": "pricing_change", "importance": "high", "description": "..." }
    ],
    "sources": {
      "website":   { "hasChanges": true, "summary": "...", "signals": [...], "changedSections": [...] },
      "instagram": { "hasChanges": true, "summary": "...", "signals": [...] },
      "telegram":  { "hasChanges": true, "summary": "...", "signals": [...] },
      "linkedin":  { ... },
      "videos":    { ... }
    }
  },
  "warning": "llm_unavailable",   // present only if all LLM calls failed
  "llmError": "..."
}
```

If `CELION_API_KEY` is unset or all LLM calls fail, `semantic` is `null` and `warning: "llm_unavailable"` is set — the structural diff still goes through so reports never come back empty.

### Add Source
```
competitor add-source "<name>" --linkedin "<value>" --facebook "<value>"
```
Add discovered sources. Supported: `--website`, `--instagram`, `--telegram`, `--linkedin`, `--facebook`.

(YouTube, TikTok, and Twitter/X are intentionally NOT tracked — skip them.)

### Mark Discovery Complete
```
competitor mark-discovered "<name>"
```

### Remove Competitor
```
competitor remove "<name>"
```

### Analyze Instagram Video/Reel
Use this for any real Instagram reel/video analysis. This command owns browser export, the Gemini call, snapshot update, and temp-file cleanup.
```
competitor analyze-instagram-video "<name>" --reel-url "<instagram_reel_url>" --date "<iso>" --caption "<text>" --likes "<n>" --comments "<n>"
```
Optional:
- `--video-url "<direct_mp4_url>"` if you already have a direct file URL
- `--file "/tmp/openclaw/uploads/already_downloaded.mp4"` if a local file already exists
- `--browser-target-id "<targetId>"` if the reel is already open in the browser; prefer this for Instagram overlays or reels that do not reopen cleanly in a fresh tab

### Analyze Multiple Instagram Videos/Reels
Write a manifest JSON file first, then run one command:
```json
{
  "videos": [
    {
      "reelUrl": "https://www.instagram.com/reel/...",
      "date": "2026-03-31T10:00:00Z",
      "caption": "...",
      "likes": 8,
      "comments": 3
    }
  ]
}
```
```
competitor analyze-instagram-videos "<name>" --manifest-file /tmp/openclaw/uploads/competitor_reels_<timestamp>.json
```

## Decision Flow

When asked to analyze a competitor or when running periodic check:

1. Call `competitor snapshot "<name>"`
2. Check the response:

```
discoveryComplete = false  →  DISCOVERY PHASE (see below)
hasSnapshot = false OR firstAnalysisComplete = false  →  FULL ANALYSIS
hasSnapshot = true AND firstAnalysisComplete = true  →  PERIODIC DIFF
```

## Phase 1: Discovery (first time only)

**The website URL is REQUIRED when adding a competitor.** Without it, refuse to proceed and ask the CEO for it. The company's own website is the authoritative source for their social channels — we trust it first and do not rely on general web search.

Discovery procedure:

1. **Fetch the company website** using `web_fetch` on:
   - Homepage (`https://<domain>/`)
   - Contact page (`/contact`, `/contacts`, `/kontakt`, `/contact-us`) — social icons are usually here too
2. **Extract social media URLs** from the fetched HTML/markdown. Look in:
   - Footer (most common place for social icons)
   - Header / top navigation
   - Contact section
   - Parse `href` attributes of links pointing to `instagram.com`, `t.me`, `linkedin.com`, `facebook.com`, `fb.com`
3. **Only track**: Instagram, Telegram, LinkedIn, Facebook. If the site links to YouTube, TikTok, or Twitter/X — **ignore them**, they are not in scope.
4. If the website is JS-heavy and `web_fetch` returns no social links, fall back to the browser: navigate to the site via Chrome CDP, snapshot the page, find social anchors.
5. **Do NOT use `web_search`** as the primary discovery method. Only use it as a last resort if the website is completely unreachable, and clearly flag this to the CEO.
6. Send message to the CEO with what was found on the website:
   ```
   Сэр, на сайте <Name> нашёл следующие соцсети:
   - Instagram: @<handle>
   - LinkedIn: <url>
   - Facebook: <url>
   Добавить их в анализ?
   ```
7. Wait for the CEO's response
8. For each confirmed source: call `competitor add-source "<name>" --<platform> "<value>"`
9. Call `competitor mark-discovered "<name>"`
10. Proceed to FULL ANALYSIS

## Phase 2: Full Analysis

Scrape ALL confirmed sources and collect structured data.

### First-Time Depth Rule (IMPORTANT)

On the **first analysis** of a competitor, keep the deep-content pass minimal — just enough to establish a baseline. Do NOT batch-analyze everything available:

- **Instagram reels (Gemini video analysis):** the **single latest reel only** — not 5, not "all recent". One reel is enough to capture format/tone for the baseline.
- **Instagram posts (caption + meaning):** the **single latest post**. Read its caption fully and capture content theme. Other posts: metadata only (date, likes, comments, type) — no per-post content read.
- **Telegram posts:** the **latest 10 posts**. Read full text on each, extract meaning per post + overall channel themes. Older posts: metadata only.
- **Website:** all 9 sections in full (cheap, no LLM cost on scrape — only diff phase calls LLM).

This keeps first-run cost predictable. On periodic diff runs, the LLM diff (`competitor diff`) will pick up everything new automatically.

### Data Structure to Collect

Write a JSON object with these sections:

```json
{
  "website": {
    "description": "what the company does",
    "products": "list of products/services",
    "pricing": "pricing plans and prices",
    "team": "team size, key people",
    "features": "key features",
    "messaging": "main value proposition, headlines",
    "technology": "tech stack if visible",
    "testimonials": "notable clients/testimonials",
    "contact": "contact info, office locations"
  },
  "instagram": {
    "followers": 15200,
    "following": 340,
    "postCount": 890,
    "bio": "profile bio text",
    "engagementRate": 3.2,
    "posts": [
      { "date": "2026-03-25T10:00:00Z", "caption": "...", "likes": 120, "comments": 5, "type": "image" }
    ],
    "contentThemes": ["product demos", "team culture", "client stories"]
  },
  "telegram": {
    "subscribers": 920,
    "description": "channel description",
    "postingFrequency": "5/week",
    "posts": [
      { "date": "2026-03-25T10:00:00Z", "text": "...", "views": 450, "forwards": 12, "hasMedia": true, "mediaType": "photo" }
    ],
    "contentThemes": ["announcements", "tips", "promotions"]
  },
  "videoAnalyses": [
    { "source": "instagram", "date": "2026-03-25T10:00:00Z", "summary": "...", "keyIntel": ["new feature X", "pricing change"] }
  ]
}
```

### Scraping Instructions

#### Website
Use `web_fetch` tool on key pages:
- Homepage (`https://<domain>/`)
- Pricing page (`/pricing`, `/plans`, `/tariffs`)
- About page (`/about`, `/team`, `/company`)
- Products page (`/products`, `/services`, `/features`)

Extract text content for each section. If a page doesn't exist, skip it.

#### Instagram
Use `browser` tool:
1. Navigate to `https://www.instagram.com/<handle>/`
2. Snapshot — read follower count, following, post count, bio from accessibility tree
3. Scroll through the post grid — extract last 12 posts (captions, likes, comments, dates)
4. Identify video/reel posts by type
5. Calculate engagement rate: `(avg_likes + avg_comments) / followers * 100`
6. Identify 3-5 content themes from post captions

#### Telegram
Prefer `web_fetch` on `https://t.me/s/<channel>` (public preview page — no browser needed):
- Extract subscriber count, description, recent posts (text, views, forwards, media type)
- If channel is private (no public preview), use browser on `https://web.telegram.org/k/` to find and read the channel

#### LinkedIn (if confirmed)
Use `browser` tool:
- Navigate to company page
- Extract: employee count, about section, recent posts, industry
- Note: LinkedIn may require scrolling and has aggressive anti-scraping — be gentle

#### Other Platforms
Adapt scraping approach based on what's available. Use `web_fetch` for public pages, `browser` for authenticated ones.

### Video Analysis Pipeline

For video content (Instagram reels, Telegram videos):

1. **Identify**: While scraping posts, note which are videos
2. **Filter**:
   - **First-time: analyze ONLY the single latest video** (most recent reel). Do not batch multiple reels on the first run — one is enough to establish the baseline.
   - **Periodic: only videos NEWER than `lastVideoDate`** from snapshot. If none, skip video analysis entirely.
3. **Model requirement**: For Instagram video analysis, the analysis step MUST use `google/gemini-3.1-pro-preview` on the downloaded video file itself. This is mandatory every time. Do not replace it with caption reading, UI reading, or generic inference.
4. **Browser work**: Use the browser to identify the reels, open each reel, and collect metadata (reel URL, date, caption, likes, comments). Capture the current browser `targetId` for the open reel page if available. If you can see a direct `.mp4` URL, collect it. If the video is only exposed as a browser `blob:` stream, that is fine.
5. **Execution rule**: After collecting metadata, DO NOT manually orchestrate export/download + Gemini + save in chat. Run the native command instead:
   ```bash
   node skills/competitor-analyzer/scripts/competitor.js analyze-instagram-video "<name>" --reel-url "<instagram_reel_url>" --browser-target-id "<current_browser_target_id>" --date "<iso>" --caption "<text>" --likes "<n>" --comments "<n>"
   ```
   If the reel is already open in the browser, prefer passing `--browser-target-id` so the native command can export from that live page instead of reopening the URL in a fresh tab. Do not navigate away from the reel page before calling the command.
   If you already have a direct file URL, you may add `--video-url "<direct_mp4_url>"`, but it is no longer required.
   For multiple reels, write a manifest file and run:
   ```bash
   node skills/competitor-analyzer/scripts/competitor.js analyze-instagram-videos "<name>" --manifest-file /tmp/openclaw/uploads/competitor_reels_<timestamp>.json
   ```
6. **Required outputs from Gemini**:
   - Speech transcription or spoken message
   - Visual description (what's shown: products, UI, demos)
   - Key business intelligence (pricing, features, announcements)
7. **Failure rule**: If `competitor analyze-instagram-video(s)` fails, report that Gemini video analysis failed. Do NOT fall back to caption-only or UI-only analysis and do NOT pretend the reel was analyzed. "Instagram only exposed a blob stream" is NOT by itself a valid stopping reason anymore; the native command handles blob-backed reels.
8. **Save rule**: The native command is responsible for appending `videoAnalysisEntry` to `videoAnalyses`, updating snapshot metadata, and deleting temp files.
9. **Honesty rule**: NEVER say a video was analyzed by Gemini unless the native command completed successfully and returned `success: true`.

### Save the Data

After collecting all data:
1. Write the JSON to a temp file:
   ```bash
   echo '<json>' > /tmp/openclaw/uploads/competitor_<timestamp>.json
   ```
   Or use the `write` tool to create the file.
2. Call `competitor save "<name>" --data-file /tmp/openclaw/uploads/competitor_<timestamp>.json`
3. Delete the temp file

## Phase 3: Periodic Diff

For competitors with `firstAnalysisComplete = true`:

1. Call `competitor snapshot "<name>"` — get the stored snapshot
2. Scrape current state of all sources (same as full analysis but selective):
   - **Metrics**: always collect current numbers (followers, subscribers, etc.)
   - **Posts**: collect ALL recent posts including text/captions and `type: "video"` flag for reels. The diff stage reads post bodies via LLM, so include full text — not just metadata.
   - **Videos**: do NOT call `analyze-instagram-video` manually here. Just include reel posts in `instagram.posts` with `type: "video"` and a `reelUrl` field — the `competitor diff` command will auto-export and run Gemini on any unanalyzed new reels itself.
   - **Website**: scrape same pages — the script will hash and detect changes
3. Write current data to temp file
4. Call `competitor diff "<name>" --data-file <path>` — runs auto-Gemini on new reels + LLM semantic diff across all sources
5. Call `competitor save "<name>" --data-file <path>` — update the snapshot
6. Generate report from diff result (use `semantic.executiveSummary` + `semantic.topSignals`)

## Report Formats

### First-Time Analysis Report (Russian, JARVIS style)

```
🔍 Анализ конкурента: <Name>

<1-2 предложения: кто они, чем занимаются, позиционирование>

🌐 Сайт (<url>):
- Продукты: <список>
- Цены: <ключевые цены или "не указаны публично">
- Команда: <размер, ключевые люди>
- Позиционирование: <главный посыл>

📸 Instagram (<handle>): <followers> подп. | <posts> постов | вовлечённость <X>%
<основные темы контента — 1 предложение>

📢 Telegram (<channel>): <subscribers> подп. | ~<X> постов/нед
<основные темы>

🎬 Видео (<count> проанализировано): <ключевые находки>

💡 Ключевые выводы:
- <сила>
- <слабость/возможность>

Данные сохранены. Следующая проверка завтра, сэр.
```

### Periodic Diff Report (semantic intel format)

The `competitor diff` command returns BOTH a `semantic` block (LLM intel — primary source) and a `structural` block (cheap mechanical metrics — secondary). Build the report from `semantic` first; pull numeric deltas from `structural.metrics`.

Use this template:

```
🔍 Изменения у <Name> за <N> дней:

<semantic.executiveSummary — 1-2 предложения сути>

📊 Метрики:
- Instagram: <old>→<new> подп. (<+delta>)
- Telegram: <old>→<new> подп. (<+delta>)
(только источники, где есть изменения)

🌐 Сайт: <semantic.sources.website.summary>
<для каждого signal с importance=high: "🔴 <description>">
<для каждого signal с importance=medium: "🟡 <description>">

📸 Instagram: <semantic.sources.instagram.summary>
<сигналы, по убыванию важности>

📢 Telegram: <semantic.sources.telegram.summary>
<сигналы — особенно anouncements, hiring, partnerships>

💼 LinkedIn / Facebook / X: <если есть semantic.sources.<X>.hasChanges>

🎬 Видео: <semantic.sources.videos.summary, если есть новые>

⚠️ Топ-сигналы (отсортированы по важности):
<semantic.topSignals[0..4] — по 1 строке: "<emoji важности> [<source>] <description>">

Данные обновлены, сэр.
```

Importance → emoji mapping: `high` = 🔴, `medium` = 🟡, `low` = 🟢.

If `warning: "llm_unavailable"` is in the result → fall back to the structural-only abbreviated report and add a single line: *"Семантический анализ недоступен сейчас — показаны только базовые метрики."*

### No Changes Report

```
🔍 <Name> — без существенных изменений за последние <N> дней, сэр.
📊 Instagram: <followers> подп. | Telegram: <subscribers> подп.
Продолжаю мониторинг.
```

## Error Handling

- **Source unavailable**: Skip it, note in report ("сайт недоступен"), continue with other sources
- **Instagram login wall**: Refresh page, wait 5 seconds, retry once. If still blocked, skip Instagram
- **Private Telegram channel**: Note "приватный канал" in report, skip
- **Video download fails**: Save `"analysis_failed"` as summary, continue. Still delete any partial file
- **Browser errors**: Re-snapshot, retry up to 3 times (3-strike rule from SOUL.md)
- **Large data**: Always use `--data-file`, never pass JSON directly via CLI args
- **Gemini API error**: Skip video analysis, note in report, continue
- **No changes detected**: Use the "No Changes Report" format — don't generate a long empty report

## Delivery (for cron jobs)

When running as a cron job, deliver results using this exact pattern:

1. Send text report via `message` tool (channel: telegram, to: <chatId>, buttons: `[]`)
2. Generate the voice summary ONLY via `exec`, not the `tts` tool:
   ```bash
   node /home/node/.openclaw/workspace/skills/tts-send/tts-send.js "[warm] Сэр, отчёт по конкурентам готов. [matter-of-fact] У <Name> подписчики выросли на <N>. <Ключевое наблюдение>. [calm] Детали в сообщении." /tmp/openclaw/uploads/competitor_report.mp3
   ```
3. First create `/tmp/openclaw/uploads` via the default `exec` environment if needed. Use the default `exec` environment only; do not set `host=node` or sandbox overrides for TTS generation.
4. Verify that `/tmp/openclaw/uploads/competitor_report.mp3` exists and is not empty. If it was not created, stop with an error and do not substitute another path.
5. Send the voice report via `message` tool (channel: telegram, to: <chatId>, media: `/tmp/openclaw/uploads/competitor_report.mp3`, asVoice: true, buttons: `[]`)
6. Do not use `tts`, `audioPath`, `.opus`, `/tmp/openclaw-tts-*`, or `/tmp/openclaw/tts-*` in cron delivery.
