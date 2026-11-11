#!/bin/bash
# Auto-lock watcher: runs in background after start.sh. Watches gateway logs
# for the first outgoing Telegram reply, grabs the chat ID (= the CEO who
# initiated the first DM), switches dmPolicy to "allowlist" with just that ID,
# restarts gateway, and exits.
#
# Idempotent: exits immediately if config/.owner_locked exists.

set -uo pipefail
cd "$(dirname "$0")/.."

LOCK_MARKER="config/.owner_locked"
LOG="config/.owner_lock.log"

# Already locked? Nothing to do.
if [ -f "$LOCK_MARKER" ]; then exit 0; fi

# Compose logs may still be empty at this moment - poll up to 60 min.
echo "[$(date -u +%FT%TZ)] owner-lock-watcher started" >> "$LOG" 2>/dev/null || true

for i in $(seq 1 1200); do
  sleep 3
  CHAT_ID=$(docker compose logs --no-color openclaw-gateway 2>/dev/null \
    | sed $'s/\x1b\\[[0-9;]*m//g' \
    | grep -oE '\[telegram\][[:space:]]+sendMessage[[:space:]]+ok[[:space:]]+chat=[0-9]+' \
    | head -1 | grep -oE '[0-9]+$')

  if [ -n "$CHAT_ID" ]; then
    echo "[$(date -u +%FT%TZ)] detected first CEO chat=$CHAT_ID, locking..." >> "$LOG"

    # Patch openclaw.json from inside the container (it has node + the file mounted)
    docker compose exec -T openclaw-gateway node -e "
const fs = require('fs');
const path = '/home/node/.openclaw/openclaw.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.dmPolicy = 'allowlist';
cfg.channels.telegram.allowFrom = ['$CHAT_ID'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('config patched: allowlist = [$CHAT_ID]');
" >> "$LOG" 2>&1

    docker compose restart openclaw-gateway >> "$LOG" 2>&1 || true
    echo "$CHAT_ID" > "$LOCK_MARKER"
    echo "[$(date -u +%FT%TZ)] locked to $CHAT_ID, exiting." >> "$LOG"
    exit 0
  fi
done

echo "[$(date -u +%FT%TZ)] timed out after 60 min waiting for first DM. Not locked." >> "$LOG"
exit 0
