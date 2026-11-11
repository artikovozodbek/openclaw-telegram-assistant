@echo off
docker compose restart openclaw-gateway
docker compose up -d --force-recreate cdp-proxy
docker compose --profile mtproto up -d --force-recreate tg-watcher
