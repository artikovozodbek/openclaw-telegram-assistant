# Manual owner lock (Windows): prompts for a Telegram user ID and restricts
# the bot so only that ID can DM it. Writes config\.owner_locked so the
# auto-lock watcher won't interfere.
#
# To re-lock to a different user: delete config\.owner_locked and re-run.

$ErrorActionPreference = 'Stop'
$ROOT = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ROOT

Write-Host "==============================================="
Write-Host " Lock OpenClaw bot to a single Telegram user"
Write-Host "==============================================="
Write-Host ""
Write-Host "Don't know your Telegram ID? DM @userinfobot on Telegram - it replies with your numeric ID."
Write-Host ""

$tgId = Read-Host "Enter your Telegram user ID (numeric)"

if ($tgId -notmatch '^\d+$') {
  Write-Host "[lock-owner] ERROR: '$tgId' is not a valid numeric Telegram ID." -ForegroundColor Red
  exit 1
}

# Ensure the gateway container is up
$running = docker compose ps --status running --services 2>$null
if (-not ($running -match '^openclaw-gateway$')) {
  Write-Host "[lock-owner] Gateway not running - starting it..."
  docker compose up -d openclaw-gateway | Out-Null
  Start-Sleep -Seconds 4
}

$nodeScript = @"
const fs = require('fs');
const path = '/home/node/.openclaw/openclaw.json';
const raw = fs.readFileSync(path, 'utf8').replace(/^\ufeff/, '');
const cfg = JSON.parse(raw);
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.dmPolicy = 'allowlist';
cfg.channels.telegram.allowFrom = ['$tgId'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('[lock-owner] config patched: allowlist = [$tgId]');
"@

docker compose exec -T openclaw-gateway node -e $nodeScript
if ($LASTEXITCODE -ne 0) {
  Write-Host "[lock-owner] ERROR: config patch failed. Bot was NOT locked." -ForegroundColor Red
  exit 1
}

Write-Host "[lock-owner] Restarting gateway to apply..."
docker compose restart openclaw-gateway | Out-Null

Set-Content -Path (Join-Path $ROOT 'config\.owner_locked') -Value $tgId -NoNewline

Write-Host ""
Write-Host "[lock-owner] Done. Bot now only responds to Telegram user ID: $tgId" -ForegroundColor Green
Write-Host "[lock-owner] To change owner: delete config\.owner_locked and re-run this script."
