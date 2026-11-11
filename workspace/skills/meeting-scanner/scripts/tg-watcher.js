#!/usr/bin/env node
/**
 * tg-watcher — shared MTProto daemon for multi-skill triggers.
 *
 * Listens on the CEO's Telegram user session. Dispatches keyword triggers
 * in CEO outgoing DMs to registered handlers:
 *
 *   "meeet"  → meeting-scanner  (Google Calendar event + T-5m voice reminder)
 *   "taskk"  → task-scanner     (JIRA task + assignee DM "as CEO" + bot summary)
 *   "jarvis" → direct command   (one-shot NL instruction carried out by the agent;
 *                                "Saved Messages" resolves to the CEO's own id)
 *
 * Also exposes localhost HTTP endpoints so agent subprocesses can resolve
 * existing dialogs and post messages on the CEO's behalf through the already
 * connected MTProto session:
 *
 *   POST http://127.0.0.1:${SEND_PORT}/send-as-ceo
 *     body: { chatId: "…", message: "…" }
 *   → 200 { ok: true, messageId: N }
 *
 *   POST http://127.0.0.1:${SEND_PORT}/resolve-dialog
 *     body: { query: "Давран", exact: true, refresh: false }
 *   → 200 { ok: true, matches: [...] }
 *
 *   POST http://127.0.0.1:${SEND_PORT}/list-dialogs
 *     body: { refresh: false, limit: 25 }
 *   → 200 { ok: true, count: 25, total: 100, dialogs: [...] }
 *
 *   POST http://127.0.0.1:${SEND_PORT}/dialog-messages
 *     body: { query: "Давран", limit: 10 }
 *   → 200 { ok: true, matched: {...}, messages: [...] }
 *
 *   POST http://127.0.0.1:${SEND_PORT}/send-to-dialog
 *     body: { query: "Давран", message: "…", exact: true }
 *   → 200 { ok: true, messageId: N, matched: {...} }
 *
 * Env:
 *   TG_API_ID, TG_API_HASH, TG_USER_SESSION    — from auth-mtproto.js
 *   GEMINI_API_KEY                              — voice transcription
 *   MEETING_TRIGGER     (default "meeet")
 *   TASK_TRIGGER        (default "taskk")
 *   DIRECT_TRIGGER      (default "jarvis")
 *   MEETING_BACKLOG_LIMIT / BACKLOG_LIMIT (default 20)
 *   SEND_PORT           (default 18792)
 *   OPENCLAW_AGENT_TRIGGER (default "spawn" — set "skip" to disable agent spawns)
 */

// Global polyfill: make BigInts JSON-serializable as strings.
// GramJS internally JSON.stringify's request bodies that may contain BigInt
// ids (message ids, peer ids, access hashes). Without this the send path
// throws "Do not know how to serialize a BigInt".
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () { return this.toString(); },
    configurable: true,
  });
}

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { transcribe } = require('./transcribe');
const {
  normalizeBotApiGroupId,
  normalizeForumTopicsResult,
  publicError,
  publicForumTopicError,
  selectForumGroupDialog,
} = require('./tg-watcher-forum-topics');
const {
  botApiGroupIdFromPeer,
  executeTopicCommand,
  parseTopicCommand,
  senderIdFromMessage,
  topicThreadIdFromMessage,
} = require('./tg-watcher-topic-commands');

// ---------- Global config ----------
const BACKLOG_LIMIT = Number(process.env.MEETING_BACKLOG_LIMIT || process.env.BACKLOG_LIMIT || 20);
const SEND_PORT = Number(process.env.SEND_PORT || 18792);
const TRIGGER_AGENT = (process.env.OPENCLAW_AGENT_TRIGGER || 'spawn').toLowerCase();

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const sessionString = process.env.TG_USER_SESSION;

if (!apiId || !apiHash || !sessionString) {
  console.error('FATAL: TG_API_ID, TG_API_HASH, TG_USER_SESSION must all be set in .env.');
  console.error('Run auth-mtproto.js first.');
  process.exit(1);
}

