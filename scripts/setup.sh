#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log() { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*" >&2; }

OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"

dc() {
  OPENCLAW_IMAGE="$OPENCLAW_IMAGE" docker compose "$@"
}

env_value() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ] && [ -f "$ROOT_DIR/.env" ]; then
    value=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ROOT_DIR/.env" 2>/dev/null | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//; s/[[:space:]]+#.*$//; s/^['\\\"]//; s/['\\\"]$//" || true)
  fi
  printf '%s' "$value"
}

env_nonblank() {
  [ -n "$(env_value "$1" | tr -d '[:space:]')" ]
}

configure_openclaw_telegram() {
  local telegram_enabled=false
  local mcp_enabled=false

  if env_nonblank TELEGRAM_BOT_TOKEN; then
    telegram_enabled=true
  fi
  if env_nonblank TG_API_ID && env_nonblank TG_API_HASH && env_nonblank TG_USER_SESSION; then
    mcp_enabled=true
  fi

  log "Configuring Telegram channel=$telegram_enabled, telegram-mcp=$mcp_enabled"
  if OPENCLAW_TELEGRAM_ENABLED="$telegram_enabled" \
     OPENCLAW_TELEGRAM_MCP_ENABLED="$mcp_enabled" \
     docker run --rm -i --user root \
       -e OPENCLAW_TELEGRAM_ENABLED \
       -e OPENCLAW_TELEGRAM_MCP_ENABLED \
       -v "$ROOT_DIR:/project" \
       -w /project \
       --entrypoint node \
       "$OPENCLAW_IMAGE" - <<'NODE'
const fs = require("fs");

const telegramEnabled = process.env.OPENCLAW_TELEGRAM_ENABLED === "true";
const mcpEnabled = process.env.OPENCLAW_TELEGRAM_MCP_ENABLED === "true";
const files = [
  "/project/config/openclaw.json",
  "/project/config-custom/openclaw.json",
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8").replace(/^\ufeff/, "");
  const cfg = JSON.parse(raw);

  cfg.channels = cfg.channels || {};
  cfg.channels.telegram = cfg.channels.telegram || {};
  cfg.channels.telegram.enabled = telegramEnabled;

  cfg.mcp = cfg.mcp || {};
  cfg.mcp.servers = cfg.mcp.servers || {};
  if (cfg.mcp.servers["telegram-mcp"]) {
    cfg.mcp.servers["telegram-mcp"].enabled = mcpEnabled;
  }

  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
NODE
  then
    log "OpenClaw Telegram config prepared."
  else
    warn "Could not preconfigure Telegram settings. Continuing; check config/openclaw.json if startup fails."
  fi
}

wait_for_gateway() {
  local timeout="${1:-90}"
  local i
  for i in $(seq 1 "$timeout"); do
    if curl -fsS "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

log "OpenClaw first-time setup"

# Create required subdirs
mkdir -p config/agents/main/agent config/agents/main/sessions config/identity \
         config/canvas config/logs config/cron config/devices \
         workspace/.agents/skills/browser-use

# Pull image
log "Pulling OpenClaw Docker image..."
docker pull "$OPENCLAW_IMAGE"

configure_openclaw_telegram

# Fix permissions
log "Fixing permissions..."
dc run --rm --user root --entrypoint sh openclaw-cli -c \
  'find /home/node/.openclaw -xdev -exec chown node:node {} +; \
   [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'

# Start gateway briefly to install browser-use
log "Starting gateway..."
dc up -d openclaw-gateway cdp-proxy

if wait_for_gateway 90; then
  log "Gateway healthy."
else
  warn "Gateway did not become healthy. Recent logs:"
  dc logs --tail 120 openclaw-gateway || true
  exit 1
fi

# Install browser-use
log "Installing browser-use CLI (persisted in config/browser-use-env/)..."
dc exec --user root openclaw-gateway sh -c \
  'apt-get update -qq && apt-get install -y -qq python3-pip python3-venv 2>&1 | tail -1' || true
dc exec openclaw-gateway sh -c '
  if [ ! -x /home/node/.openclaw/browser-use-env/bin/browser-use ]; then
    python3 -m venv /home/node/.openclaw/browser-use-env
    . /home/node/.openclaw/browser-use-env/bin/activate
    pip install "browser-use @ git+https://github.com/browser-use/browser-use.git@main" 2>&1 | tail -3
  fi
' || true

log "Installing workspace npm deps (gramjs, dotenv, form-data)..."
dc exec openclaw-gateway sh -c 'cd /home/node/.openclaw/workspace && [ -d node_modules ] || npm install --omit=dev --silent' 2>&1 | tail -3 || true

log "Verifying..."
curl -fsS "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/healthz" || true
echo ""

log "Setup complete!"
echo ""
