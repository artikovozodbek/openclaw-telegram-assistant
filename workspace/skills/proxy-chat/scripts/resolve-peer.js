#!/usr/bin/env node
/**
 * resolve-peer — resolve a Telegram identifier to a canonical peer.
 *
 * Accepts: @username, username, phone (+998...), numeric userId, or t.me URL.
 * Returns JSON: { userId, username, firstName, lastName, phone, accessHash }.
 *
 * Usage:
 *   resolve-peer.js --handle "@example_user"
 *   resolve-peer.js --handle "+998901234567"
 *   resolve-peer.js --handle "123456789"
 *
 * Reads TG_API_ID, TG_API_HASH, TG_USER_SESSION from env (.env loaded by caller
 * or via dotenv below).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function normalizeHandle(raw) {
  if (!raw) throw new Error('handle required');
  const trimmed = String(raw).trim();
  // t.me URL → extract username
  const tmeMatch = trimmed.match(/t\.me\/([^/?#]+)/i);
  if (tmeMatch) return { kind: 'username', value: tmeMatch[1] };
  // phone
  if (/^\+?\d{7,15}$/.test(trimmed) && trimmed.startsWith('+')) {
    return { kind: 'phone', value: trimmed };
  }
  // all digits → userId
  if (/^\d{5,}$/.test(trimmed)) {
    return { kind: 'userId', value: trimmed };
  }
  // else assume username
  return { kind: 'username', value: trimmed.replace(/^@/, '') };
}

async function resolveViaClient(client, handle) {
  const normalized = normalizeHandle(handle);

  if (normalized.kind === 'phone') {
    // Try contacts first, then import and look up
    const contacts = await client.invoke(new Api.contacts.GetContacts({ hash: 0 }));
    const bigIntUserId = (contacts?.users || []).find(u => u.phone === normalized.value.replace(/^\+/, ''));
    if (bigIntUserId) return bigIntUserId;
    // Fallback: resolvePhone (some deployments)
    try {
      const resolved = await client.invoke(new Api.contacts.ResolvePhone({ phone: normalized.value.replace(/^\+/, '') }));
      const uid = resolved?.peer?.userId;
      if (uid) return (resolved.users || []).find(u => String(u.id) === String(uid));
    } catch { /* ignore */ }
    throw new Error(`Phone ${normalized.value} not found in contacts or resolvable`);
  }

  // username or userId — getEntity handles both
  const entity = await client.getEntity(normalized.kind === 'userId' ? BigInt(normalized.value) : normalized.value);
  return entity;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handle = args.handle || args.h;
  if (!handle) {
    console.error(JSON.stringify({ error: 'Missing --handle "<@username|userId|+phone>"' }, null, 2));
    process.exit(1);
  }

  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const sessionString = process.env.TG_USER_SESSION;
  if (!apiId || !apiHash || !sessionString) {
    console.error(JSON.stringify({ error: 'TG_API_ID, TG_API_HASH, TG_USER_SESSION must be set in env' }, null, 2));
    process.exit(1);
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    deviceModel: 'OpenClaw Proxy Chat',
    systemVersion: 'Linux',
    appVersion: '1.0'
  });

  try {
    await client.connect();
    const entity = await resolveViaClient(client, handle);
    const peer = {
      userId: String(entity.id),
      username: entity.username || null,
      firstName: entity.firstName || null,
      lastName: entity.lastName || null,
      phone: entity.phone || null,
      bot: Boolean(entity.bot),
      // accessHash not strictly needed — gramjs caches it in its session when we getEntity again
      resolvedAt: new Date().toISOString()
    };
    console.log(JSON.stringify({ success: true, peer }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: `Failed to resolve "${handle}": ${e.errorMessage || e.message}` }, null, 2));
    process.exit(1);
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

main();