// ---------- Paths ----------
const audioCacheDir = '/tmp/openclaw/uploads/tg-watcher';
const uploadsDir = '/tmp/openclaw/uploads';
for (const d of [audioCacheDir, uploadsDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- Logging ----------
function log(...a)  { console.log(`[tg-watcher ${new Date().toISOString()}]`, ...a); }
function warn(...a) { console.warn(`[tg-watcher ${new Date().toISOString()}] WARN`, ...a); }
function err(...a)  { console.error(`[tg-watcher ${new Date().toISOString()}] ERROR`, ...a); }

// ---------- Dialog cache / matching ----------
const dialogCache = new Map();

function cleanText(value) {
  return String(value || '').trim();
}

function fold(value) {
  return cleanText(value).toLocaleLowerCase();
}

function entityDisplayName(entity, fallback = '') {
  const title = cleanText(entity?.title);
  const first = cleanText(entity?.firstName);
  const last = cleanText(entity?.lastName);
  return title || [first, last].filter(Boolean).join(' ') || cleanText(entity?.username) || fallback;
}

function dialogName(dialog) {
  return cleanText(dialog?.name) || entityDisplayName(dialog?.entity);
}

function entityId(entity) {
  const raw = entity?.id ?? entity?.userId ?? entity?.channelId ?? entity?.chatId ?? null;
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

function isUserEntity(entity) {
  const c = entity?.className || entity?.constructor?.name || '';
  return c === 'User' || Object.prototype.hasOwnProperty.call(entity || {}, 'firstName');
}

function dialogKind(entity = {}) {
  const c = entity?.className || entity?.constructor?.name || '';
  if (isUserEntity(entity)) return 'user';
  if (c === 'Chat') return 'group';
  if (c === 'Channel') {
    if (entity.megagroup || entity.gigagroup) return 'group';
    if (entity.broadcast) return 'channel';
    return 'group';
  }
  if (entity.megagroup || entity.gigagroup) return 'group';
  if (entity.broadcast) return 'channel';
  if (cleanText(entity.title)) return 'group';
  return 'unknown';
}

function serializeDialog(dialog) {
  const entity = dialog?.entity || {};
  const peerId = entityId(entity);
  const firstName = cleanText(entity.firstName) || null;
  const lastName = cleanText(entity.lastName) || null;
  const title = cleanText(entity.title) || null;
  const username = cleanText(entity.username) || null;
  const dName = dialogName(dialog);
  const eName = entityDisplayName(entity, dName);
  const kind = dialogKind(entity);
  const visibleName = dName || eName || title || [firstName, lastName].filter(Boolean).join(' ') || null;
  return {
    peerId,
    visibleName,
    dialogName: dName || null,
    entityName: eName || null,
    firstName,
    lastName,
    title,
    username,
    kind,
    type: entity.className || entity.constructor?.name || null,
    isUser: isUserEntity(entity),
    isGroup: kind === 'group',
    isChannel: kind === 'channel',
    unreadCount: dialog?.unreadCount ?? dialog?.unread_count ?? null,
    lastMessageDate: dialog?.date
      ? new Date(Number(dialog.date) * 1000).toISOString()
      : dialog?.message?.date
        ? new Date(Number(dialog.message.date) * 1000).toISOString()
        : null,
  };
}

function cacheDialog(dialog) {
  const info = serializeDialog(dialog);
  if (!info.peerId) return null;
  dialogCache.set(info.peerId, { dialog, info, cachedAt: new Date().toISOString() });
  return info;
}

function visibleSearchableFields(info) {
  const username = fold(info.username);
  const hasNonUsernameName = Boolean(info.firstName || info.lastName || info.title);
  return [
    info.visibleName,
    info.dialogName,
    info.entityName,
    info.title,
    info.firstName,
    [info.firstName, info.lastName].filter(Boolean).join(' '),
  ]
    .map(fold)
    .filter((value) => value && (hasNonUsernameName || !username || value !== username));
}

function searchableFields(info, { queryIsUsername = false } = {}) {
  const fields = visibleSearchableFields(info);
  if (queryIsUsername) fields.push(fold(info.username));
  return fields.filter(Boolean);
}

function normalizeDialogKind(kind) {
  const value = fold(kind).replace(/[\s_-]+/g, '');
  if (!value) return '';
  if (['user', 'private', 'privatechat', 'dm', 'contact', 'contacts', 'person', 'odam', 'kontakt', 'kontaktlar', 'пользователь', 'контакт'].includes(value)) return 'user';
  if (['group', 'groups', 'groupchat', 'supergroup', 'guruh', 'guruhlar', 'gruppa', 'chatgroup', 'группа', 'группу', 'группы'].includes(value)) return 'group';
  if (['channel', 'channels', 'kanal', 'kanallar', 'канал', 'каналы'].includes(value)) return 'channel';
  return '';
}

function normalizeKindList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : [];
  return [...new Set(source.map(normalizeDialogKind).filter(Boolean))];
}

function normalizeKindFilters(options = {}) {
  const targetKind = normalizeDialogKind(options.targetKind || options.kind || options.chatKind);
  const includeKinds = normalizeKindList(options.includeKinds || options.includeKind || options.kinds);
  const excludeKinds = normalizeKindList(options.excludeKinds || options.excludeKind);
  if (targetKind && !includeKinds.includes(targetKind)) includeKinds.unshift(targetKind);
  return { includeKinds, excludeKinds };
}

function dialogPassesKindFilters(info, options = {}) {
  const { includeKinds, excludeKinds } = normalizeKindFilters(options);
  const kind = normalizeDialogKind(info.kind) || 'unknown';
  if (includeKinds.length && !includeKinds.includes(kind)) return false;
  if (excludeKinds.includes(kind)) return false;
  return true;
}

const DIALOG_KIND_SORT_ORDER = {
  user: 0,
  group: 1,
  channel: 2,
  unknown: 3,
};

function compareDialogMatches(a, b) {
  const rankDelta = a.match.rank - b.match.rank;
  if (rankDelta) return rankDelta;
  const kindDelta = (DIALOG_KIND_SORT_ORDER[a.info.kind] ?? DIALOG_KIND_SORT_ORDER.unknown)
    - (DIALOG_KIND_SORT_ORDER[b.info.kind] ?? DIALOG_KIND_SORT_ORDER.unknown);
  if (kindDelta) return kindDelta;
  const leftName = a.info.visibleName || a.info.dialogName || a.info.entityName || '';
  const rightName = b.info.visibleName || b.info.dialogName || b.info.entityName || '';
  return leftName.localeCompare(rightName);
}

function rankDialogMatch(info, query, exact, options = {}) {
  const rawQuery = cleanText(query);
  const queryIsUsername = rawQuery.startsWith('@');
  const q = fold(rawQuery.replace(/^@/, ''));
  if (!q) return null;
  if (!dialogPassesKindFilters(info, options)) return null;
  const visibleFields = visibleSearchableFields(info);
  const fields = searchableFields(info, { queryIsUsername });
  const usernameHit = queryIsUsername && fold(info.username) === q;
  const exactHit = usernameHit || visibleFields.some((v) => v === q);
  if (exactHit) return { rank: 0, reason: 'exact' };
  if (exact) return null;
  const startsHit = fields.some((v) => v.startsWith(q));
  if (startsHit) return { rank: 1, reason: 'prefix' };
  const includesHit = fields.some((v) => v.includes(q));
  if (includesHit) return { rank: 2, reason: 'substring' };
  return null;
}

async function refreshDialogCache(client, limit = 1000) {
  const active = await client.getDialogs({ limit });
  let archived = [];
  try { archived = await client.getDialogs({ limit, archived: true }); } catch {}
  for (const dialog of [...active, ...archived]) cacheDialog(dialog);
  return { active: active.length, archived: archived.length, cached: dialogCache.size };
}

async function findDialogsByQuery(client, query, options = {}) {
  const exact = options.exact !== false;
  const limit = Number(options.limit || 1000);
  const shouldRefresh = options.refresh === true || dialogCache.size === 0;
  if (shouldRefresh) await refreshDialogCache(client, limit);

  let matches = [...dialogCache.values()]
    .map((entry) => {
      const match = rankDialogMatch(entry.info, query, exact, options);
      return match ? { ...entry, match } : null;
    })
    .filter(Boolean)
    .sort(compareDialogMatches);

  // If the cache missed, do one fresh sweep before giving up. This keeps the
  // common path fast while still finding older dialogs after long uptimes.
  if (matches.length === 0 && !shouldRefresh) {
    await refreshDialogCache(client, limit);
    matches = [...dialogCache.values()]
      .map((entry) => {
        const match = rankDialogMatch(entry.info, query, exact, options);
        return match ? { ...entry, match } : null;
      })
      .filter(Boolean)
      .sort(compareDialogMatches);
  }

  return matches;
}

async function listCachedDialogs(client, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 50)));
  if (options.refresh === true || dialogCache.size === 0) {
    await refreshDialogCache(client, Math.max(limit, 100));
  }
  const dialogs = [...dialogCache.values()]
    .filter((entry) => dialogPassesKindFilters(entry.info, options))
    .map((entry) => ({ ...entry.info, cachedAt: entry.cachedAt }))
    .sort((a, b) => {
      const unreadDelta = Number(b.unreadCount || 0) - Number(a.unreadCount || 0);
      if (unreadDelta) return unreadDelta;
      const dateDelta = Date.parse(b.lastMessageDate || 0) - Date.parse(a.lastMessageDate || 0);
      if (dateDelta) return dateDelta;
      const kindDelta = (DIALOG_KIND_SORT_ORDER[a.kind] ?? DIALOG_KIND_SORT_ORDER.unknown)
        - (DIALOG_KIND_SORT_ORDER[b.kind] ?? DIALOG_KIND_SORT_ORDER.unknown);
      if (kindDelta) return kindDelta;
      return (a.visibleName || a.dialogName || a.entityName || '').localeCompare(b.visibleName || b.dialogName || b.entityName || '');
    });
  return {
    total: dialogs.length,
    dialogs: dialogs.slice(0, limit),
  };
}

