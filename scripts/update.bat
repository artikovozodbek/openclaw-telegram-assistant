@echo off
if "%OPENCLAW_IMAGE%"=="" set "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest"
docker pull "%OPENCLAW_IMAGE%"
docker compose up -d --force-recreate openclaw-gateway openclaw-cli cdp-proxy
