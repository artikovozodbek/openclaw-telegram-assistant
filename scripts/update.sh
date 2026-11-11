#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[update]${NC} $*"; }

log "Pulling latest OpenClaw image..."
docker pull "$OPENCLAW_IMAGE"

log "Restarting OpenClaw services..."
OPENCLAW_IMAGE="$OPENCLAW_IMAGE" docker compose up -d --force-recreate openclaw-gateway openclaw-cli cdp-proxy

sleep 8
if curl -fsS http://127.0.0.1:18789/healthz >/dev/null 2>&1; then
  log "Gateway healthy. Update complete!"
else
  log "Warning: gateway not healthy yet. Check: docker compose logs -f openclaw-gateway"
fi