async function getDialogMessages(client, payload = {}) {
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 10)));
  let selected = null;
  if (payload.peerId) {
    if (payload.refresh === true || dialogCache.size === 0) await refreshDialogCache(client, 500);
    selected = dialogCache.get(String(payload.peerId)) || null;
  }

  if (!selected) {
    const query = cleanText(payload.query);
    if (!query) throw new Error('query or peerId required');
    const matches = await findDialogsByQuery(client, query, {
      exact: payload.exact !== false,
      refresh: payload.refresh === true,
      limit: payload.searchLimit || 1000,
      targetKind: payload.targetKind,
      includeKinds: payload.includeKinds,
      excludeKinds: payload.excludeKinds,
    });
    if (matches.length === 0) {
      const e = new Error(`no existing dialog matched "${query}"`);
      e.status = 404;
      e.matches = [];
      throw e;
    }
    const bestRank = matches[0]?.match?.rank;
    const bestMatches = matches.filter((m) => m.match.rank === bestRank);
    if (bestMatches.length > 1 && payload.allowAmbiguous !== true) {
      const e = new Error(`ambiguous dialog match for "${query}"`);
      e.status = 409;
      e.matches = bestMatches.map((m) => ({ ...m.info, match: m.match }));
      throw e;
    }
    selected = bestMatches[0] || matches[0];
  }

  const target = selected.dialog.inputEntity || selected.dialog.inputPeer || selected.dialog.entity || BigInt(entityId(selected.dialog.entity));
  const history = await client.getMessages(target, { limit });
  const chatTitle = selected.info.dialogName || selected.info.entityName || selected.info.title || selected.info.username || null;
  return {
    matched: { ...selected.info, match: selected.match || { rank: 0, reason: 'peerId' } },
    messages: history.slice().reverse().map((message) => normalizeBase(message, chatTitle)),
  };
}

// ---------- Per-skill handler registry ----------
const HANDLERS = [
  {
    name: 'meeting-scanner',
    keyword: (process.env.MEETING_TRIGGER || 'meeet').toLowerCase(),
    watcherCli: path.resolve(__dirname, 'watcher.js'),
    conversationsDir: path.resolve(__dirname, '../../../agents/default/data/meeting-watch/conversations'),
    skillPath: '/home/node/.openclaw/workspace/skills/meeting-scanner/SKILL.md',
    buildPrompt({ chatId, chatTitle, triggerMessageId, convFile }) {
      return [
        `Ты — JARVIS. Один цикл meeting-scanner анализа (trigger "${this.keyword}"). Работай МОЛЧА.`,
        '',
        `Trigger: chatId=${chatId}${chatTitle ? ` (${chatTitle})` : ''}, triggerMessageId=${triggerMessageId}.`,
        `Конверсация (последние ${BACKLOG_LIMIT} сообщений, голосовые транскрибированы) уже сохранена демоном.`,
        '',
        `1) read ${this.skillPath}`,
        `2) exec node ${this.watcherCli} get --chat-id ${chatId} --trigger-msg-id ${triggerMessageId}`,
        `3) read ${convFile}`,
        `4) exec node ${this.watcherCli} list --chat-id ${chatId}`,
        '5) Классифицируй: no_meeting | candidate_meeting | confirmed_meeting | updated_meeting | cancelled_meeting.',
        `   Сохрани через record-analysis --chat-id ${chatId} --trigger-msg-id ${triggerMessageId}.`,
        '6) Действуй по статусу строго как описано в SKILL.md.',
        `   Все watcher.js вызовы ОБЯЗАНЫ содержать --chat-id ${chatId} --trigger-msg-id ${triggerMessageId}.`,
        '',
        'В конце ответь только NO_REPLY.',
      ].join('\n');
    },
  },
  {
    name: 'task-scanner',
    keyword: (process.env.TASK_TRIGGER || 'taskk').toLowerCase(),
    watcherCli: path.resolve(__dirname, '../../task-scanner/scripts/task-watcher.js'),
    conversationsDir: path.resolve(__dirname, '../../../agents/default/data/task-scanner/conversations'),
    skillPath: '/home/node/.openclaw/workspace/skills/task-scanner/SKILL.md',
    buildPrompt({ chatId, chatTitle, triggerMessageId, convFile }) {
      return [
        `Ты — JARVIS. Один цикл task-scanner анализа (trigger "${this.keyword}"). Работай МОЛЧА.`,
        '',
        `Trigger: chatId=${chatId}${chatTitle ? ` (${chatTitle})` : ''}, triggerMessageId=${triggerMessageId}.`,
        `Конверсация (последние ${BACKLOG_LIMIT} сообщений, голосовые транскрибированы) уже сохранена демоном.`,
        '',
        `1) read ${this.skillPath} — STRICTLY follow it.`,
        `2) exec node ${this.watcherCli} get --chat-id ${chatId} --trigger-msg-id ${triggerMessageId}`,
        `3) read ${convFile}`,
        `4) Все task-watcher.js вызовы ОБЯЗАНЫ содержать --chat-id ${chatId} --trigger-msg-id ${triggerMessageId}.`,
        `5) Для отправки assignee используй HTTP endpoint демона (MTProto from CEO):`,
        `   POST http://127.0.0.1:${SEND_PORT}/send-as-ceo body {"chatId":"${chatId}","message":"..."}`,
        `6) Для CEO summary используй message tool (channel: telegram, to: ${process.env.CEO_TG_ID || chatId}).`,
        '',
        'В конце ответь только NO_REPLY.',
      ].join('\n');
    },
  },
];

// Ensure handler directories exist
for (const h of HANDLERS) {
  if (!fs.existsSync(h.conversationsDir)) {
    fs.mkdirSync(h.conversationsDir, { recursive: true });
  }
}

// ---------- Direct command handler ----------
// Unlike the HANDLERS above, this is not a conversation scanner: there is no
// backlog to transcribe and no watcher CLI to record state through. The CEO
// states an instruction directly and the agent carries it out once.
//
// Deliberately keyword-gated like the others. A catch-all on every outgoing DM
// would spawn an agent for each message the CEO sends to anyone.
const DIRECT_TRIGGER = (process.env.DIRECT_TRIGGER || 'jarvis').toLowerCase();

