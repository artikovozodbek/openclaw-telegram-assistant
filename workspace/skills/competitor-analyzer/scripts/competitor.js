#!/usr/bin/env node
/**
 * Competitor Analyzer Skill - CLI Script
 * Data management for competitor intelligence
 *
 * Usage:
 *   competitor add "<name>" --website "<url>" --instagram "<handle>" --telegram "<url>"
 *   competitor list
 *   competitor snapshot "<name>"
 *   competitor save "<name>" --data-file <path>
 *   competitor diff "<name>" --data-file <path>
 *   competitor add-source "<name>" --<platform> "<value>"
 *   competitor mark-discovered "<name>"
 *   competitor remove "<name>"
 *   competitor analyze-instagram-video "<name>" --reel-url "<url>" [--browser-target-id "<targetId>" | --video-url "<mp4_url>" | --file "/tmp/video.mp4"] --date "<iso>"
 *   competitor analyze-instagram-videos "<name>" --manifest-file <path>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { analyzeWithGPT } = require('./lib/llm');

// Data paths
const dataDir = path.join(__dirname, '../../../agents/default/data/competitors');
const registryPath = path.join(dataDir, '_registry.json');

// --- Utilities ---

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_|_$/g, '');
}

function hashText(text) {
  if (!text || typeof text !== 'string') return null;
  return crypto.createHash('md5').update(text.trim()).digest('hex');
}

function snapshotPath(slug) {
  return path.join(dataDir, `${slug}.json`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function uploadsDir() {
  const dirPath = path.join(os.tmpdir(), 'openclaw', 'uploads');
  ensureDir(dirPath);
  return dirPath;
}

function loadRegistry() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    return { competitors: [] };
  }
}

function saveRegistry(registry) {
  ensureDataDir();
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function loadSnapshot(slug) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(slug), 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshotFile(slug, data) {
  ensureDataDir();
  fs.writeFileSync(snapshotPath(slug), JSON.stringify(data, null, 2));
}

function findCompetitor(registry, name) {
  const slug = slugify(name);
  return registry.competitors.find(c => c.slug === slug || c.name.toLowerCase() === name.toLowerCase());
}

function loadDataFromFileOrArg(args) {
  if (args['data-file']) {
    try {
      return JSON.parse(fs.readFileSync(args['data-file'], 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read data file: ${e.message}`);
    }
  }
  if (args.data) {
    try {
      return JSON.parse(args.data);
    } catch (e) {
      throw new Error(`Failed to parse --data JSON: ${e.message}`);
    }
  }
  throw new Error('Provide --data-file <path> or --data \'<json>\'');
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeFileToken(value, fallback = 'video') {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeComparableUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseIntegerLike(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function maxIsoDate(currentIso, candidateIso) {
  if (!candidateIso) return currentIso || null;
  const candidate = new Date(candidateIso);
  if (Number.isNaN(candidate.getTime())) return currentIso || null;
  if (!currentIso) return candidate.toISOString();
  const current = new Date(currentIso);
  if (Number.isNaN(current.getTime()) || candidate > current) {
    return candidate.toISOString();
  }
  return current.toISOString();
}

function ensureSnapshotShape(snapshot) {
  const next = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (!next.instagram || typeof next.instagram !== 'object') next.instagram = {};
  if (!Array.isArray(next.instagram.posts)) next.instagram.posts = [];
  if (!Array.isArray(next.videoAnalyses)) next.videoAnalyses = [];
  return next;
}

function upsertVideoAnalysis(snapshot, entry) {
  const normalizedEntryUrl = normalizeComparableUrl(entry.url);
  const index = snapshot.videoAnalyses.findIndex(existing => {
    const sameUrl = normalizedEntryUrl && normalizeComparableUrl(existing.url) === normalizedEntryUrl;
    const sameIdentity =
      existing.source === entry.source &&
      existing.date === entry.date &&
      String(existing.caption || '') === String(entry.caption || '');
    return sameUrl || sameIdentity;
  });

  if (index >= 0) {
    snapshot.videoAnalyses[index] = entry;
  } else {
    snapshot.videoAnalyses.push(entry);
  }
}

function buildVideoRecord(raw, args, index) {
  return {
    source: raw.source || args.source || 'instagram',
    reelUrl: raw.reelUrl || raw.postUrl || raw.url || args['reel-url'] || args.url || null,
    browserTargetId: raw.browserTargetId || raw.targetId || args['browser-target-id'] || null,
    videoUrl: raw.videoUrl || raw.mediaUrl || raw.downloadUrl || args['video-url'] || null,
    file: raw.file || args.file || null,
    date: raw.date || args.date || null,
    caption: raw.caption || args.caption || null,
    likes: raw.likes ?? args.likes ?? null,
    comments: raw.comments ?? args.comments ?? null,
    sequence: index + 1
  };
}

function loadVideoRecords(args) {
  if (args['manifest-file']) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(args['manifest-file'], 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read manifest file: ${e.message}`);
    }

    const rawItems = Array.isArray(manifest)
      ? manifest
      : Array.isArray(manifest.videos)
        ? manifest.videos
        : Array.isArray(manifest.items)
          ? manifest.items
          : [];

    if (rawItems.length === 0) {
      throw new Error('Manifest file must contain an array or a "videos" / "items" array');
    }

    return rawItems.map((item, index) => buildVideoRecord(item, args, index));
  }

  return [buildVideoRecord({}, args, 0)];
}

function downloadVideoToFile(videoUrl, destinationPath) {
  try {
    execFileSync(
      'curl',
      ['-L', '--fail', '--silent', '--show-error', '-o', destinationPath, videoUrl],
      { stdio: 'pipe' }
    );
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : error.message;
    throw new Error(`Failed to download video: ${stderr.trim()}`);
  }
}

function runGeminiVideoWorker(params) {
  const workerPath = path.join(__dirname, 'gemini-video-analyze.js');
  const commandArgs = [
    workerPath,
    '--file', params.file,
    '--source', params.source || 'instagram',
    '--model', params.model || 'gemini-3.1-pro-preview',
    '--output-file', params.outputFile
  ];

  if (params.date) commandArgs.push('--date', params.date);
  if (params.caption) commandArgs.push('--caption', params.caption);
  if (params.likes != null) commandArgs.push('--likes', String(params.likes));
  if (params.comments != null) commandArgs.push('--comments', String(params.comments));
  if (params.url) commandArgs.push('--url', params.url);

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : error.message;
    throw new Error(`Gemini video worker failed: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    try {
      return JSON.parse(fs.readFileSync(params.outputFile, 'utf8'));
    } catch (error) {
      throw new Error(`Gemini video worker returned unreadable JSON: ${error.message}`);
    }
  }
}

function exportVideoFromBrowser(params) {
  const exporterPath = path.join(__dirname, 'export-instagram-video.js');
  const commandArgs = [exporterPath, '--output-file', params.outputFile];

  if (params.reelUrl) commandArgs.push('--reel-url', params.reelUrl);
  if (params.targetId) commandArgs.push('--target-id', params.targetId);

  if (params.timeoutMs != null) commandArgs.push('--timeout-ms', String(params.timeoutMs));
  if (params.cdpUrl) commandArgs.push('--cdp-url', params.cdpUrl);
  if (params.keepPage) commandArgs.push('--keep-page');

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : error.message;
    throw new Error(`Browser video export failed: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Browser video export returned unreadable JSON: ${error.message}`);
  }
}

// --- Hash website sections ---

function computeWebsiteHashes(websiteData) {
  if (!websiteData) return {};
  const hashes = {};
  const fields = ['description', 'products', 'pricing', 'team', 'features', 'messaging', 'technology', 'testimonials', 'contact'];
  for (const field of fields) {
    if (websiteData[field]) {
      hashes[field] = hashText(websiteData[field]);
    }
  }
  return hashes;
}

// --- Diff logic ---

function computeDiff(oldSnapshot, newData) {
  const changes = {
    hasChanges: false,
    metrics: {},
    website: { changedSections: [], unchanged: [] },
    newContent: { instagramPosts: 0, instagramVideos: 0, telegramPosts: 0 }
  };

  // Metric diffs
  const metricPairs = [
    ['instagram_followers', 'instagram.followers'],
    ['instagram_following', 'instagram.following'],
    ['instagram_postCount', 'instagram.postCount'],
    ['telegram_subscribers', 'telegram.subscribers']
  ];

  for (const [key, dotPath] of metricPairs) {
    const parts = dotPath.split('.');
    const oldVal = parts.reduce((o, k) => o?.[k], oldSnapshot);
    const newVal = parts.reduce((o, k) => o?.[k], newData);
    if (oldVal != null && newVal != null && oldVal !== newVal) {
      const delta = newVal - oldVal;
      changes.metrics[key] = {
        old: oldVal,
        new: newVal,
        delta,
        pct: oldVal !== 0 ? parseFloat(((delta / oldVal) * 100).toFixed(2)) : null
      };
      changes.hasChanges = true;
    }
  }

  // Website section diffs (hash-based)
  const oldHashes = oldSnapshot?.website?._hashes || {};
  const newHashes = newData?.website?._hashes || computeWebsiteHashes(newData?.website);
  const allSections = new Set([...Object.keys(oldHashes), ...Object.keys(newHashes)]);
  for (const section of allSections) {
    if (oldHashes[section] && newHashes[section]) {
      if (oldHashes[section] !== newHashes[section]) {
        changes.website.changedSections.push(section);
        changes.hasChanges = true;
      } else {
        changes.website.unchanged.push(section);
      }
    } else if (newHashes[section] && !oldHashes[section]) {
      changes.website.changedSections.push(section);
      changes.hasChanges = true;
    }
  }

  // New Instagram posts
  const oldLastPostDate = oldSnapshot?.instagram?.lastPostDate;
  if (oldLastPostDate && newData?.instagram?.posts) {
    const cutoff = new Date(oldLastPostDate);
    const newPosts = newData.instagram.posts.filter(p => new Date(p.date) > cutoff);
    changes.newContent.instagramPosts = newPosts.length;
    if (newPosts.length > 0) changes.hasChanges = true;
  }

  // New Instagram videos
  const oldLastVideoDate = oldSnapshot?.instagram?.lastVideoDate;
  if (oldLastVideoDate && newData?.instagram?.posts) {
    const cutoff = new Date(oldLastVideoDate);
    const newVideos = newData.instagram.posts.filter(p => p.type === 'video' && new Date(p.date) > cutoff);
    changes.newContent.instagramVideos = newVideos.length;
    if (newVideos.length > 0) changes.hasChanges = true;
  }

  // New Telegram posts
  const oldTgLastDate = oldSnapshot?.telegram?.lastPostDate;
  if (oldTgLastDate && newData?.telegram?.posts) {
    const cutoff = new Date(oldTgLastDate);
    const newPosts = newData.telegram.posts.filter(p => new Date(p.date) > cutoff);
    changes.newContent.telegramPosts = newPosts.length;
    if (newPosts.length > 0) changes.hasChanges = true;
  }

  return changes;
}

// --- Semantic diff (LLM-driven) ---

const SEMANTIC_SOURCES = ['website', 'instagram', 'telegram', 'linkedin', 'facebook'];
const IMPORTANCE_RANK = { high: 3, medium: 2, low: 1 };

function pickSourceData(snapshot, source) {
  if (!snapshot) return null;
  if (source === 'videos') return snapshot.videoAnalyses || null;
  return snapshot[source] || null;
}

function stripHashesForCompare(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj;
  const { _hashes, ...rest } = obj;
  return rest;
}

function buildSourcePrompt(source, oldData, newData) {
  const baseSystem = [
    'Ты — старший аналитик конкурентной разведки.',
    'Твоя задача — сравнить старое и новое состояние одного источника информации о конкуренте',
    'и выдать бизнес-значимые наблюдения, а не косметические или форматные отличия.',
    '',
    'Возвращай ТОЛЬКО JSON следующего формата (без комментариев и кодовых блоков):',
    '{',
    '  "hasChanges": boolean,                     // были ли значимые изменения',
    '  "summary": "1-2 предложения на русском",   // суть произошедшего',
    '  "signals": [                                // массив бизнес-сигналов (может быть пустым)',
    '    {',
    '      "type": "<тип сигнала>",',
    '      "importance": "high" | "medium" | "low",',
    '      "description": "<что произошло и почему это важно для бизнеса>"',
    '    }',
    '  ]',
    '}',
    '',
    'Игнорируй: переформатирование, изменение пробелов, эмодзи, мелкие правки текста без смысла.',
    'Фокус: продуктовые и стратегические сдвиги, которые меняют картину для нашего бизнеса.'
  ].join('\n');

  let typesHint = '';
  let extraSchema = '';
  let label = source;

  switch (source) {
    case 'website':
      typesHint = 'Возможные типы сигналов: pricing_change, positioning_shift, team_growth, new_product, partnership, technology_change, removed_offering, new_market.';
      extraSchema = 'Дополнительно верни поле "changedSections": [список названий изменённых разделов].';
      label = 'сайт';
      break;
    case 'instagram':
      typesHint = 'Возможные типы сигналов: audience_growth, audience_loss, content_strategy_shift, new_format, engagement_change, posting_frequency_change, new_positioning, dormant.';
      label = 'Instagram-аккаунт';
      break;
    case 'telegram':
      typesHint = 'ВАЖНО: прочитай тексты новых постов и оцени, что они говорят бизнесу. Возможные типы сигналов: announcement, hiring, partnership, product_launch, pricing_announcement, channel_revival, channel_dormant, audience_change, event.';
      label = 'Telegram-канал';
      break;
    case 'linkedin':
      typesHint = 'Возможные типы сигналов: hiring_intent, team_growth, team_shrink, new_role, partnership, b2b_move, repositioning, leadership_change.';
      label = 'LinkedIn-страница';
      break;
    case 'facebook':
      typesHint = 'Возможные типы сигналов: announcement, content_shift, audience_change, ad_campaign, event, dormant.';
      label = 'Facebook-страница';
      break;
    case 'videos':
      typesHint = 'Изучи новые видео-анализы (от Gemini): транскрипции, визуальные описания, ключевые наблюдения. Найди закономерности и сдвиги между старыми и новыми видео. Возможные типы сигналов: tone_shift, new_format, recurring_theme, product_focus, customer_focus_shift, new_messaging, brand_evolution.';
      label = 'видео конкурента';
      break;
  }

  const system = [baseSystem, '', typesHint, extraSchema].filter(Boolean).join('\n');

  const user = [
    `Сравни ${label} конкурента и определи, что изменилось по существу.`,
    '',
    'СТАРОЕ СОСТОЯНИЕ:',
    JSON.stringify(stripHashesForCompare(oldData) ?? null, null, 2),
    '',
    'НОВОЕ СОСТОЯНИЕ:',
    JSON.stringify(stripHashesForCompare(newData) ?? null, null, 2)
  ].join('\n');

  return { system, user };
}

async function analyzeSource(source, oldData, newData) {
  if (!oldData && !newData) {
    return { hasChanges: false, summary: 'данных нет', signals: [] };
  }

  const oldStr = JSON.stringify(stripHashesForCompare(oldData) ?? null);
  const newStr = JSON.stringify(stripHashesForCompare(newData) ?? null);
  if (oldStr === newStr) {
    return { hasChanges: false, summary: 'без изменений', signals: [] };
  }

  const { system, user } = buildSourcePrompt(source, oldData, newData);
  const result = await analyzeWithGPT({ system, user, maxTokens: 2500 });

  const signals = Array.isArray(result?.signals)
    ? result.signals
        .filter(s => s && typeof s === 'object')
        .map(s => ({
          type: String(s.type || 'change'),
          importance: ['high', 'medium', 'low'].includes(s.importance) ? s.importance : 'medium',
          description: String(s.description || '').trim()
        }))
        .filter(s => s.description.length > 0)
    : [];

  const out = {
    hasChanges: Boolean(result?.hasChanges) || signals.length > 0,
    summary: typeof result?.summary === 'string' ? result.summary.trim() : '',
    signals
  };

  if (Array.isArray(result?.changedSections)) {
    out.changedSections = result.changedSections.map(String);
  }

  return out;
}

async function buildExecutiveSummary(competitorName, sources, topSignals) {
  const condensed = Object.entries(sources).map(([src, data]) => ({
    source: src,
    hasChanges: data.hasChanges,
    summary: data.summary,
    signalCount: (data.signals || []).length
  }));

  const system = [
    'Ты — JARVIS-стиль ассистент сэру.',
    'На основе результатов сравнения по источникам выдай 1-2 коротких предложения на русском, отражающих главное.',
    'Тон: спокойный, деловой, без воды. Без эмодзи.',
    'Возвращай только JSON: { "summary": "..." }'
  ].join('\n');

  const user = [
    `Конкурент: ${competitorName}.`,
    '',
    'Состояние по источникам:',
    JSON.stringify(condensed, null, 2),
    '',
    'Топ-сигналы (от важных к менее важным):',
    JSON.stringify(topSignals.slice(0, 8), null, 2)
  ].join('\n');

  try {
    const result = await analyzeWithGPT({ system, user, maxTokens: 400 });
    if (typeof result?.summary === 'string' && result.summary.trim()) {
      return result.summary.trim();
    }
  } catch {
    // Fall through to heuristic summary
  }

  const high = topSignals.filter(s => s.importance === 'high').length;
  if (high > 0) return `Зафиксировано ${high} значимых изменения у ${competitorName}. Подробности по источникам.`;
  if (topSignals.length > 0) return `Незначительные изменения у ${competitorName}: ${topSignals.length} сигналов.`;
  return `${competitorName} — без существенных изменений.`;
}

/**
 * Inspect newData.instagram.posts for video posts that:
 *   - have no entry in oldSnapshot.videoAnalyses (by URL)
 *   - are newer than oldSnapshot.instagram.lastVideoDate (if set)
 * Run them through the existing analyze-instagram-videos pipeline so the
 * subsequent semantic diff has fresh Gemini summaries to compare.
 *
 * Returns { triggered, analyzed, errors, candidates, skippedReason? }.
 */
