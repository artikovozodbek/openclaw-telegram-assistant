#!/usr/bin/env node
/**
 * proxy-chat — mandate store + CLI.
 *
 * CEO delegates a conversation with a specific Telegram peer to the agent,
 * giving objective, persona, constraints, and escalation triggers. The
 * agent owns replies until the CEO closes the mandate.
 *
 * Data: workspace/agents/default/data/proxy-chat/mandates.json
 *
 * Commands (all return JSON on stdout):
 *   proxy-chat start       --peer-id <id> [--username <u>] [--name <n>]
 *                          --objective "..." [--persona "..."]
 *                          [--context "..."] [--constraint "..."]*
 *                          [--escalate-on "..."]* [--opening "..."]
 *   proxy-chat list        [--status active|paused|closed|all]
 *   proxy-chat get         --id <mandateId>
 *   proxy-chat find-by-peer --peer-id <id>   # returns active mandate if any
 *   proxy-chat close       --id <mandateId> [--reason "..."]
 *   proxy-chat pause       --id <mandateId> [--reason "..."]
 *   proxy-chat resume      --id <mandateId>
 *   proxy-chat log-message --id <mandateId> --direction incoming|outgoing
 *                          --text "..." [--message-id <tgMsgId>]
 *                          [--timestamp <iso>]
 *   proxy-chat flag        --id <mandateId> --reason "..." [--severity high|medium|low]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(__dirname, '../../../agents/default/data/proxy-chat');
const mandatesPath = path.join(dataDir, 'mandates.json');

// --- utilities ---

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

function loadStore() {
  ensureDir(dataDir);
  if (!fs.existsSync(mandatesPath)) {
    return { version: 1, mandates: [] };
  }
  try {
    const raw = fs.readFileSync(mandatesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.version) parsed.version = 1;
    if (!Array.isArray(parsed.mandates)) parsed.mandates = [];
    return parsed;
  } catch (e) {
    throw new Error(`Failed to read mandates store: ${e.message}`);
  }
}

function saveStore(store) {
  ensureDir(dataDir);
  fs.writeFileSync(mandatesPath, JSON.stringify(store, null, 2));
}

function findMandate(store, id) {
  return store.mandates.find(m => m.id === id);
}

function findActiveByPeer(store, peerId) {
  const pid = String(peerId);
  return store.mandates.find(m => m.status === 'active' && String(m.peer?.userId) === pid);
}

// Support repeatable flags (--constraint ... --constraint ...)
function parseArgs(argv) {
  const out = { _: [] };
  const repeatable = new Set(['constraint', 'escalate-on']);
  for (const key of repeatable) out[key] = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith('--');
      const value = hasValue ? argv[i + 1] : true;
      if (repeatable.has(key)) out[key].push(value);
      else out[key] = value;
      i += hasValue ? 2 : 1;
    } else {
      out._.push(tok);
      i += 1;
    }
  }
  return out;
}

function requireArg(args, key, label = key) {
  const v = args[key];
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
    throw new Error(`${label} is required (use --${key} "...")`);
  }
  return v;
}

// --- commands ---

function cmdStart(args) {
  const peerId = String(requireArg(args, 'peer-id'));
  const objective = String(requireArg(args, 'objective'));
  const username = args.username ? String(args.username).replace(/^@/, '') : null;
  const name = args.name ? String(args.name) : null;

  const store = loadStore();

  // If an active mandate already exists for this peer, refuse — one active at a time per peer.
  const existing = findActiveByPeer(store, peerId);
  if (existing) {
    return {
      error: `An active mandate already exists for peer ${peerId} (id=${existing.id}). Close or pause it first.`,
      existing: { id: existing.id, objective: existing.objective }
    };
  }

  const mandate = {
    id: uuid(),
    peer: { userId: peerId, username, name },
    status: 'active',
    objective,
    persona: args.persona ? String(args.persona) : 'деловой, доброжелательный, без воды',
    context: args.context ? String(args.context) : '',
    constraints: Array.isArray(args.constraint) ? args.constraint : [],
    escalateOn: Array.isArray(args['escalate-on']) ? args['escalate-on'] : [],
    opening: args.opening ? String(args.opening) : null,
    conversation: [],
    flags: [],
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    closedAt: null,
    closedReason: null
  };

  store.mandates.push(mandate);
  saveStore(store);

  return { success: true, mandate };
}

function cmdList(args) {
  const store = loadStore();
  const filter = args.status || 'active';
  const items = filter === 'all'
    ? store.mandates
    : store.mandates.filter(m => m.status === filter);

  return {
    status: filter,
    count: items.length,
    mandates: items.map(m => ({
      id: m.id,
      status: m.status,
      peer: m.peer,
      objective: m.objective,
      messageCount: (m.conversation || []).length,
      flagCount: (m.flags || []).length,
      lastActivityAt: m.lastActivityAt,
      createdAt: m.createdAt,
      closedAt: m.closedAt
    }))
  };
}

function cmdGet(args) {
  const id = String(requireArg(args, 'id'));
  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };
  return { mandate };
}

function cmdFindByPeer(args) {
  const peerId = String(requireArg(args, 'peer-id'));
  const store = loadStore();
  const mandate = findActiveByPeer(store, peerId);
  if (!mandate) {
    return { found: false, peerId };
  }
  return { found: true, mandate };
}

function cmdClose(args) {
  const id = String(requireArg(args, 'id'));
  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };
  if (mandate.status === 'closed') return { success: true, alreadyClosed: true, mandate };

  mandate.status = 'closed';
  mandate.closedAt = nowIso();
  mandate.closedReason = args.reason ? String(args.reason) : null;
  mandate.lastActivityAt = nowIso();
  saveStore(store);
  return { success: true, mandate };
}

function cmdPause(args) {
  const id = String(requireArg(args, 'id'));
  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };
  if (mandate.status === 'closed') return { error: `Mandate ${id} is closed, cannot pause` };

  mandate.status = 'paused';
  mandate.pauseReason = args.reason ? String(args.reason) : null;
  mandate.lastActivityAt = nowIso();
  saveStore(store);
  return { success: true, mandate };
}

function cmdResume(args) {
  const id = String(requireArg(args, 'id'));
  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };
  if (mandate.status === 'closed') return { error: `Mandate ${id} is closed, cannot resume` };

  mandate.status = 'active';
  delete mandate.pauseReason;
  mandate.lastActivityAt = nowIso();
  saveStore(store);
  return { success: true, mandate };
}

function cmdLogMessage(args) {
  const id = String(requireArg(args, 'id'));
  const direction = String(requireArg(args, 'direction'));
  const text = String(requireArg(args, 'text'));

  if (!['incoming', 'outgoing'].includes(direction)) {
    return { error: `direction must be "incoming" or "outgoing"` };
  }

  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };

  const entry = {
    timestamp: args.timestamp ? String(args.timestamp) : nowIso(),
    direction,
    text,
    messageId: args['message-id'] ? String(args['message-id']) : null
  };

  if (!Array.isArray(mandate.conversation)) mandate.conversation = [];
  mandate.conversation.push(entry);
  mandate.lastActivityAt = entry.timestamp;
  saveStore(store);

  return { success: true, messageCount: mandate.conversation.length, entry };
}

function cmdFlag(args) {
  const id = String(requireArg(args, 'id'));
  const reason = String(requireArg(args, 'reason'));
  const severity = args.severity && ['high', 'medium', 'low'].includes(args.severity)
    ? args.severity
    : 'medium';

  const store = loadStore();
  const mandate = findMandate(store, id);
  if (!mandate) return { error: `Mandate ${id} not found` };

  const flag = { timestamp: nowIso(), severity, reason };
  if (!Array.isArray(mandate.flags)) mandate.flags = [];
  mandate.flags.push(flag);
  mandate.lastActivityAt = nowIso();
  saveStore(store);

  return { success: true, flagCount: mandate.flags.length, flag };
}

// --- dispatch ---

const DISPATCH = {
  start: cmdStart,
  list: cmdList,
  get: cmdGet,
  'find-by-peer': cmdFindByPeer,
  close: cmdClose,
  pause: cmdPause,
  resume: cmdResume,
  'log-message': cmdLogMessage,
  flag: cmdFlag
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command) {
    console.error(JSON.stringify({
      error: 'Command required',
      available: Object.keys(DISPATCH)
    }, null, 2));
    process.exit(1);
  }

  const fn = DISPATCH[command];
  if (!fn) {
    console.error(JSON.stringify({
      error: `Unknown command: ${command}`,
      available: Object.keys(DISPATCH)
    }, null, 2));
    process.exit(1);
  }

  try {
    const result = fn(args);
    console.log(JSON.stringify(result, null, 2));
    if (result && result.error) process.exit(1);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
  }
}

main();
