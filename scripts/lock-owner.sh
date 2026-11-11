#!/bin/bash
# Manual owner lock: prompts for a Telegram user ID and restricts the bot
# so only that ID can DM it. Writes config/.owner_locked so the auto-lock
# watcher (owner-lock-watcher.sh) won't interfere.
#
# To re-lock to a different user: delete config/.owner_locked and re-run.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==============================================="
echo " Lock OpenClaw bot to a single Telegram user"
echo "==============================================="
echo ""
echo "Don't know your Telegram ID? DM @userinfobot on Telegram - it replies with your numeric ID."
echo ""

read -rp "Enter your Telegram user ID (numeric): " TG_ID

if ! [[ "$TG_ID" =~ ^[0-9]+$ ]]; then
  echo "[lock-owner] ERROR: '$TG_ID' is not a valid numeric Telegram ID."
  exit 1
fi

# Make sure the gateway is running so we can exec node inside it
if ! docker compose ps --status running --services 2>/dev/null | grep -q '^openclaw-gateway$'; then
  echo "[lock-owner] Gateway not running - starting it..."
  docker compose up -d openclaw-gateway
  sleep 4
fi

# Patch openclaw.json from inside the container (guaranteed node runtime).
# Strip UTF-8 BOM if present — openclaw.json may have been written by a tool that adds one.
if ! docker compose exec -T openclaw-gateway node -e "
const fs = require('fs');
const path = '/home/node/.openclaw/openclaw.json';
const raw = fs.readFileSync(path, 'utf8').replace(/^\ufeff/, '');
const cfg = JSON.parse(raw);
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.dmPolicy = 'allowlist';
cfg.channels.telegram.allowFrom = ['$TG_ID'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('[lock-owner] config patched: allowlist = [$TG_ID]');
"; then
  echo "[lock-owner] ERROR: config patch failed. Bot was NOT locked." >&2
  exit 1
fi

echo "[lock-owner] Restarting gateway to apply..."
docker compose restart openclaw-gateway >/dev/null

echo "$TG_ID" > config/.owner_locked

echo ""
echo "[lock-owner] Done. Bot now only responds to Telegram user ID: $TG_ID"
echo "[lock-owner] To change owner: delete config/.owner_locked and re-run this script."