async function ensureVideosAnalyzed(comp, oldSnapshot, newData) {
  const igPosts = (newData?.instagram?.posts) || [];
  if (igPosts.length === 0) {
    return { triggered: 0, analyzed: 0, errors: [], skippedReason: 'no instagram posts in data file' };
  }

  const oldUrls = new Set();
  for (const v of (oldSnapshot?.videoAnalyses || [])) {
    if (v?.url) oldUrls.add(normalizeComparableUrl(v.url));
  }

  const lastVideoIso = oldSnapshot?.instagram?.lastVideoDate;
  const cutoff = lastVideoIso ? new Date(lastVideoIso) : null;

  const candidates = [];
  for (const post of igPosts) {
    if (post?.type !== 'video') continue;
    const url = post.reelUrl || post.url || post.permalink;
    if (!url) continue;
    if (oldUrls.has(normalizeComparableUrl(url))) continue;
    if (cutoff && post.date) {
      const postDate = new Date(post.date);
      if (!Number.isNaN(postDate.getTime()) && postDate <= cutoff) continue;
    }
    candidates.push({
      reelUrl: url,
      date: post.date || null,
      caption: post.caption || null,
      likes: post.likes ?? null,
      comments: post.comments ?? null,
      ...(post.browserTargetId ? { browserTargetId: post.browserTargetId } : {})
    });
  }

  if (candidates.length === 0) {
    return { triggered: 0, analyzed: 0, errors: [], skippedReason: 'no new unanalyzed reels' };
  }

  const manifestPath = path.join(uploadsDir(), `diff_auto_video_manifest_${Date.now()}.json`);
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify({ videos: candidates }, null, 2));

  let analyzed = 0;
  const errors = [];

  try {
    const result = competitorAnalyzeInstagramVideos(comp.name, {
      'manifest-file': manifestPath,
      'wait-ms': '3000'
    });
    analyzed = result?.analyzedCount || 0;

    // Pipeline saved fresh videoAnalyses to snapshot file. Re-load so the
    // subsequent semantic diff sees them as the "new" side of the comparison.
    const updatedSnapshot = loadSnapshot(comp.slug);
    if (Array.isArray(updatedSnapshot?.videoAnalyses)) {
      newData.videoAnalyses = updatedSnapshot.videoAnalyses;
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    if (fs.existsSync(manifestPath)) {
      try { fs.unlinkSync(manifestPath); } catch { /* ignore */ }
    }
  }

  return {
    triggered: candidates.length,
    analyzed,
    errors,
    candidates: candidates.map(c => ({ reelUrl: c.reelUrl, date: c.date }))
  };
}