// Pure helpers live in a sibling module so they are unit-testable without
// loading this file (which connects to Telegram at require time).
const { extractInstruction, makeSeenSet } = require('./tg-watcher-direct');

// Dedup: NewMessage is live-only (no replay on restart), but Telegram can
// redeliver an update after a reconnect. Keep a bounded set of handled ids.
const directSeen = makeSeenSet(500);

// The CEO's own Telegram user id, resolved once at startup via getMe().
// In Telegram, "Saved Messages" is simply the chat with your own id, so this
// doubles as the Saved Messages target.
let selfUserId = null;

function buildDirectPrompt({ instruction, chatId, chatTitle, selfId }) {
  return [
    'You are JARVIS, the CEO\'s Telegram assistant, acting on his own account',
    'via the already-connected MTProto session. Carry out ONE instruction.',
    '',
    `Instruction from the CEO: ${JSON.stringify(instruction)}`,
    `Context: sent in chatId=${chatId}${chatTitle ? ` (${chatTitle})` : ''}.`,
    '',
    'To send a Telegram message AS THE CEO, POST to the daemon:',
    `  POST http://127.0.0.1:${SEND_PORT}/send-as-ceo`,
    '  body: {"chatId":"<numeric id>","message":"<text>"}',
    'Or use the CLI wrapper: exec tg-send send --peer-id <id> --text "<text>"',
    '',
    `The CEO's own Telegram user id is ${selfId}.`,
    `"Saved Messages" (Избранное / o'zimga) IS the chat with that id: use chatId="${selfId}".`,
    '',
    'To find another person\'s chat id: exec tg-send resolve --query "<visible name>"',
    'To list available chats:        exec tg-send list --limit 25',
    '',
    'To READ or SEARCH the CEO\'s own Telegram history (same MTProto session):',
    '  exec tg-send messages --query "<visible name>" --limit 20',
    '  exec tg-send messages --peer-id <numeric id> --limit 20',
    'If resolve returns {"error":"ambiguous dialog match"}, it includes a matches',
    'array — list the candidates and ask which one. Do not pick silently.',
    'Summarize ONLY from the returned messages array. If it is empty, say so.',
    'Never invent message text, senders, or timestamps.',
    'Telegram MCP tools are NOT configured here; tg-send is the read path.',
    '',
    'Rules:',
    '- If the CEO asked you to READ/CHECK/SUMMARIZE, do not send anything unless',
    '  he also asked you to. Reply to him in Saved Messages only if he asked.',
    '- When sending, send exactly ONE message unless the CEO asked for more.',
    '- Write the message content itself, not a description of it.',
    '- Preserve the CEO\'s language (Uzbek/Russian/English) in what you send.',
    '- Do NOT invent recipients. If the target is ambiguous, send to Saved Messages',
    `  (chatId="${selfId}") and note the ambiguity there rather than guessing.`,
    '- Do NOT perform destructive actions (deleting messages, leaving chats,',
    '  changing account settings). Those need explicit CEO confirmation.',
    '',
    'When done, reply with only NO_REPLY.',
  ].join('\n');
}

// ---------- Watcher CLI helper ----------
function runWatcher(cliPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(cliPath)} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`${path.basename(cliPath)} bad JSON: ${stdout.slice(0, 200)}`)); }
    });
  });
}

// ---------- proxy-chat mandate lookup (inbound-message routing) ----------
const proxyChatCli = path.resolve(__dirname, '../../proxy-chat/scripts/proxy-chat.js');

async function findActiveMandateForPeer(peerUserId) {
  try {
    const result = await runWatcher(proxyChatCli, ['find-by-peer', '--peer-id', String(peerUserId)]);
    if (result?.found && result.mandate) return result.mandate;
    return null;
  } catch (e) {
    warn(`proxy-chat find-by-peer failed peer=${peerUserId}: ${e.message}`);
    return null;
  }
}

function buildProxyChatPrompt(mandate, incomingMessage, chatTitle) {
  const peerLabel = mandate.peer?.name || mandate.peer?.username || mandate.peer?.userId || chatTitle || 'counterparty';
  const incomingText = JSON.stringify(incomingMessage.message || '');
  const incomingIso = new Date(incomingMessage.date * 1000).toISOString();
  return [
    'Ты — JARVIS. Сэр делегировал тебе переписку с конкретным человеком. Отвечай ему от имени сэра.',
    '',
    `Собеседник: ${peerLabel} (peer-id ${mandate.peer?.userId}).`,
    `Мандат ID: ${mandate.id}.`,
    `Статус мандата: ${mandate.status}.`,
    '',
    '1) read /home/node/.openclaw/workspace/skills/proxy-chat/SKILL.md',
    `2) exec node /home/node/.openclaw/workspace/skills/proxy-chat/scripts/proxy-chat.js get --id ${mandate.id}`,
    '',
    'Входящее сообщение:',
    `  messageId: ${incomingMessage.id}`,
    `  timestamp: ${incomingIso}`,
    `  text: ${incomingText}`,
    '',
    '3) ПЕРВЫМ делом зафиксируй входящее:',
    `   exec node /home/node/.openclaw/workspace/skills/proxy-chat/scripts/proxy-chat.js log-message --id ${mandate.id} --direction incoming --text "<exact incoming text>" --message-id ${incomingMessage.id} --timestamp ${incomingIso}`,
    '',
    '4) Проверь escalate-триггеры (case-insensitive substring match). При срабатывании:',
    `   - exec node .../proxy-chat.js flag --id ${mandate.id} --reason "..." --severity high`,
    `   - exec node .../proxy-chat.js pause --id ${mandate.id} --reason "escalate trigger"`,
    `   - Отправь сэру (telegram ${process.env.CEO_TG_ID}) через message tool короткое уведомление со структурой из SKILL.md.`,
    '   - Собеседнику НЕ отвечай.',
    '',
    '5) Если триггеров нет — составь ответ по objective + persona + constraints.',
    `   Отправь ЧЕРЕЗ HTTP (единая MTProto-сессия демона): POST http://127.0.0.1:${SEND_PORT}/send-as-ceo`,
    `   body: {"chatId":"${mandate.peer?.userId}","message":"<your reply>"}`,
    '   Ответ даст messageId — используй его в log-message.',
    '',
    `6) exec node .../proxy-chat.js log-message --id ${mandate.id} --direction outgoing --text "<your reply>" --message-id <messageId from /send-as-ceo>`,
    '',
    '7) Ответь ТОЛЬКО NO_REPLY.',
  ].join('\n');
}

