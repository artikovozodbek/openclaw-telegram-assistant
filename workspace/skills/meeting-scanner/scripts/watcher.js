#!/usr/bin/env node
/**
 * meeting-scanner state CLI (v2 — trigger-log model).
 *
 * Each "meeet" trigger from the CEO is one event, identified by
 *   (chatId, triggerMessageId).
 *
 * There is no activation/deactivation — every trigger is processed once
 * and recorded. Re-running on the same trigger is a no-op. Re-running
 * on a new trigger in the same chat creates a new event; the agent
 * decides from context whether it's a new meeting, an update to a
 * previous one, or a cancellation.
 *
 * State file: /home/node/.openclaw/workspace/agents/default/data/meeting-watch/meeting_watch.json
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../../../agents/default/data/meeting-watch');
const statePath = path.join(dataDir, 'meeting_watch.json');
const conversationsDir = path.join(dataDir, 'conversations');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }

function defaultState() {
  return {
    version: 2,
    trigger: { keyword: 'meeet' },
    events: [],
    updatedAt: nowIso(),
  };
}

function ensureShape(s) {
  const out = s && typeof s === 'object' ? s : {};
  out.version = 2;
  if (!out.trigger || typeof out.trigger !== 'object') out.trigger = {};
  if (!out.trigger.keyword) out.trigger.keyword = 'meeet';
  if (!Array.isArray(out.events)) out.events = [];
  return out;
}

function loadState() {
  ensureDir(dataDir);
  ensureDir(conversationsDir);
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // Migrate from v1 (activeWatches/inactiveWatches) by wiping — v1 was
    // event-driven but schema-incompatible. Safer to start clean.
    if (raw.version !== 2) return defaultState();
    return ensureShape(raw);
  } catch {
    return defaultState();
  }
}

function saveState(s) {
  ensureDir(dataDir);
  ensureDir(conversationsDir);
  s.updatedAt = nowIso();
  fs.writeFileSync(statePath, JSON.stringify(ensureShape(s), null, 2));
}

function parseArgs(argv) {
  const a = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const cur = argv[i];
    if (cur.startsWith('--')) {
      const k = cur.slice(2);
      const n = argv[i + 1];
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
  const key = eventKey(chatId, triggerMessageId);
  return state.events.find((e) => eventKey(e.chatId, e.triggerMessageId) === key) || null;
}
function requireEvent(state, chatId, triggerMessageId) {
  const e = findEvent(state, chatId, triggerMessageId);
  if (!e) throw new Error(`Event not found for chat=${chatId} trigger=${triggerMessageId}`);
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
  if (existing) {
    print({ success: true, created: false, event: existing, reason: 'already_logged' });
    return;
  }
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
    analysis: { status: 'none', updatedAt: null },
    calendar: { status: 'none', updatedAt: null },
    reminders: [],
    confirmationSentAt: {},
  };
  state.events.push(event);
  saveState(state);
  print({ success: true, created: true, event });
}

function cmdGet(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const e = requireEvent(state, chatId, triggerMessageId);
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
  // copy into canonical location
  const dest = path.join(conversationsDir, `${chatId}-${triggerMessageId}.json`);
  fs.copyFileSync(dataFile, dest);
  event.conversationFile = dest;
  event.conversation = summarizeConversation(convo);
  saveState(state);
  print({ success: true, event });
}

function cmdRecordAnalysis(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const dataFile = req(args, 'data-file');
  const event = requireEvent(state, chatId, triggerMessageId);
  event.analysis = { ...readJson(dataFile), updatedAt: nowIso() };
  event.status = event.analysis.status || event.status;
  saveState(state);
  print({ success: true, event });
}

function cmdRecordCalendar(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const event = requireEvent(state, chatId, triggerMessageId);
  event.calendar = {
    ...event.calendar,
    status: args.status || 'created',
    calendarEventId: args['calendar-event-id'] || event.calendar.calendarEventId || null,
    eventUrl: args['event-url'] || event.calendar.eventUrl || null,
    meetLink: args['meet-link'] || event.calendar.meetLink || null,
    startAt: args['start-at'] || event.calendar.startAt || null,
    endAt: args['end-at'] || event.calendar.endAt || null,
    title: args.title || event.calendar.title || null,
    locationType: args['location-type'] || event.calendar.locationType || null,
    locationText: args['location-text'] || event.calendar.locationText || null,
    updatedAt: nowIso(),
  };
  if (event.analysis?.status === 'confirmed_meeting') {
    event.analysis.status = 'scheduled';
    event.analysis.updatedAt = nowIso();
    event.status = 'scheduled';
  }
  saveState(state);
  print({ success: true, event });
}

function cmdRecordReminder(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const event = requireEvent(state, chatId, triggerMessageId);
  const jobId = req(args, 'job-id');
  const kind = req(args, 'kind');
  const reminder = { kind, jobId, at: args.at || null, createdAt: nowIso() };
  const existing = event.reminders.find((r) => r.jobId === jobId || r.kind === kind);
  if (existing) Object.assign(existing, reminder);
  else event.reminders.push(reminder);
  saveState(state);
  print({ success: true, event });
}

function cmdMarkConfirmation(args) {
  const state = loadState();
  const chatId = req(args, 'chat-id');
  const triggerMessageId = req(args, 'trigger-msg-id');
  const event = requireEvent(state, chatId, triggerMessageId);
  const kind = req(args, 'kind');
  if (!event.confirmationSentAt || typeof event.confirmationSentAt !== 'object') {
    event.confirmationSentAt = {};
  }
  event.confirmationSentAt[kind] = args.at || nowIso();
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
      'watcher.js init',
      'watcher.js is-processed   --chat-id X --trigger-msg-id N',
      'watcher.js log-trigger    --chat-id X --chat-title "…" --trigger-msg-id N --trigger-text "…" --triggered-at ISO',
      'watcher.js get            --chat-id X --trigger-msg-id N',
      'watcher.js list           [--chat-id X] [--limit N]',
      'watcher.js save-conversation  --chat-id X --trigger-msg-id N --data-file path',
      'watcher.js record-analysis    --chat-id X --trigger-msg-id N --data-file path',
      'watcher.js record-calendar    --chat-id X --trigger-msg-id N --status created|updated|cancelled --calendar-event-id ID --event-url URL --meet-link URL --start-at ISO --end-at ISO --title "…" --location-type online|offline --location-text "…"',
      'watcher.js record-reminder    --chat-id X --trigger-msg-id N --kind before_5m --job-id JOB --at ISO',
      'watcher.js mark-confirmation  --chat-id X --trigger-msg-id N --kind created|updated|cancelled --at ISO',
      'watcher.js prune              [--days 180]',
    ],
  });
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dispatch = {
    'init':                 cmdInit,
    'is-processed':         cmdIsProcessed,
    'log-trigger':          cmdLogTrigger,
    'get':                  cmdGet,
    'list':                 cmdList,
    'save-conversation':    cmdSaveConversation,
    'record-analysis':      cmdRecordAnalysis,
    'record-calendar':      cmdRecordCalendar,
    'record-reminder':      cmdRecordReminder,
    'mark-confirmation':    cmdMarkConfirmation,
    'prune':                cmdPrune,
  };
  const fn = dispatch[cmd];
  if (!fn) return cmdHelp();
  fn(args);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