async function computeSemanticDiff(competitorName, oldSnapshot, newData) {
  const comparedAt = new Date().toISOString();
  const sources = {};
  const errors = {};

  const sourcesToCheck = [...SEMANTIC_SOURCES];
  if (oldSnapshot?.videoAnalyses || newData?.videoAnalyses) sourcesToCheck.push('videos');

  const presentSources = sourcesToCheck.filter(src => {
    const o = pickSourceData(oldSnapshot, src);
    const n = pickSourceData(newData, src);
    return o != null || n != null;
  });

  await Promise.all(presentSources.map(async (src) => {
    try {
      const oldData = pickSourceData(oldSnapshot, src);
      const newSrcData = pickSourceData(newData, src);
      sources[src] = await analyzeSource(src, oldData, newSrcData);
    } catch (err) {
      errors[src] = err.message;
      sources[src] = {
        hasChanges: false,
        summary: 'не удалось проанализировать',
        signals: [],
        error: err.message
      };
    }
  }));

  const allSignals = [];
  let hasChanges = false;
  for (const [src, data] of Object.entries(sources)) {
    if (data.hasChanges) hasChanges = true;
    for (const sig of data.signals || []) {
      allSignals.push({ source: src, ...sig });
    }
  }

  allSignals.sort((a, b) => (IMPORTANCE_RANK[b.importance] || 0) - (IMPORTANCE_RANK[a.importance] || 0));
  const topSignals = allSignals.slice(0, 10);

  let executiveSummary;
  if (hasChanges) {
    executiveSummary = await buildExecutiveSummary(competitorName, sources, topSignals);
  } else {
    executiveSummary = `${competitorName} — без существенных изменений.`;
  }

  const out = {
    hasChanges,
    comparedAt,
    sources,
    topSignals,
    executiveSummary
  };

  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

// --- Commands ---

function competitorAdd(name, args) {
  const registry = loadRegistry();
  const slug = slugify(name);

  if (findCompetitor(registry, name)) {
    return { error: `Competitor "${name}" already exists` };
  }

  if (!args.website || String(args.website).trim() === '') {
    return { error: 'Website URL is required. Use --website "<domain-or-url>". The site is the authoritative source for discovering other social channels.' };
  }

  const sources = {};
  sources.website = String(args.website).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (args.instagram) sources.instagram = args.instagram.replace(/^@/, '');
  if (args.telegram) sources.telegram = args.telegram.replace(/^(https?:\/\/)?(t\.me\/)?/, '');
  if (args.linkedin) sources.linkedin = args.linkedin;
  if (args.facebook) sources.facebook = args.facebook;

  const competitor = {
    name,
    slug,
    sources,
    discoveredSources: [],
    createdAt: new Date().toISOString(),
    lastAnalyzedAt: null,
    firstAnalysisComplete: false,
    discoveryComplete: false
  };

  registry.competitors.push(competitor);
  saveRegistry(registry);

  return { success: true, competitor };
}

function competitorList() {
  const registry = loadRegistry();
  return {
    competitors: registry.competitors.map(c => ({
      name: c.name,
      slug: c.slug,
      sources: c.sources,
      discoveredSources: c.discoveredSources || [],
      lastAnalyzedAt: c.lastAnalyzedAt,
      firstAnalysisComplete: c.firstAnalysisComplete,
      discoveryComplete: c.discoveryComplete || false
    }))
  };
}

function competitorSnapshot(name) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  const snapshot = loadSnapshot(comp.slug);
  return {
    competitor: comp,
    snapshot,
    hasSnapshot: snapshot !== null,
    firstAnalysisComplete: comp.firstAnalysisComplete,
    discoveryComplete: comp.discoveryComplete || false
  };
}