// ---------- Message normalization ----------
function classifyKind(message) {
  if (!message.media) return 'text';
  const c = message.media.className;
  if (c === 'MessageMediaDocument') {
    const doc = message.media.document;
    const attrs = doc?.attributes || [];
    const audioAttr = attrs.find((a) => a.className === 'DocumentAttributeAudio');
    if (audioAttr) return audioAttr.voice ? 'voice' : 'audio';
    const videoAttr = attrs.find((a) => a.className === 'DocumentAttributeVideo');
    return videoAttr ? 'video' : 'document';
  }
  if (c === 'MessageMediaPhoto') return 'photo';
  return 'other';
}

function normalizeBase(message, chatTitle) {
  const isOutgoing = Boolean(message.out);
  return {
    messageId: String(message.id),
    timestamp: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
    senderRole: isOutgoing ? 'ceo' : 'counterparty',
    senderName: chatTitle || (isOutgoing ? 'Owner' : 'Counterparty'),
    direction: isOutgoing ? 'outgoing' : 'incoming',
    kind: classifyKind(message),
    text: (message.message || '').trim(),
    transcript: '',
    searchableText: (message.message || '').trim(),
    hasMedia: Boolean(message.media),
  };
}

async function transcribeOne(client, message, chatId) {
  try {
    const buffer = await client.downloadMedia(message);
    if (!buffer) return '';
    const filePath = path.join(audioCacheDir, `${chatId}-${message.id}.ogg`);
    fs.writeFileSync(filePath, buffer);
    log(`transcribing msg=${message.id} chat=${chatId} bytes=${buffer.length}`);
    const text = await transcribe(filePath, 'audio/ogg');
    try { fs.unlinkSync(filePath); } catch {}
    return text;
  } catch (e) {
    warn(`transcribe failed msg=${message.id}: ${e.message}`);
    return '';
  }
}

async function fetchBacklog(client, entity, chatId, chatTitle) {
  const history = await client.getMessages(entity, { limit: BACKLOG_LIMIT });
  log(`backlog chat=${chatId}: fetched=${history.length} (limit=${BACKLOG_LIMIT})`);
  const ordered = history.slice().reverse();
  const messages = [];
  for (const msg of ordered) {
    const m = normalizeBase(msg, chatTitle);
    if (m.kind === 'voice' || m.kind === 'audio') {
      m.transcript = await transcribeOne(client, msg, chatId);
      m.searchableText = [m.text, m.transcript].filter(Boolean).join('\n').trim();
    }
    messages.push(m);
  }
  return messages;
}

// ---------- Agent spawn ----------
function spawnAgent(prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [
        '/app/dist/index.js', 'agent',
        '--agent', 'main',
        '--timeout', '300',
        '--thinking', 'high',
        '--message', prompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = ''; let stderr = '';
    let earlyKill = null; let finished = false;

    const done = (reason) => {
      if (finished) return;
      finished = true;
      if (earlyKill) clearTimeout(earlyKill);
      if (hardCap) clearTimeout(hardCap);
      log(`agent done (${reason}):`, stdout.trim().split('\n').pop()?.slice(0, 140) || '(empty)');
      resolve();
    };

    const triggerKillIfFinalSeen = (chunk) => {
      if (earlyKill) return;
      if (/NO_REPLY|final_answer|mark-confirmation|mark-notification|record-reminder|record-jira/i.test(chunk)) {
        earlyKill = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000);
        }, 5_000);
      }
    };

    child.stdout.on('data', (b) => { const s = b.toString(); stdout += s; triggerKillIfFinalSeen(s); });
    child.stderr.on('data', (b) => { const s = b.toString(); stderr += s; triggerKillIfFinalSeen(s); });
    child.on('close', (code) => {
      if (!finished && code !== 0 && !earlyKill) err(`agent exited ${code}: ${stderr.slice(0, 2000)}`);
      done(code === 0 ? 'clean exit' : earlyKill ? 'final-answer seen, killed' : `exit ${code}`);
    });

    const hardCap = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done('hard timeout 420s');
    }, 420_000);
  });
}

function truncateTelegramText(text) {
  const value = cleanText(text);
  return value.length > 3900 ? `${value.slice(0, 3890)}\n...` : value;
}

async function sendTopicCommandReplyWithBot(groupId, message, text) {
  const token = cleanText(process.env.TELEGRAM_BOT_TOKEN);
  if (!token || !groupId) return false;

  const body = {
    chat_id: groupId,
    text: truncateTelegramText(text),
    reply_parameters: {
      message_id: Number(message.id),
      allow_sending_without_reply: true,
    },
  };
  const threadId = topicThreadIdFromMessage(message);
  if (threadId) body.message_thread_id = Number(threadId);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return true;
    const data = await response.json().catch(() => ({}));
    warn(`[topic-command] Bot API reply failed group=${groupId}: ${cleanText(data.description) || `HTTP ${response.status}`}`);
  } catch (e) {
    warn(`[topic-command] Bot API reply failed group=${groupId}: ${e.message}`);
  }
  return false;
}

async function sendTopicCommandReplyWithMtproto(client, peer, message, text) {
  let target = peer;
  try {
    target = await client.getEntity(peer);
  } catch {}

  const payload = truncateTelegramText(text);
  try {
    await client.sendMessage(target, { message: payload, replyTo: Number(message.id) });
  } catch (e) {
    warn(`[topic-command] threaded MTProto reply failed: ${e.message}`);
    await client.sendMessage(target, { message: payload });
  }
}

async function sendTopicCommandReply(client, peer, groupId, message, text) {
  if (await sendTopicCommandReplyWithBot(groupId, message, text)) return;
  await sendTopicCommandReplyWithMtproto(client, peer, message, text);
}

async function maybeHandleTopicCommand(client, message, peer) {
  const command = parseTopicCommand(message.message || '');
  if (!command) return false;

  const groupId = botApiGroupIdFromPeer(peer);
  if (!groupId) return false;

  const senderId = senderIdFromMessage(message);
  const result = await executeTopicCommand({
    command,
    text: message.message || '',
    groupId,
    senderId,
  });
  if (!result) return false;

  log(`[topic-command] command=${command} group=${groupId} sender=${senderId} ok=${result.ok !== false}`);
  await sendTopicCommandReply(client, peer, groupId, message, result.text);
  return true;
}

