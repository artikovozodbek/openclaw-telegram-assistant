#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose restart openclaw-gateway
docker compose up -d --force-recreate cdp-proxy
docker compose --profile mtproto up -d --force-recreate tg-watcher || true
