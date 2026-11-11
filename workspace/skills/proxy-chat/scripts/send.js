#!/usr/bin/env node
/**
 * send — send a Telegram text message via MTProto to a resolved peer.
 *
 * Usage:
 *   send.js --peer-id <userId> --text "..."
 *   send.js --username <u>    --text "..."
 *   send.js --peer-id <userId> --text-file /tmp/reply.txt
 *
 * Prints JSON: { success: true, messageId, peerId, sentAt }.
 * Exits non-zero on failure.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const peerId = args['peer-id'];
  const username = args.username;
  let text = args.text;
  if (!text && args['text-file']) {
    text = fs.readFileSync(args['text-file'], 'utf8');
  }

  if (!peerId && !username) {
    console.error(JSON.stringify({ error: 'Need --peer-id <userId> or --username <u>' }, null, 2));
    process.exit(1);
  }
  if (!text || !String(text).trim()) {
    console.error(JSON.stringify({ error: 'Need --text "..." or --text-file <path>' }, null, 2));
    process.exit(1);
  }

  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const sessionString = process.env.TG_USER_SESSION;
  if (!apiId || !apiHash || !sessionString) {
    console.error(JSON.stringify({ error: 'TG_API_ID, TG_API_HASH, TG_USER_SESSION must be set' }, null, 2));
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
    const target = peerId ? BigInt(peerId) : username.replace(/^@/, '');
    const entity = await client.getEntity(target);
    const sent = await client.sendMessage(entity, { message: String(text) });
    console.log(JSON.stringify({
      success: true,
      messageId: String(sent.id),
      peerId: String(entity.id),
      username: entity.username || null,
      sentAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: `Send failed: ${e.errorMessage || e.message}` }, null, 2));
    process.exit(1);
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

main();