// ---------- Trigger handler ----------
async function processTrigger(handler, client, message, chatId, chatTitle) {
  const triggerMessageId = String(message.id);
  const convPath = path.join(handler.conversationsDir, `${chatId}-${triggerMessageId}.json`);

  // 1. Dedup
  try {
    const dedup = await runWatcher(handler.watcherCli, ['is-processed', '--chat-id', chatId, '--trigger-msg-id', triggerMessageId]);
    if (dedup.processed) {
      log(`[${handler.name}] trigger already processed: chat=${chatId} msg=${triggerMessageId}, skipping`);
      return;
    }
  } catch (e) {
    warn(`[${handler.name}] is-processed failed: ${e.message}`);
    return;
  }

  log(`★ [${handler.name}] trigger detected: chat=${chatId} title="${chatTitle || ''}" msg=${triggerMessageId} text="${(message.message || '').slice(0, 80)}"`);

  // 2. Log trigger
  try {
    await runWatcher(handler.watcherCli, [
      'log-trigger',
      '--chat-id', chatId,
      '--chat-title', chatTitle || `Chat ${chatId}`,
      '--trigger-msg-id', triggerMessageId,
      '--trigger-text', (message.message || '').slice(0, 200),
      '--triggered-at', new Date(message.date * 1000).toISOString(),
    ]);
  } catch (e) {
    warn(`[${handler.name}] log-trigger failed: ${e.message}`);
    return;
  }

  // 3. Fetch & transcribe backlog
  let convo;
  try {
    // Robust entity resolution with fallbacks — getEntity can fail for peers
    // not yet in gramjs entity cache (e.g. first DM with a new user, rare
    // dialogs beyond the initial warmup).
    let entity;
    try {
      entity = await client.getEntity(message.peerId);
    } catch (e1) {
      try {
        // Fallback 1: the message's own getChat() uses event-cached entity
        entity = await message.getChat();
        if (!entity) throw new Error('getChat returned null');
      } catch (e2) {
        // Fallback 2: re-warm entity cache with wider dialog sweep, then retry
        log(`[${handler.name}] entity miss for ${chatId}, re-warming dialogs...`);
        try { await client.getDialogs({ limit: 500 }); } catch {}
        try { await client.getDialogs({ limit: 500, archived: true }); } catch {}
        entity = await client.getEntity(message.peerId);
      }
    }
    const messages = await fetchBacklog(client, entity, chatId, chatTitle);
    convo = {
      version: 1,
      chat: { chatId: String(chatId), title: chatTitle || null },
      trigger: { messageId: triggerMessageId, text: message.message || '', at: new Date(message.date * 1000).toISOString() },
      messages,
      summary: {
        messageCount: messages.length,
        voiceCount: messages.filter((m) => m.kind === 'voice' || m.kind === 'audio').length,
        participants: [...new Set(messages.map((m) => m.senderName).filter(Boolean))],
      },
    };
  } catch (e) {
    err(`[${handler.name}] backlog fetch failed chat=${chatId}: ${e.message}`);
    return;
  }

  // 4. Save conversation
  const tmpFile = path.join(uploadsDir, `convo_${handler.name}_${chatId}_${triggerMessageId}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(convo, null, 2));
  try {
    await runWatcher(handler.watcherCli, [
      'save-conversation',
      '--chat-id', chatId,
      '--trigger-msg-id', triggerMessageId,
      '--data-file', tmpFile,
    ]);
  } catch (e) {
    warn(`[${handler.name}] save-conversation failed: ${e.message}`);
  }
  try { fs.unlinkSync(tmpFile); } catch {}

  // 5. Spawn agent
  if (TRIGGER_AGENT === 'skip') {
    log(`[${handler.name}] agent trigger disabled for chat=${chatId} msg=${triggerMessageId}`);
    return;
  }
  log(`→ [${handler.name}] spawning agent for chat=${chatId} msg=${triggerMessageId}`);
  try {
    await spawnAgent(handler.buildPrompt({ chatId, chatTitle, triggerMessageId, convFile: convPath }));
  } catch (e) {
    err(`[${handler.name}] agent invocation failed for chat=${chatId} msg=${triggerMessageId}: ${e.message}`);
  }
}

// ---------- Incoming update handler ----------
async function handleNewMessage(client, event) {
  const message = event.message;
  if (!message) return;
  const peer = message.peerId;
  if (!peer) return;

  if (peer.className !== 'PeerUser') {
    await maybeHandleTopicCommand(client, message, peer);
    return;
  }

  const chatId = String(peer.userId);
  let chatTitle = null;
  try {
    const entity = await client.getEntity(peer);
    chatTitle = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() || entity.username || null;
  } catch {}

  // --- Path A: counterparty inbound → proxy-chat mandate routing ---
  if (!message.out) {
    const mandate = await findActiveMandateForPeer(chatId);
    if (!mandate) return;  // no mandate → nothing to do on inbound DMs

    log(`◆ proxy-chat inbound: peer=${chatId} mandate=${mandate.id} msg=${message.id}`);
    if (TRIGGER_AGENT === 'skip') {
      log(`agent trigger disabled — skipping proxy-chat spawn`);
      return;
    }
    try {
      await spawnAgent(buildProxyChatPrompt(mandate, message, chatTitle));
    } catch (e) {
      err(`proxy-chat agent failed mandate=${mandate.id}: ${e.message}`);
    }
    return;
  }

  // --- Path B: CEO outgoing → keyword-triggered handlers (meeting / task / …) ---
  const text = (message.message || '').toLowerCase();

  // Path B1: direct command. Checked before the scanner handlers because it is
  // an explicit instruction, not a conversation to analyse.
  if (text.includes(DIRECT_TRIGGER)) {
    const dedupKey = `${chatId}:${message.id}`;
    if (directSeen.has(dedupKey)) {
      log(`[${DIRECT_TRIGGER}] duplicate update chat=${chatId} msg=${message.id}, skipping`);
      return;
    }
    directSeen.remember(dedupKey);

    // Strip the trigger word from the raw (case-preserving) text so the agent
    // receives the instruction as written, not lowercased.
    const instruction = extractInstruction(message.message || '', DIRECT_TRIGGER);

    if (!instruction) {
      log(`[${DIRECT_TRIGGER}] trigger with no instruction chat=${chatId} msg=${message.id}, ignoring`);
      return;
    }
    if (!selfUserId) {
      err(`[${DIRECT_TRIGGER}] self user id not resolved yet; ignoring chat=${chatId} msg=${message.id}`);
      return;
    }
    if (TRIGGER_AGENT === 'skip') {
      log(`[${DIRECT_TRIGGER}] agent trigger disabled — skipping spawn`);
      return;
    }

    log(`★ [${DIRECT_TRIGGER}] direct command: chat=${chatId} msg=${message.id} text="${instruction.slice(0, 80)}"`);
    try {
      await spawnAgent(buildDirectPrompt({ instruction, chatId, chatTitle, selfId: selfUserId }));
    } catch (e) {
      err(`[${DIRECT_TRIGGER}] agent failed chat=${chatId} msg=${message.id}: ${e.message}`);
    }
    return;
  }

  const handler = HANDLERS.find((h) => text.includes(h.keyword));
  if (!handler) {
    // Debug: log CEO outgoing DMs that didn't match any trigger
    if (text) log(`[debug] CEO outgoing in chat=${chatId} title="${chatTitle || ''}" text="${text.slice(0,80)}" — no trigger match`);
    return;
  }

  await processTrigger(handler, client, message, chatId, chatTitle);
}

// ---------- HTTP: MTProto utility endpoints ----------
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
      if (body.length > 256_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function sendMessageToChatId(client, chatId, message) {
  const result = await client.sendMessage(BigInt(chatId), { message });
  const rawId = result?.id ?? result?.messageId ?? null;
  return rawId === null || rawId === undefined ? null : String(rawId);
}

async function sendMessageToDialog(client, dialog, message) {
  const target = dialog.inputEntity || dialog.inputPeer || dialog.entity || BigInt(entityId(dialog.entity));
  const result = await client.sendMessage(target, { message });
  const rawId = result?.id ?? result?.messageId ?? null;
  return rawId === null || rawId === undefined ? null : String(rawId);
}

async function getForumTopics(client, payload = {}) {
  const { groupId, peerId } = normalizeBotApiGroupId(payload.groupId);
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 100)));

  if (payload.refresh === true || dialogCache.size === 0) {
    await refreshDialogCache(client, Math.max(500, limit));
  }

  let selected = selectForumGroupDialog(dialogCache.values(), peerId);
  if (!selected && payload.refresh !== true) {
    await refreshDialogCache(client, Math.max(1000, limit));
    selected = selectForumGroupDialog(dialogCache.values(), peerId);
  }

  if (!selected) throw publicError(404, 'group is not visible to the MTProto user');

  const channel = selected.dialog.inputEntity || selected.dialog.entity;
  const title = selected.info.title || selected.info.visibleName || entityDisplayName(selected.dialog.entity, groupId);

  let result;
  try {
    result = await client.invoke(new Api.channels.GetForumTopics({
      channel,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit,
    }));
  } catch (e) {
    throw publicForumTopicError(e);
  }

  return normalizeForumTopicsResult(result, { groupId, peerId, title });
}

// ---------- Remove dialogs (owner-approved cleanup) ----------
// Safety: dry-run by default; real removal needs confirm:true; max 30 per call;
// private chats with real people need includePeople:true; never touches Saved
// Messages or the assistant's own bot. Every removal is appended to an audit log.
const REMOVE_MAX = 30;
const REMOVE_PROTECTED_USERNAMES = new Set(
  String(process.env.TG_REMOVE_PROTECTED || 'your_assistant_bot')
    .split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
);
const REMOVE_AUDIT_LOG = path.resolve(__dirname, '../../../telegram-removed-log.jsonl');

function removalPlan(entry) {
  const entity = entry.dialog.entity || {};
  const info = entry.info;
  if (selfUserId && info.peerId === selfUserId) return { action: null, blocked: 'Saved Messages — never removed' };
  if (info.username && REMOVE_PROTECTED_USERNAMES.has(info.username.toLowerCase())) {
    return { action: null, blocked: 'protected (assistant bot)' };
  }
  const c = entity.className || entity.constructor?.name || '';
  if (c === 'Channel') return { action: info.kind === 'channel' ? 'leave-channel' : 'leave-group' };
  if (c === 'Chat') return { action: 'leave-group' };
  if (isUserEntity(entity)) {
    if (entity.bot) return { action: 'block-bot-and-delete-chat' };
    return { action: 'delete-private-chat', person: true };
  }
  return { action: null, blocked: `unsupported type ${c || 'unknown'}` };
}

async function executeRemoval(client, entry, action) {
  const entity = entry.dialog.entity;
  const peer = entry.dialog.inputEntity || entity;
  if (action === 'leave-channel' || (action === 'leave-group' && (entity.className === 'Channel'))) {
    await client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
    return;
  }
  if (action === 'leave-group') {
    await client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf() }));
    try { await client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, justClear: false, revoke: false })); } catch {}
    return;
  }
  if (action === 'block-bot-and-delete-chat') {
    await client.invoke(new Api.contacts.Block({ id: peer }));
    await client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, justClear: false, revoke: false }));
    return;
  }
  if (action === 'delete-private-chat') {
    // revoke:false = removed only on the owner's side, the other person keeps it.
    await client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, justClear: false, revoke: false }));
    return;
  }
  throw new Error(`unknown action ${action}`);
}

async function removeDialogs(client, payload = {}) {
  const peerIds = [...new Set((Array.isArray(payload.peerIds) ? payload.peerIds : []).map((p) => String(p).trim()).filter(Boolean))];
  if (peerIds.length === 0) throw publicError(400, 'peerIds required (use tg-send list to get peer ids)');
  if (peerIds.length > REMOVE_MAX) throw publicError(400, `too many: ${peerIds.length} (max ${REMOVE_MAX} per call)`);
  const confirm = payload.confirm === true;
  const includePeople = payload.includePeople === true;

  if (!selfUserId) { try { const me = await client.getMe(); selfUserId = entityId(me); } catch {} }
  const missing = peerIds.filter((id) => !dialogCache.has(id));
  if (missing.length) await refreshDialogCache(client, 1000);

  const items = peerIds.map((peerId) => {
    const entry = dialogCache.get(peerId);
    if (!entry) return { peerId, status: 'not-found' };
    const plan = removalPlan(entry);
    const base = { peerId, name: entry.info.visibleName, username: entry.info.username, kind: entry.info.kind };
    if (!plan.action) return { ...base, status: 'skipped', reason: plan.blocked };
    if (plan.person && !includePeople) return { ...base, action: plan.action, status: 'skipped', reason: 'private chat with a person — needs includePeople' };
    return { ...base, action: plan.action, status: confirm ? 'pending' : 'would-remove', _entry: entry };
  });

  if (confirm) {
    for (const item of items) {
      if (item.status !== 'pending') continue;
      try {
        await executeRemoval(client, item._entry, item.action);
        item.status = 'removed';
        dialogCache.delete(item.peerId);
        try { fs.appendFileSync(REMOVE_AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), peerId: item.peerId, name: item.name, username: item.username, kind: item.kind, action: item.action }) + '\n'); } catch {}
        log(`[remove-dialogs] ${item.action} peer=${item.peerId} name="${String(item.name || '').slice(0, 60)}"`);
      } catch (e) {
        item.status = 'failed';
        item.error = e.errorMessage || e.message;
        warn(`[remove-dialogs] failed peer=${item.peerId}: ${item.error}`);
      }
      await new Promise((r) => setTimeout(r, 1200)); // stay well under Telegram flood limits
    }
  }

  const result = items.map(({ _entry, ...rest }) => rest);
  const count = (s) => result.filter((r) => r.status === s).length;
  return {
    ok: true,
    dryRun: !confirm,
    summary: confirm
      ? { removed: count('removed'), failed: count('failed'), skipped: count('skipped'), notFound: count('not-found') }
      : { wouldRemove: count('would-remove'), skipped: count('skipped'), notFound: count('not-found') },
    items: result,
  };
}

function startSendServer(client) {
  const server = http.createServer(async (req, res) => {
    const route = String(req.url || '').split('?')[0];
    if (req.method !== 'POST' || !['/send-as-ceo', '/resolve-dialog', '/send-to-dialog', '/list-dialogs', '/dialog-messages', '/forum-topics', '/remove-dialogs'].includes(route)) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    try {
      const payload = await readJsonBody(req);

      if (route === '/send-as-ceo') {
        const { chatId, message } = payload;
        if (!chatId || !message) throw new Error('chatId and message required');
        const messageId = await sendMessageToChatId(client, chatId, String(message));
        log(`[send-as-ceo] chat=${chatId} msg=${messageId} (${String(message).length} chars)`);
        sendJson(res, 200, { ok: true, messageId });
        return;
      }

      if (route === '/resolve-dialog') {
        const { query } = payload;
        if (!query) throw new Error('query required');
        const matches = await findDialogsByQuery(client, query, {
          exact: payload.exact !== false,
          refresh: payload.refresh === true,
          limit: payload.limit,
          targetKind: payload.targetKind,
          includeKinds: payload.includeKinds,
          excludeKinds: payload.excludeKinds,
        });
        sendJson(res, 200, {
          ok: true,
          query: String(query),
          count: matches.length,
          matches: matches.map((m) => ({ ...m.info, match: m.match })),
        });
        return;
      }

      if (route === '/list-dialogs') {
        const result = await listCachedDialogs(client, payload);
        sendJson(res, 200, {
          ok: true,
          count: result.dialogs.length,
          total: result.total,
          dialogs: result.dialogs,
        });
        return;
      }

      if (route === '/send-to-dialog') {
        const { query, message } = payload;
        if (!query || !message) throw new Error('query and message required');
        const matches = await findDialogsByQuery(client, query, {
          exact: payload.exact !== false,
          refresh: payload.refresh === true,
          limit: payload.limit,
          targetKind: payload.targetKind,
          includeKinds: payload.includeKinds,
          excludeKinds: payload.excludeKinds,
        });
        if (matches.length === 0) {
          sendJson(res, 404, { ok: false, error: `no existing dialog matched "${query}"`, matches: [] });
          return;
        }

        const exactMatches = matches.filter((m) => m.match.rank === 0);
        if (exactMatches.length > 1 && payload.allowAmbiguous !== true) {
          sendJson(res, 409, {
            ok: false,
            error: `ambiguous dialog match for "${query}"`,
            matches: exactMatches.map((m) => ({ ...m.info, match: m.match })),
          });
          return;
        }

        const selected = exactMatches[0] || matches[0];
        const messageId = await sendMessageToDialog(client, selected.dialog, String(message));
        log(`[send-to-dialog] query="${String(query).slice(0, 80)}" chat=${selected.info.peerId} msg=${messageId} (${String(message).length} chars)`);
        sendJson(res, 200, {
          ok: true,
          messageId,
          matched: { ...selected.info, match: selected.match },
        });
        return;
      }

      if (route === '/dialog-messages') {
        try {
          const result = await getDialogMessages(client, payload);
          sendJson(res, 200, {
            ok: true,
            dialog: result.matched,
            matched: result.matched,
            count: result.messages.length,
            messages: result.messages,
          });
        } catch (e) {
          sendJson(res, e.status || 500, { ok: false, error: e.message, matches: e.matches || [] });
        }
        return;
      }

      if (route === '/forum-topics') {
        try {
          const result = await getForumTopics(client, payload);
          log(`[forum-topics] group=${result.groupId} topics=${result.count}/${result.total}`);
          sendJson(res, 200, result);
        } catch (e) {
          const status = e.status || 500;
          warn(`[forum-topics] failed group=${payload?.groupId || ''}: ${e.message}`);
          sendJson(res, status, { ok: false, error: e.message });
        }
        return;
      }

      if (route === '/remove-dialogs') {
        try {
          const result = await removeDialogs(client, payload);
          sendJson(res, 200, result);
        } catch (e) {
          sendJson(res, e.status || 500, { ok: false, error: e.message });
        }
        return;
      }
    } catch (e) {
      warn(`[${route}] failed: ${e.message}`);
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });
  server.listen(SEND_PORT, '127.0.0.1', () => {
    log(`MTProto HTTP endpoints listening on http://127.0.0.1:${SEND_PORT} (/send-as-ceo, /resolve-dialog, /send-to-dialog, /list-dialogs, /dialog-messages, /forum-topics, /remove-dialogs)`);
  });
  return server;
}

