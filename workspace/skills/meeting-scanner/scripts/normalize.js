#!/usr/bin/env node

const fs = require('fs');

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      args._.push(current);
      i += 1;
    }
  }
  return args;
}

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required --${key}`);
  }
  return String(args[key]);
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON file ${filePath}: ${error.message}`);
  }
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function deriveRole(message) {
  const declaredRole = lower(
    message.senderRole ||
    message.role ||
    message.authorRole ||
    message.party
  );
  if (declaredRole === 'ceo' || declaredRole === 'owner') return 'ceo';
  if (declaredRole === 'counterparty' || declaredRole === 'peer') return 'counterparty';

  const direction = lower(message.direction);
  if (direction === 'outgoing') return 'ceo';
  if (direction === 'incoming') return 'counterparty';
  return 'unknown';
}

function deriveKind(message) {
  const kind = lower(message.kind || message.type || message.messageType);
  if (kind === 'voice' || kind === 'voice_note' || kind === 'voice-note') return 'voice';
  if (kind === 'audio') return 'audio';
  if (kind === 'text') return 'text';
  if (kind === 'photo') return 'photo';
  if (kind === 'video') return 'video';
  return 'other';
}

function normalizeMessage(message, index) {
  const timestamp = message.timestamp || message.date || message.createdAt || message.sentAt || null;
  const role = deriveRole(message);
  const kind = deriveKind(message);
  const text = String(
    message.text ||
    message.body ||
    message.caption ||
    message.message ||
    ''
  ).trim();
  const transcript = String(
    message.transcript ||
    message.voiceTranscript ||
    message.audioTranscript ||
    ''
  ).trim();
  const searchableText = [text, transcript].filter(Boolean).join('\n').trim();

  return {
    messageId: message.messageId || message.id || message.msgId || String(index + 1),
    timestamp,
    senderRole: role,
    senderName: message.senderName || message.sender || message.author || null,
    senderUsername: message.senderUsername || message.username || null,
    direction: message.direction || (role === 'ceo' ? 'outgoing' : role === 'counterparty' ? 'incoming' : 'unknown'),
    kind,
    text,
    transcript,
    searchableText,
    hasMedia: Boolean(message.hasMedia || transcript || kind === 'voice' || kind === 'audio' || kind === 'photo' || kind === 'video')
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataFile = requireArg(args, 'data-file');
  const payload = loadJson(dataFile);
  const messages = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.messages)
      ? payload.messages
      : [];

  const normalizedMessages = messages.map(normalizeMessage);
  const participants = [...new Set(
    normalizedMessages
      .map(message => message.senderName)
      .filter(Boolean)
  )];

  const summary = {
    messageCount: normalizedMessages.length,
    voiceCount: normalizedMessages.filter(message => message.kind === 'voice' || message.kind === 'audio').length,
    activationKeywordSeen: normalizedMessages.some(message =>
      message.senderRole === 'ceo' && message.searchableText.toLowerCase().includes('asssalom')
    ),
    ceoStopDetected: normalizedMessages.some(message =>
      message.senderRole === 'ceo' && message.searchableText.includes('tamom')
    ),
    lastMessageId: normalizedMessages.length ? normalizedMessages[normalizedMessages.length - 1].messageId : null,
    lastMessageAt: normalizedMessages.length ? normalizedMessages[normalizedMessages.length - 1].timestamp : null,
    participants
  };

  const normalized = {
    version: 1,
    chat: payload.chat || null,
    messages: normalizedMessages,
    summary
  };

  if (args['output-file']) {
    fs.writeFileSync(args['output-file'], JSON.stringify(normalized, null, 2));
  }

  process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