function competitorSave(name, args) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  const newData = loadDataFromFileOrArg(args);

  // Compute website hashes
  if (newData.website) {
    newData.website._hashes = computeWebsiteHashes(newData.website);
  }

  // Set last post/video dates from data
  if (newData.instagram?.posts?.length) {
    const dates = newData.instagram.posts.map(p => new Date(p.date)).filter(d => !isNaN(d));
    if (dates.length) newData.instagram.lastPostDate = new Date(Math.max(...dates)).toISOString();
    const videoDates = newData.instagram.posts.filter(p => p.type === 'video').map(p => new Date(p.date)).filter(d => !isNaN(d));
    if (videoDates.length) newData.instagram.lastVideoDate = new Date(Math.max(...videoDates)).toISOString();
  }
  if (newData.telegram?.posts?.length) {
    const dates = newData.telegram.posts.map(p => new Date(p.date)).filter(d => !isNaN(d));
    if (dates.length) newData.telegram.lastPostDate = new Date(Math.max(...dates)).toISOString();
  }

  // Increment version
  const oldSnapshot = loadSnapshot(comp.slug);
  const version = (oldSnapshot?._meta?.version || 0) + 1;
  newData._meta = { savedAt: new Date().toISOString(), version };

  saveSnapshotFile(comp.slug, newData);

  // Update registry
  comp.lastAnalyzedAt = new Date().toISOString();
  comp.firstAnalysisComplete = true;
  saveRegistry(registry);

  return { success: true, savedAt: newData._meta.savedAt, version };
}

