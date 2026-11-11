#!/bin/bash
set -euo pipefail

# OpenClaw + Chrome CDP + browser-use — full setup script
# Reuses running Chrome if CDP is active; only launches if needed.
# Copies selected Chrome profile (with logins) on first run.

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT=9222
CDP_PROXY_PORT=19222
CDP_DATA_DIR="$HOME/.openclaw/chrome-cdp-data"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
PROFILE_SAVE="$HOME/.openclaw/.cdp-profile"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_CONFIG="$ROOT_DIR/config/openclaw.json"
COMPOSE_DIR="$ROOT_DIR"
SKILL_FILE="$ROOT_DIR/workspace/.agents/skills/browser-use/SKILL.md"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[cdp]${NC} $*"; }
warn() { echo -e "${YELLOW}[cdp]${NC} $*"; }
err()  { echo -e "${RED}[cdp]${NC} $*" >&2; }

env_value() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ] && [ -f "$ROOT_DIR/.env" ]; then
    value=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ROOT_DIR/.env" 2>/dev/null | tail -n 1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//; s/[[:space:]]+#.*$//; s/^['\\\"]//; s/['\\\"]$//" || true)
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

# --- Check if CDP is already running ---
cdp_is_running() {
  curl -s --max-time 2 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1
}

docker_cdp_proxy_is_running() {
  (cd "$COMPOSE_DIR" && docker compose exec -T openclaw-gateway node -e "fetch('http://127.0.0.1:$CDP_PROXY_PORT/json/version').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))") >/dev/null 2>&1
}