// ---------- Bootstrap ----------
async function main() {
  const triggers = HANDLERS.map((h) => `${h.name}="${h.keyword}"`).join(', ');
  log(`startup: triggers[${triggers}], backlog=${BACKLOG_LIMIT} msgs, agent=${TRIGGER_AGENT}, sendPort=${SEND_PORT}`);

  for (const h of HANDLERS) {
    try { await runWatcher(h.watcherCli, ['init']); }
    catch (e) { warn(`[${h.name}] init failed (normal if skill not installed yet): ${e.message}`); }
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: Infinity,
    autoReconnect: true,
    deviceModel: 'OpenClaw Meeting Watcher',
    systemVersion: 'Linux',
    appVersion: '2.0',
  });

  await client.connect();
  const me = await client.getMe();
  selfUserId = String(me.id);
  log(`connected as ${me.firstName || ''} (id=${me.id})`);

  // Warm up the entity cache by fetching recent dialogs. Without this,
  // /send-as-ceo fails on cold boot until a message is received from the
  // target peer (which caches its accessHash).
  try {
    const warmed = await refreshDialogCache(client, 500);
    log(`warmed ${warmed.active} active + ${warmed.archived} archived dialogs into entity cache (${warmed.cached} cached)`);
  } catch (e) {
    warn(`dialogs warmup failed (non-fatal): ${e.message}`);
  }

  client.addEventHandler(
    (event) => handleNewMessage(client, event).catch((e) => err('handler:', e.message)),
    new NewMessage({})
  );

  startSendServer(client);

  log('listening for updates…');

  const shutdown = async (sig) => {
    log(`${sig}, disconnecting`);
    try { await client.disconnect(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((e) => { err('fatal:', e.message, e.stack); process.exit(1); });