async function competitorDiff(name, args) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  const oldSnapshot = loadSnapshot(comp.slug);
  if (!oldSnapshot) return { error: `No snapshot found for "${name}". Run full analysis first.` };

  const newData = loadDataFromFileOrArg(args);

  // Compute hashes for new website data (kept for snapshot save downstream + structural fallback)
  if (newData.website) {
    newData.website._hashes = computeWebsiteHashes(newData.website);
  }

  // Cheap mechanical diff is always computed — used as fallback signal and for byte-level metrics
  const structural = computeDiff(oldSnapshot, newData);

  // Auto-detect & analyze any new IG reels in the data file that don't yet
  // have a Gemini analysis. Skipped via --no-video-analyze.
  let videoAutoAnalysis = null;
  if (!args['no-video-analyze']) {
    try {
      videoAutoAnalysis = await ensureVideosAnalyzed(comp, oldSnapshot, newData);
    } catch (err) {
      videoAutoAnalysis = { triggered: 0, analyzed: 0, errors: [err.message] };
    }
  }

  let semantic = null;
  let llmError = null;
  if (!args['no-llm']) {
    try {
      semantic = await computeSemanticDiff(comp.name, oldSnapshot, newData);
    } catch (err) {
      llmError = err.message;
    }
  }

  const out = {
    competitor: comp.name,
    previousAnalysis: oldSnapshot._meta?.savedAt,
    daysSinceLastAnalysis: oldSnapshot._meta?.savedAt
      ? Math.round((Date.now() - new Date(oldSnapshot._meta.savedAt).getTime()) / 86400000)
      : null,
    structural,
    videoAutoAnalysis,
    semantic
  };

  if (llmError) {
    out.warning = 'llm_unavailable';
    out.llmError = llmError;
  }

  return out;
}

