#!/usr/bin/env node
/**
 * One-time MTProto auth for the meeting-scanner watcher — QR code login.
 *
 * This bypasses Telegram's SMS/app-code rate-limiting completely. Instead of
 * sending a code to your phone, we generate a QR that your existing Telegram
 * app scans to authorize this new session. No codes, no cooldowns, no waiting.
 *
 * What you need:
 *   - Telegram already logged in on your phone (iOS/Android) OR desktop
 *   - Your Telegram app settings at hand
 *   - TG_API_ID and TG_API_HASH in .env (from https://my.telegram.org/apps)
 *
 * How to run:
 *   docker compose run --rm --entrypoint node openclaw-cli \
 *     /home/node/.openclaw/workspace/skills/meeting-scanner/scripts/auth-mtproto.js
 *
 * How to scan the QR:
 *   iOS / Android Telegram:  Settings → Devices → Link Desktop Device → scan
 *   Telegram Desktop:        Settings → Privacy & Security → Linked Devices → Link Device
 *
 * On success the script prints a TG_USER_SESSION=… line — paste it into .env.
 *
 * If you'd rather use the old phone+code flow, pass --phone:
 *   docker compose run --rm --entrypoint node openclaw-cli \
 *     /home/node/.openclaw/workspace/skills/meeting-scanner/scripts/auth-mtproto.js --phone
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const input = require('input');
const qrcode = require('qrcode-terminal');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error('ERROR: TG_API_ID and TG_API_HASH must be set in .env');
  console.error('Get them from https://my.telegram.org/apps');
  process.exit(1);
}

const usePhoneMode = process.argv.includes('--phone');

function printBanner() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  MTProto auth for meeting-scanner watcher');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  API ID:    ${apiId}`);
  console.log(`  API hash:  ${apiHash.slice(0, 6)}…`);
  console.log(`  Mode:      ${usePhoneMode ? 'Phone + SMS code' : 'QR code (scan from your existing Telegram)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

async function runQrLogin(client) {
  // GramJS's signInUserWithQrCode hits AUTH_TOKEN_EXPIRED during DC migration
  // (QR generated on DC 1, account lives on DC 2, ~2s migration window eats the
  // 30-second token life). So we retry with a fresh QR up to 5 times.
  const MAX_ATTEMPTS = 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(attempt === 1
        ? 'Waiting for your Telegram app to scan the QR code…'
        : `\n(attempt ${attempt}/${MAX_ATTEMPTS} — previous QR expired; new one below)`);
      if (attempt === 1) {
        console.log('(Open phone Telegram → Settings → Devices → Link Desktop Device → scan)\n');
      }

      await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          onError: async (err) => {
            // returning false lets GramJS keep looping; we break out only on
            // terminal failures (already handled by the outer try/catch).
            return false;
          },
          qrCode: async (qr) => {
            const tokenB64 = qr.token.toString('base64')
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const url = `tg://login?token=${tokenB64}`;
            const secsLeft = qr.expires
              ? Math.max(0, Math.round(qr.expires - Date.now() / 1000))
              : 30;

            console.log('\n─── Scan this QR from your phone Telegram ───');
            qrcode.generate(url, { small: true });
            console.log(`URL (if you need to paste): ${url}`);
            console.log(`(QR expires in ~${secsLeft}s — if it expires we regenerate automatically)\n`);
          },
          password: async () => {
            console.log('\n2FA cloud password required.');
            return await input.password('Password: ');
          },
        }
      );
      return; // success
    } catch (err) {
      lastErr = err;
      const msg = err.errorMessage || err.message || '';
      if (msg === 'AUTH_TOKEN_EXPIRED' || msg.includes('AUTH_TOKEN_EXPIRED')) {
        console.log(`\n(QR token expired during DC migration — generating a new one…)`);
        continue;
      }
      if (msg === 'AUTH_TOKEN_INVALID' || msg.includes('AUTH_TOKEN_INVALID')) {
        console.log(`\n(QR token rejected — generating a new one…)`);
        continue;
      }
      // unexpected failure → bail out
      throw err;
    }
  }
  throw lastErr || new Error('QR login failed after max attempts');
}

async function runPhoneLogin(client) {
  const phone = (await input.text('Phone (with + and country code, e.g. +998901234567): ')).trim();
  if (!phone.startsWith('+')) {
    console.error('ERROR: phone must start with + and country code.');
    process.exit(1);
  }

  let sentCode;
  try {
    sentCode = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({
        allowFlashcall: true,
        currentNumber: true,
        allowAppHash: true,
        allowMissedCall: true,
      }),
    }));
  } catch (err) {
    const sec = Number(err.seconds) || 0;
    if (sec > 0) {
      console.error(`\n✗ FLOOD_WAIT: wait ${sec}s (~${Math.ceil(sec / 60)} min) before retrying.\n`);
    } else {
      console.error('\n✗ sendCode failed:', err.errorMessage || err.message);
    }
    process.exit(1);
  }
  let hash = sentCode.phoneCodeHash;
  console.log(`\nCode sent via ${sentCode.type?.className}. Press Enter to ask for resend via next channel.\n`);

  while (true) {
    const code = (await input.text('Code: ')).trim();
    if (!code) {
      try {
        const r = await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: hash }));
        hash = r.phoneCodeHash;
        console.log(`↪ Resent via ${r.type?.className}\n`);
      } catch (e) { console.error('Resend failed:', e.errorMessage || e.message, '\n'); }
      continue;
    }
    try {
      await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
      return;
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const pw = await input.password('2FA password: ');
        const info = await client.invoke(new Api.account.GetPassword());
        const chk = await computeCheck(info, pw);
        await client.invoke(new Api.auth.CheckPassword({ password: chk }));
        return;
      }
      if (err.errorMessage === 'PHONE_CODE_INVALID') {
        console.error('✗ Wrong code. Try again.\n');
        continue;
      }
      throw err;
    }
  }
}

(async () => {
  printBanner();

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: 'OpenClaw Meeting Watcher',
    systemVersion: 'Linux',
    appVersion: '1.0',
    useWSS: false,
  });

  await client.connect();
  console.log('✓ Connected to Telegram\n');

  if (usePhoneMode) {
    await runPhoneLogin(client);
  } else {
    await runQrLogin(client);
  }

  const me = await client.getMe();
  console.log(`\n✓ Signed in as ${me.firstName || ''} ${me.lastName || ''} (id=${me.id}, @${me.username || '—'})`);

  const sessionString = client.session.save();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUCCESS — copy this ONE line into .env:');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`TG_USER_SESSION=${sessionString}`);
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Then:  docker compose up -d tg-watcher');
  console.log('═══════════════════════════════════════════════════════════════\n');

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('\nFATAL:', err.errorMessage || err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
