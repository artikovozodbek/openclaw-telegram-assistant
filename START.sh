#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() { echo "[start] $*"; }
warn() { echo "[start] WARNING: $*" >&2; }
err() { echo "[start] ERROR: $*" >&2; }

restore_executable_bits() {
  command -v chmod >/dev/null 2>&1 || return 0

  local path
  for path in \
    START.sh \
    scripts/*.sh \
    workspace/bin/gws \
    workspace/bin/tg-send \
    workspace/bin/gws-register-account \
    workspace/bin/*.js \
    workspace/vendor/uv/linux/uv \
    workspace/vendor/uv/linux/uvx \
    workspace/vendor/googleworkspace-cli/npm/bin/gws
  do
    [ -e "$path" ] || continue
    chmod +x "$path" 2>/dev/null || true
  done
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker was not found. Install and start Docker Desktop, then run: bash START.sh"
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose was not found. Update Docker Desktop, then run: bash START.sh"
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    err "Docker Desktop is not running. Start it, wait until it is ready, then run: bash START.sh"
    exit 1
  fi
}

has_google_workspace_account_env() {
  [ -f .env ] || return 1
  env_nonblank GOOGLE_WORKSPACE_ACCOUNT_EMAIL ||
    env_nonblank OPENCLAW_GWS_ACCOUNT_EMAIL ||
    env_nonblank GWS_ACCOUNT_EMAIL ||
    env_nonblank GMAIL_ACCOUNT
}

setup_google_workspace_account() {
  has_google_workspace_account_env || return 0

  if ! command -v node >/dev/null 2>&1; then
    warn "Google Workspace account is configured, but Node.js was not found on the host."
    warn "Skipping Google Workspace auth; run: node workspace/bin/gws-register-account.js --from-env --set-default --yes"
    return 0
  fi

  node workspace/bin/gws-register-account.js --from-env --skip-if-missing --set-default --yes --startup || \
    warn "Google Workspace account setup did not complete. Run: node workspace/bin/gws-register-account.js --from-env --set-default --yes"
}

env_value() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" .env 2>/dev/null | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//; s/[[:space:]]+#.*$//; s/^['\\\"]//; s/['\\\"]$//" || true)
  fi
  printf '%s' "$value"
}

env_truthy() {
  local value
  value=$(env_value "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$value" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

env_nonblank() {
  [ -n "$(env_value "$1" | tr -d '[:space:]')" ]
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  else
    date +%s | shasum 2>/dev/null | awk '{print $1}'
  fi
}

restore_executable_bits
require_docker

# First run: create .env from template
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  log "Created .env from .env.example"
  setup_google_workspace_account
  log "Open .env and paste your required credentials, then re-run: bash START.sh"
  exit 0
fi

if [ ! -f .env ]; then
  err ".env not found and .env.example is missing. Create .env, then run: bash START.sh"
  exit 1
fi

# Auto-generate gateway token if missing
if ! grep -q '^OPENCLAW_GATEWAY_TOKEN=' .env 2>/dev/null; then
  TOKEN=$(generate_token)
  printf '\nOPENCLAW_GATEWAY_TOKEN=%s\n' "$TOKEN" >> .env
  log "Generated OPENCLAW_GATEWAY_TOKEN (saved to .env)"
fi

setup_google_workspace_account

bash scripts/setup.sh
if env_truthy OPENCLAW_SKIP_CDP; then
  log "OPENCLAW_SKIP_CDP is enabled; skipping Chrome CDP/profile setup."
else
  bash scripts/start-cdp.sh
fi

# Offer MTProto setup only when Telegram bot + MTProto app credentials are present.
if ! env_nonblank TELEGRAM_BOT_TOKEN; then
  log "TELEGRAM_BOT_TOKEN is blank; Telegram channel, owner lock, and tg-watcher startup are skipped."
elif ! env_nonblank TG_API_ID || ! env_nonblank TG_API_HASH; then
  log "TG_API_ID/TG_API_HASH are blank; MTProto skills are inactive."
elif ! env_nonblank TG_USER_SESSION; then
  bash scripts/mtproto-setup.sh || warn "MTProto setup skipped - meeting-scanner/task-scanner/proxy-chat are inactive until you run: bash scripts/mtproto-setup.sh"
else
  log "Starting tg-watcher daemon..."
  docker compose --profile mtproto up -d --force-recreate tg-watcher || true
fi

# Owner lock: prompt for the Telegram ID that should own the bot.
# If blank/invalid, fall back to the background watcher (locks to first DM).
# Idempotent - skipped if config/.owner_locked already exists.
if env_nonblank TELEGRAM_BOT_TOKEN && [ ! -f config/.owner_locked ]; then
  echo ""
  echo "==============================================="
  echo " Restrict Telegram bot to a single user"
  echo "==============================================="
  echo "DM @userinfobot on Telegram to get your numeric ID."
  echo "Leave blank to auto-lock to the first user who DMs the bot."
  echo ""
  TG_ID=""
  if [ -t 0 ]; then
    read -rp "Your Telegram user ID: " TG_ID || true
    TG_ID=$(echo "${TG_ID:-}" | tr -d '[:space:]')
  fi
  if [[ "$TG_ID" =~ ^[0-9]+$ ]]; then
    if docker compose exec -T openclaw-gateway node -e "
const fs = require('fs');
const path = '/home/node/.openclaw/openclaw.json';
const raw = fs.readFileSync(path, 'utf8').replace(/^\ufeff/, '');
const cfg = JSON.parse(raw);
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.dmPolicy = 'allowlist';
cfg.channels.telegram.allowFrom = ['$TG_ID'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('[start] Bot locked to Telegram ID $TG_ID');
"; then
      docker compose restart openclaw-gateway >/dev/null
      echo "$TG_ID" > config/.owner_locked
      log "Telegram bot is now restricted to user ID: $TG_ID"
    else
      err "Config patch failed. Bot was NOT locked. Run: bash scripts/lock-owner.sh"
    fi
  else
    [ -n "$TG_ID" ] && warn "'$TG_ID' is not a valid numeric ID. Falling back to auto-lock watcher."
    nohup bash scripts/owner-lock-watcher.sh > /dev/null 2>&1 &
    log "Owner auto-lock watcher is active - first person to DM the bot locks it."
  fi
fi

echo ""
echo "========================================"
echo "  OpenClaw startup complete"
echo "========================================"
echo ""
echo "  Gateway: http://127.0.0.1:18789"
if env_truthy OPENCLAW_SKIP_CDP; then
  echo "  Browser CDP: skipped"
else
  echo "  Browser CDP: configured"
fi
if env_nonblank TELEGRAM_BOT_TOKEN; then
  echo "  Telegram bot: configured"
else
  echo "  Telegram bot: skipped"
fi
echo ""