function competitorAddSource(name, args) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  const platforms = ['website', 'instagram', 'telegram', 'linkedin', 'facebook'];
  let added = [];
  for (const p of platforms) {
    if (args[p]) {
      comp.sources[p] = args[p].replace(/^@/, '').replace(/^(https?:\/\/)?(t\.me\/)?/, '');
      if (!comp.discoveredSources) comp.discoveredSources = [];
      if (!comp.discoveredSources.includes(p)) comp.discoveredSources.push(p);
      added.push(p);
    }
  }

  if (added.length === 0) return { error: 'No platform specified. Use --youtube, --linkedin, etc.' };

  saveRegistry(registry);
  return { success: true, added, sources: comp.sources };
}

function competitorMarkDiscovered(name) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  comp.discoveryComplete = true;
  saveRegistry(registry);
  return { success: true, discoveryComplete: true };
}

function competitorRemove(name) {
  const registry = loadRegistry();
  const idx = registry.competitors.findIndex(c => c.slug === slugify(name) || c.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return { error: `Competitor "${name}" not found` };

  const comp = registry.competitors[idx];
  registry.competitors.splice(idx, 1);
  saveRegistry(registry);

  // Remove snapshot file
  const sp = snapshotPath(comp.slug);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);

  return { success: true, removed: comp.name };
}