# --- Select Chrome profile interactively ---
select_chrome_profile() {
  # If already saved, reuse
  if [ -f "$PROFILE_SAVE" ]; then
    CHROME_PROFILE=$(cat "$PROFILE_SAVE")
    if [ -d "$CHROME_DIR/$CHROME_PROFILE" ]; then
      log "Using saved profile: $CHROME_PROFILE"
      return 0
    fi
    warn "Saved profile '$CHROME_PROFILE' not found. Re-selecting..."
  fi

  # Find all profiles
  local profiles=()
  local names=()

  # List profile directories without requiring host Python. Docker is the only
  # required runtime; labels are less fancy, but startup remains portable.
  if [ ${#profiles[@]} -eq 0 ]; then
    for d in "$CHROME_DIR"/Default "$CHROME_DIR"/Profile*; do
      if [ -d "$d" ]; then
        profiles+=("$(basename "$d")")
        names+=("$(basename "$d")")
      fi
    done
  fi

  if [ ${#profiles[@]} -eq 0 ]; then
    warn "No Chrome profiles found."
    CHROME_PROFILE="Default"
    return 0
  fi

  if [ ${#profiles[@]} -eq 1 ]; then
    CHROME_PROFILE="${profiles[0]}"
    log "Only one profile found: ${names[0]}"
  else
    echo ""
    log "Select Chrome profile to use:"
    echo ""
    for i in "${!profiles[@]}"; do
      echo "  $((i+1)). ${names[$i]}"
    done
    echo ""
    read -rp "  Enter number [1-${#profiles[@]}]: " choice
    local idx=$((choice - 1))
    if [ "$idx" -lt 0 ] || [ "$idx" -ge ${#profiles[@]} ]; then
      err "Invalid choice"
      exit 1
    fi
    CHROME_PROFILE="${profiles[$idx]}"
    log "Selected: ${names[$idx]} (${CHROME_PROFILE})"
  fi

  # Save choice
  mkdir -p "$(dirname "$PROFILE_SAVE")"
  echo "$CHROME_PROFILE" > "$PROFILE_SAVE"
  log "Profile saved to $PROFILE_SAVE"
}

# --- Step 1: Ensure Chrome profile dir exists ---
setup_chrome_profile() {
  if [ -d "$CDP_DATA_DIR/Default" ] && [ ! -L "$CDP_DATA_DIR/Default" ] && [ -f "$CDP_DATA_DIR/Default/Cookies" ]; then
    log "CDP profile dir exists (standalone copy). Reusing."
    return 0
  fi

  select_chrome_profile

  log "Setting up Chrome CDP profile (one-time copy from $CHROME_PROFILE)..."

  if [ -L "$CDP_DATA_DIR/Default" ]; then
    rm -f "$CDP_DATA_DIR/Default"
  fi
  mkdir -p "$CDP_DATA_DIR"

  if [ -d "$CHROME_DIR/$CHROME_PROFILE" ]; then
    log "Copying profile (cookies, logins, storage)..."
    rsync -a \
      --exclude='Cache' \
      --exclude='Code Cache' \
      --exclude='Service Worker/CacheStorage' \
      --exclude='GPUCache' \
      --exclude='DawnGraphiteCache' \
      --exclude='DawnWebGPUCache' \
      --exclude='ShaderCache' \
      --exclude='GrShaderCache' \
      --exclude='*.log' \
      "$CHROME_DIR/$CHROME_PROFILE/" "$CDP_DATA_DIR/Default/"

    cp "$CHROME_DIR/Local State" "$CDP_DATA_DIR/Local State" 2>/dev/null || true

    rm -f "$CDP_DATA_DIR/Default/SingletonLock" \
          "$CDP_DATA_DIR/Default/SingletonSocket" \
          "$CDP_DATA_DIR/Default/SingletonCookie" \
          "$CDP_DATA_DIR/SingletonLock" \
          "$CDP_DATA_DIR/SingletonSocket" \
          "$CDP_DATA_DIR/SingletonCookie" \
          "$CDP_DATA_DIR/Default/LOCK" 2>/dev/null || true

    log "Profile copied. All logins and cookies preserved."
  else
    warn "Profile '$CHROME_PROFILE' not found. A fresh profile will be created."
    mkdir -p "$CDP_DATA_DIR/Default"
  fi
}

# --- Step 2: Launch Chrome with CDP (only if not already running) ---
launch_chrome() {
  if cdp_is_running; then
    log "Chrome CDP already running on port $CDP_PORT. Reusing."
    return 0
  fi

  if [ ! -f "$CHROME_APP" ]; then
    err "Chrome not found at $CHROME_APP"
    exit 1
  fi

  if pgrep -f "Google Chrome" >/dev/null 2>&1; then
    warn "Chrome is already running without CDP. Launching a separate CDP Chrome profile instead of requiring Chrome to quit."
  fi

  log "Launching Chrome with remote debugging on port $CDP_PORT..."
  if command -v open >/dev/null 2>&1; then
    open -na "Google Chrome" --args \
      --remote-debugging-address=0.0.0.0 \
      --remote-debugging-port=$CDP_PORT \
      '--remote-allow-origins=*' \
      --user-data-dir="$CDP_DATA_DIR" \
      --profile-directory=Default \
      --no-first-run \
      about:blank >/dev/null 2>&1
  else
    "$CHROME_APP" \
      --remote-debugging-address=0.0.0.0 \
      --remote-debugging-port=$CDP_PORT \
      '--remote-allow-origins=*' \
      --user-data-dir="$CDP_DATA_DIR" \
      --profile-directory=Default \
      --no-first-run \
      about:blank \
      &>/dev/null &
  fi

  log "Waiting for CDP..."
  for i in $(seq 1 30); do
    if cdp_is_running; then
      log "Chrome CDP ready."
      return 0
    fi
    sleep 1
  done

  err "Chrome CDP did not start within 30 seconds."
  exit 1
}

wait_docker_cdp_proxy() {
  log "Checking Docker CDP proxy..."
  for i in $(seq 1 20); do
    if docker_cdp_proxy_is_running; then
      log "Docker CDP proxy ready."
      return 0
    fi
    sleep 1
  done
  err "Chrome CDP is reachable on the host, but Docker cannot reach it through cdp-proxy."
  err "Check that Chrome was launched with remote debugging and that cdp-proxy is running."
  return 1
}

# --- Step 3: Get WebSocket URL ---
get_ws_url() {
  local ws_url
  ws_url=$(curl -fsS "http://localhost:$CDP_PORT/json/version" | sed -n 's/.*"webSocketDebuggerUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$ws_url" ]; then
    err "Could not read Chrome CDP WebSocket URL."
    exit 1
  fi
  echo "$ws_url" \
    | sed "s|ws://localhost:$CDP_PORT|ws://127.0.0.1:$CDP_PROXY_PORT|" \
    | sed "s|ws://127.0.0.1:$CDP_PORT|ws://127.0.0.1:$CDP_PROXY_PORT|"
}

# --- Step 4: Update OpenClaw config ---
update_openclaw_config() {
  local ws_url="$1"
  log "Updating OpenClaw config..."

  cd "$COMPOSE_DIR"
  docker compose exec -T -e OPENCLAW_CDP_WS_URL="$ws_url" openclaw-gateway node <<'NODE'
const fs = require("fs");
const path = "/home/node/.openclaw/openclaw.json";
const wsUrl = process.env.OPENCLAW_CDP_WS_URL;
const raw = fs.readFileSync(path, "utf8").replace(/^\ufeff/, "");
const cfg = JSON.parse(raw);
cfg.browser = cfg.browser || {};
cfg.browser.profiles = cfg.browser.profiles || {};
for (const profileName of ["openclaw", "chrome-cdp", "user"]) {
  cfg.browser.profiles[profileName] = cfg.browser.profiles[profileName] || {};
  cfg.browser.profiles[profileName].cdpUrl = wsUrl;
}
cfg.browser.remoteCdpTimeoutMs = 10000;
cfg.browser.remoteCdpHandshakeTimeoutMs = 15000;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
NODE
  log "Config updated."
}

# --- Step 5: Update browser-use skill ---
update_skill() {
  local ws_url="$1"
  if [ ! -f "$SKILL_FILE" ]; then
    warn "browser-use skill not found, skipping."
    return 0
  fi

  log "Updating browser-use skill..."
  cd "$COMPOSE_DIR"
  docker compose exec -T -e OPENCLAW_CDP_WS_URL="$ws_url" openclaw-gateway node <<'NODE'
const fs = require("fs");
const skillPath = "/home/node/.openclaw/workspace/.agents/skills/browser-use/SKILL.md";
const wsUrl = process.env.OPENCLAW_CDP_WS_URL;
if (!fs.existsSync(skillPath)) process.exit(0);
let content = fs.readFileSync(skillPath, "utf8");
content = content.replace(/\n## Default CDP Configuration\n[\s\S]*?(?=\n## |$)/, "");
const fence = "```";
const block = [
  "",
  "",
  "## Default CDP Configuration",
  "",
  "IMPORTANT: Always use the following flag to connect to the user existing Chrome browser:",
  fence,
  `browser-use --cdp-url ${wsUrl} <command>`,
  fence,
  "",
  "This connects to the user real Chrome with all their existing logins and sessions.",
  "",
].join("\n");
fs.writeFileSync(skillPath, content.trimEnd() + block);
NODE
  log "Skill updated."
}

# --- Step 6: Restart OpenClaw gateway ---
restart_gateway() {
  log "Restarting OpenClaw gateway..."
  cd "$COMPOSE_DIR"
  docker compose restart openclaw-gateway >/dev/null 2>&1
  docker compose up -d --force-recreate openclaw-cli cdp-proxy >/dev/null 2>&1
  sleep 5

  if curl -fsS "http://127.0.0.1:18789/healthz" >/dev/null 2>&1; then
    log "Gateway healthy."
  else
    warn "Waiting for gateway..."
    sleep 10
    if curl -fsS "http://127.0.0.1:18789/healthz" >/dev/null 2>&1; then
      log "Gateway healthy."
    else
      err "Gateway health check failed."
    fi
  fi
}

# --- Step 7: Verify ---
verify() {
  local ws_url="$1"
  log "Verifying..."

  cd "$COMPOSE_DIR"
  local result
  result=$(docker compose exec openclaw-gateway node dist/index.js browser --browser-profile openclaw tabs 2>&1 || true)
  result=$(printf '%s\n' "$result" | sed -n '1,5p')
  if echo "$result" | grep -q "http\|chrome\|New Tab\|about:blank"; then
    log "Browser CDP verified."
  else
    warn "Browser check returned: $result"
  fi

  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  OpenClaw + Chrome CDP ready!${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo "  Chrome CDP:  ws://localhost:$CDP_PORT"
  echo "  Docker CDP:  $ws_url"
  echo "  Gateway:     http://127.0.0.1:18789"
  echo ""
  echo "  Re-run anytime:  $0"
  echo ""
}

# --- Main ---
main() {
  echo ""
  if env_truthy OPENCLAW_SKIP_CDP; then
    log "OPENCLAW_SKIP_CDP is enabled; skipping Chrome CDP/profile setup."
    echo ""
    return 0
  fi

  log "OpenClaw + Chrome CDP setup"
  echo ""

  setup_chrome_profile
  launch_chrome
  wait_docker_cdp_proxy

  WS_URL=$(get_ws_url)
  log "WebSocket URL: $WS_URL"

  update_openclaw_config "$WS_URL"
  update_skill "$WS_URL"
  restart_gateway
  wait_docker_cdp_proxy
  verify "$WS_URL"
}

main "$@"
