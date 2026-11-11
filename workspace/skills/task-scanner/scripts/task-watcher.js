#!/usr/bin/env node
/**
 * task-scanner state CLI — per-trigger JIRA task log.
 *
 * Each "taskk" trigger from the CEO in a DM becomes one event, keyed by
 * (chatId, triggerMessageId). The daemon calls `log-trigger` on detect,
 * then the agent calls `save-conversation`, `record-extraction`,
 * `record-jira`, and `mark-notification` as it processes.
 *
 * State file: workspace/agents/default/data/task-scanner/task_log.json
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../../../agents/default/data/task-scanner');
const statePath = path.join(dataDir, 'task_log.json');
const conversationsDir = path.join(dataDir, 'conversations');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }

function defaultState() {
  return {
    version: 1,
    trigger: { keyword: 'taskk' },
    events: [],
    updatedAt: nowIso(),
  };
}

function ensureShape(s) {
  const out = s && typeof s === 'object' ? s : {};
  if (out.version !== 1) out.version = 1;
  if (!out.trigger || typeof out.trigger !== 'object') out.trigger = {};
  if (!out.trigger.keyword) out.trigger.keyword = 'taskk';
  if (!Array.isArray(out.events)) out.events = [];
  return out;
}

function loadState() {
  ensureDir(dataDir); ensureDir(conversationsDir);
  try { return ensureShape(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
  catch { return defaultState(); }
}

function saveState(s) {
  ensureDir(dataDir); ensureDir(conversationsDir);
  s.updatedAt = nowIso();
  fs.writeFileSync(statePath, JSON.stringify(ensureShape(s), null, 2));
}

function parseArgs(argv) {
  const a = { _: [] }; let i = 0;
  while (i < argv.length) {
    const cur = argv[i];
    if (cur.startsWith('--')) {
      const k = cur.slice(2); const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) { a[k] = n; i += 2; }
      else { a[k] = true; i += 1; }
    } else { a._.push(cur); i += 1; }
  }
  return a;
}
function req(args, k) { if (!args[k]) throw new Error(`Missing --${k}`); return String(args[k]); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function print(x) { process.stdout.write(JSON.stringify(x, null, 2) + '\n'); }

function eventKey(chatId, triggerMessageId) { return `${chatId}:${triggerMessageId}`; }
function findEvent(state, chatId, triggerMessageId) {
  const k = eventKey(chatId, triggerMessageId);
  return state.events.find((e) => eventKey(e.chatId, e.triggerMessageId) === k) || null;
}
function requireEvent(state, chatId, triggerMessageId) {
  const e = findEvent(state, chatId, triggerMessageId);
  if (!e) throw new Error(`Task event not found for chat=${chatId} trigger=${triggerMessageId}`);
  return e;
}

function summarizeConversation(convo) {
  const messages = Array.isArray(convo?.messages) ? convo.messages : [];
  return {
    messageCount: messages.length,
    voiceCount: messages.filter((m) => m.kind === 'voice' || m.kind === 'audio').length,
    firstMessageId: messages.length ? messages[0].messageId : null,
    firstMessageAt: messages.length ? messages[0].timestamp : null,
    lastMessageId: messages.length ? messages[messages.length - 1].messageId : null,
    lastMessageAt: messages.length ? messages[messages.length - 1].timestamp : null,
    participants: [...new Set(messages.map((m) => m.senderName).filter(Boolean))],
  };
}

// ---- commands ----

function cmdInit() {
  saveState(loadState());
  print({ success: true, statePath });
}

function cmdIsProcessed(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const e = findEvent(state, chatId, triggerMessageId);
  print({ success: true, processed: Boolean(e), event: e || null });
}

function cmdLogTrigger(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const existing = findEvent(state, chatId, triggerMessageId);
  if (existing) { print({ success: true, created: false, event: existing, reason: 'already_logged' }); return; }
  const event = {
    chatId,
    chatTitle: args['chat-title'] || null,
    triggerMessageId,
    triggerText: args['trigger-text'] || '',
    triggeredAt: args['triggered-at'] || nowIso(),
    processedAt: nowIso(),
    status: 'pending',
    conversationFile: path.join(conversationsDir, `${chatId}-${triggerMessageId}.json`),
    conversation: null,
    extraction: { status: 'none', updatedAt: null },
    jira: { status: 'none', updatedAt: null },
    notifications: {},
  };
  state.events.push(event);
  saveState(state);
  print({ success: true, created: true, event });
}

function cmdGet(args) {
  const state = loadState();
  const e = requireEvent(state, req(args, 'chat-id'), req(args, 'trigger-msg-id'));
  print({ success: true, event: e });
}

function cmdList(args) {
  const state = loadState();
  let events = state.events;
  if (args['chat-id']) events = events.filter((e) => String(e.chatId) === String(args['chat-id']));
  if (args.limit) events = events.slice(-Number(args.limit));
  print({ success: true, events });
}

function cmdSaveConversation(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const dataFile = req(args, 'data-file');
  const event = requireEvent(state, chatId, triggerMessageId);
  const convo = readJson(dataFile);
  const dest = path.join(conversationsDir, `${chatId}-${triggerMessageId}.json`);
  fs.copyFileSync(dataFile, dest);
  event.conversationFile = dest;
  event.conversation = summarizeConversation(convo);
  saveState(state);
  print({ success: true, event });
}

function cmdRecordExtraction(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const dataFile = req(args, 'data-file');
  const event = requireEvent(state, chatId, triggerMessageId);
  event.extraction = { ...readJson(dataFile), updatedAt: nowIso() };
  event.status = event.extraction.status || event.status;
  saveState(state);
  print({ success: true, event });
}

function cmdRecordJira(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const event = requireEvent(state, chatId, triggerMessageId);
  event.jira = {
    status: args.status || 'created',
    issueKey: args['issue-key'] || event.jira.issueKey || null,
    issueUrl: args['issue-url'] || event.jira.issueUrl || null,
    assignee: args.assignee || event.jira.assignee || null,
    projectKey: args['project-key'] || event.jira.projectKey || null,
    dueDate: args['due-date'] || event.jira.dueDate || null,
    storyPoints: args.sp ? Number(args.sp) : (event.jira.storyPoints ?? null),
    updatedAt: nowIso(),
  };
  if (event.extraction && event.extraction.status === 'ready') {
    event.extraction.status = 'scheduled';
    event.extraction.updatedAt = nowIso();
  }
  event.status = event.jira.status || event.status;
  saveState(state);
  print({ success: true, event });
}

function cmdMarkNotification(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const kind = req(args, 'kind');    // assignee_mtproto | ceo_bot
  const event = requireEvent(state, chatId, triggerMessageId);
  if (!event.notifications || typeof event.notifications !== 'object') event.notifications = {};
  event.notifications[kind] = {
    at: args.at || nowIso(),
    ref: args.ref || null,
  };
  saveState(state);
  print({ success: true, event });
}

function cmdPrune(args) {
  const state = loadState();
  const days = Number(args.days || 180);
  const cutoff = Date.now() - days * 86400_000;
  const before = state.events.length;
  state.events = state.events.filter((e) => {
    const t = Date.parse(e.triggeredAt || e.processedAt || 0);
    return Number.isNaN(t) || t >= cutoff;
  });
  saveState(state);
  print({ success: true, removed: before - state.events.length, remaining: state.events.length });
}

function cmdHelp() {
  print({
    success: false,
    error: 'Unknown command',
    usage: [
      'task-watcher.js init',
      'task-watcher.js is-processed    --chat-id X --trigger-msg-id N',
      'task-watcher.js log-trigger     --chat-id X --chat-title "…" --trigger-msg-id N --trigger-text "…" --triggered-at ISO',
      'task-watcher.js get             --chat-id X --trigger-msg-id N',
      'task-watcher.js list            [--chat-id X] [--limit N]',
      'task-watcher.js save-conversation --chat-id X --trigger-msg-id N --data-file path',
      'task-watcher.js record-extraction --chat-id X --trigger-msg-id N --data-file path',
      'task-watcher.js record-jira     --chat-id X --trigger-msg-id N --status created --issue-key KEY --issue-url URL --assignee JIRA_ID --project-key KEY --due-date YYYY-MM-DD --sp N',
      'task-watcher.js mark-notification --chat-id X --trigger-msg-id N --kind assignee_mtproto|ceo_bot --at ISO --ref MSG_ID',
      'task-watcher.js prune           [--days 180]',
    ],
  });
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dispatch = {
    'init': cmdInit,
    'is-processed': cmdIsProcessed,
    'log-trigger': cmdLogTrigger,
    'get': cmdGet,
    'list': cmdList,
    'save-conversation': cmdSaveConversation,
    'record-extraction': cmdRecordExtraction,
    'record-jira': cmdRecordJira,
    'mark-notification': cmdMarkNotification,
    'prune': cmdPrune,
  };
  const fn = dispatch[cmd];
  if (!fn) return cmdHelp();
  fn(args);
}

main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