function competitorAnalyzeInstagramVideos(name, args) {
  const registry = loadRegistry();
  const comp = findCompetitor(registry, name);
  if (!comp) return { error: `Competitor "${name}" not found` };

  const uploadRoot = uploadsDir();
  const keepTemp = Boolean(args['keep-temp']);
  const waitMs = Number(args['wait-ms'] || 5000);
  const records = loadVideoRecords(args);
  const snapshot = ensureSnapshotShape(loadSnapshot(comp.slug));
  const analysisSummaries = [];
  let lastSavedAt = null;

  for (const record of records) {
    const stamp = `${Date.now()}_${record.sequence}_${safeFileToken(record.date || record.reelUrl || record.caption || 'video')}`;
    let localVideoPath = record.file || path.join(uploadRoot, `competitor_video_${stamp}.mp4`);
    const analysisOutputPath = path.join(uploadRoot, `competitor_video_analysis_${stamp}.json`);
    const shouldDeleteLocalVideo = !record.file || !keepTemp;

    try {
      if (!record.file) {
        if (record.videoUrl) {
          downloadVideoToFile(record.videoUrl, localVideoPath);
        } else if (record.reelUrl || record.browserTargetId) {
          const exportResult = exportVideoFromBrowser({
            reelUrl: record.reelUrl,
            targetId: record.browserTargetId || args['browser-target-id'],
            outputFile: localVideoPath,
            timeoutMs: args['export-timeout-ms'] || args['timeout-ms'],
            cdpUrl: args['cdp-url'],
            keepPage: args['keep-export-page']
          });

          if (exportResult.status !== 'ok') {
            throw new Error(`Video ${record.sequence} export did not complete successfully`);
          }
          if (exportResult.outputFile) {
            localVideoPath = exportResult.outputFile;
          }
        } else {
          throw new Error(`Video ${record.sequence} is missing --video-url, --reel-url, or --browser-target-id`);
        }
      } else if (!fs.existsSync(localVideoPath)) {
        throw new Error(`Video file does not exist: ${localVideoPath}`);
      }

      const stat = fs.statSync(localVideoPath);
      if (stat.size > 100 * 1024 * 1024) {
        throw new Error(`Video file exceeds 100 MB: ${localVideoPath}`);
      }

      const workerResult = runGeminiVideoWorker({
        file: localVideoPath,
        source: record.source,
        date: record.date,
        caption: record.caption,
        likes: parseIntegerLike(record.likes),
        comments: parseIntegerLike(record.comments),
        url: record.reelUrl,
        model: args.model || 'gemini-3.1-pro-preview',
        outputFile: analysisOutputPath
      });

      if (workerResult.status !== 'ok' || !workerResult.videoAnalysisEntry) {
        throw new Error(`Gemini worker returned no usable videoAnalysisEntry for video ${record.sequence}`);
      }

      upsertVideoAnalysis(snapshot, workerResult.videoAnalysisEntry);
      snapshot.instagram.lastVideoDate = maxIsoDate(snapshot.instagram.lastVideoDate, workerResult.videoAnalysisEntry.date);
      snapshot.instagram.lastPostDate = maxIsoDate(snapshot.instagram.lastPostDate, workerResult.videoAnalysisEntry.date);

      analysisSummaries.push({
        sequence: record.sequence,
        reelUrl: workerResult.videoAnalysisEntry.url,
        date: workerResult.videoAnalysisEntry.date,
        model: workerResult.videoAnalysisEntry.model,
        analysisMode: workerResult.videoAnalysisEntry.analysisMode,
        summaryPreview: String(workerResult.videoAnalysisEntry.summary || '').slice(0, 200)
      });
    } finally {
      if (!keepTemp && fs.existsSync(analysisOutputPath)) {
        fs.unlinkSync(analysisOutputPath);
      }
      if (shouldDeleteLocalVideo && fs.existsSync(localVideoPath)) {
        fs.unlinkSync(localVideoPath);
      }
    }

    if (waitMs > 0 && record.sequence < records.length) {
      sleepMs(waitMs);
    }
  }

  const previousSnapshot = loadSnapshot(comp.slug);
  const version = (previousSnapshot?._meta?.version || 0) + 1;
  lastSavedAt = new Date().toISOString();
  snapshot._meta = { ...(snapshot._meta || {}), savedAt: lastSavedAt, version };
  saveSnapshotFile(comp.slug, snapshot);

  comp.lastAnalyzedAt = lastSavedAt;
  comp.firstAnalysisComplete = true;
  saveRegistry(registry);

  const result = {
    success: true,
    competitor: comp.name,
    analyzedCount: analysisSummaries.length,
    savedAt: lastSavedAt,
    version,
    analyses: analysisSummaries
  };

  if (args['result-file']) {
    fs.writeFileSync(args['result-file'], JSON.stringify(result, null, 2));
  }

  return result;
}

