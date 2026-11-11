#!/bin/bash
# MTProto setup — one-time Telegram user-session auth for meeting/task/proxy skills
# Idempotent: if TG_USER_SESSION is already set, just starts the tg-watcher.

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[mtproto]${NC} $*"; }
warn() { echo -e "${YELLOW}[mtproto]${NC} $*"; }
err()  { echo -e "${RED}[mtproto]${NC} $*" >&2; }

ENV_FILE="$ROOT_DIR/.env"
[ -f "$ENV_FILE" ] || { err ".env not found. Run ./start.sh once first."; exit 1; }

get_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | head -1 | tr -d '\r'; }

TG_API_ID=$(get_env TG_API_ID)
TG_API_HASH=$(get_env TG_API_HASH)
TG_USER_SESSION=$(get_env TG_USER_SESSION)

# Prompt for TG_API_ID / TG_API_HASH if missing
if [ -z "$TG_API_ID" ] || [ -z "$TG_API_HASH" ]; then
  warn "TG_API_ID and/or TG_API_HASH not set."
  warn "Get them from https://my.telegram.org/apps (log in with your Telegram phone, create an app)."
  warn "Edit .env, paste TG_API_ID and TG_API_HASH, then re-run: scripts/mtproto-setup.sh"
  warn "(meeting-scanner / task-scanner / proxy-chat will remain inactive until then)"
  exit 0
fi

# Already authenticated?
if [ -n "$TG_USER_SESSION" ]; then
  log "MTProto session already configured. Starting tg-watcher..."
  docker compose --profile mtproto up -d --force-recreate tg-watcher
  log "tg-watcher is running. meeting-scanner / task-scanner / proxy-chat are active."
  exit 0
fi

# Run auth-mtproto.js interactively (QR mode by default - scan with Telegram app)
log "Running MTProto authentication..."
log "You'll see a QR code. Scan it with your Telegram app (Settings -> Devices -> Link Desktop Device)."
echo ""

# Have auth-mtproto.js write output to a file on the mounted config volume so we
# can read the session string after the container exits (QR renders live on stdout).
HOST_SESSION_FILE="$ROOT_DIR/config/.tg_session.tmp"
rm -f "$HOST_SESSION_FILE"

docker compose run --rm \
  --entrypoint sh openclaw-cli -c \
  "node /home/node/.openclaw/workspace/skills/meeting-scanner/scripts/auth-mtproto.js | tee /home/node/.openclaw/.tg_session.tmp"

SESSION=""
if [ -f "$HOST_SESSION_FILE" ]; then
  SESSION=$(grep -oE '^TG_USER_SESSION=.+' "$HOST_SESSION_FILE" | tail -1 | cut -d= -f2-)
  rm -f "$HOST_SESSION_FILE"
fi

if [ -z "$SESSION" ]; then
  err "MTProto auth did not produce a session string."
  err "If the QR expired before you scanned, just re-run: scripts/mtproto-setup.sh"
  exit 1
fi

# Append / replace TG_USER_SESSION in .env
if grep -q '^TG_USER_SESSION=' "$ENV_FILE"; then
  sed -i.bak "s|^TG_USER_SESSION=.*|TG_USER_SESSION=$SESSION|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  printf '\nTG_USER_SESSION=%s\n' "$SESSION" >> "$ENV_FILE"
fi
log "TG_USER_SESSION saved to .env"

# Start tg-watcher
log "Starting tg-watcher..."
docker compose --profile mtproto up -d --force-recreate tg-watcher
log "Done. meeting-scanner / task-scanner / proxy-chat are now active."