// --- CLI ---

function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(argv[i]);
      i += 1;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const name = args._[1];

  try {
    let result;
    switch (command) {
      case 'add':
        if (!name) throw new Error('Name required: competitor add "<name>" --website "..." --instagram "..."');
        result = competitorAdd(name, args);
        break;
      case 'list':
        result = competitorList();
        break;
      case 'snapshot':
        if (!name) throw new Error('Name required: competitor snapshot "<name>"');
        result = competitorSnapshot(name);
        break;
      case 'save':
        if (!name) throw new Error('Name required: competitor save "<name>" --data-file <path>');
        result = competitorSave(name, args);
        break;
      case 'diff':
        if (!name) throw new Error('Name required: competitor diff "<name>" --data-file <path>');
        result = await competitorDiff(name, args);
        break;
      case 'add-source':
        if (!name) throw new Error('Name required: competitor add-source "<name>" --youtube "..." --linkedin "..."');
        result = competitorAddSource(name, args);
        break;
      case 'mark-discovered':
        if (!name) throw new Error('Name required: competitor mark-discovered "<name>"');
        result = competitorMarkDiscovered(name);
        break;
      case 'remove':
        if (!name) throw new Error('Name required: competitor remove "<name>"');
        result = competitorRemove(name);
        break;
      case 'analyze-instagram-video':
      case 'analyze-instagram-videos':
        if (!name) {
          throw new Error('Name required: competitor analyze-instagram-video "<name>" --reel-url "..." [--video-url "..." | --file "..."]');
        }
        result = competitorAnalyzeInstagramVideos(name, args);
        break;
      default:
        throw new Error(`Unknown command: ${command}. Available: add, list, snapshot, save, diff, add-source, mark-discovered, remove, analyze-instagram-video, analyze-instagram-videos`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  competitorAdd, competitorList, competitorSnapshot, competitorSave,
  competitorDiff, competitorAddSource, competitorMarkDiscovered, competitorRemove,
  competitorAnalyzeInstagramVideos,
  loadRegistry, loadSnapshot, computeDiff, computeSemanticDiff, hashText
};

if (require.main === module) {
  main();
}
