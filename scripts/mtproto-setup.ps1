# MTProto setup for Windows - PowerShell peer of mtproto-setup.sh
# Idempotent: if TG_USER_SESSION is already set, just starts the tg-watcher.

$ErrorActionPreference = 'Continue'

# Force UTF-8 console output so the QR code renders correctly
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 | Out-Null
} catch {}

$ROOT = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ROOT

function Log($msg)  { Write-Host "[mtproto] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[mtproto] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[mtproto] $msg" -ForegroundColor Red }

$envPath = Join-Path $ROOT '.env'
if (-not (Test-Path $envPath)) { Err ".env not found. Run START.bat once first."; exit 1 }

function Get-EnvVal($key) {
  $line = Get-Content $envPath | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($line) { return ($line -split '=', 2)[1] } else { return '' }
}

$apiId = Get-EnvVal 'TG_API_ID'
$apiHash = Get-EnvVal 'TG_API_HASH'
$session = Get-EnvVal 'TG_USER_SESSION'

if (-not $apiId -or -not $apiHash) {
  Warn "TG_API_ID and/or TG_API_HASH not set."
  Warn "Get them from https://my.telegram.org/apps (log in with your Telegram phone, create an app)."
  Warn "Edit .env, paste TG_API_ID and TG_API_HASH, then re-run this script."
  exit 0
}

if ($session) {
  Log "MTProto session already configured. Starting tg-watcher..."
  docker compose --profile mtproto up -d --force-recreate tg-watcher
  Log "tg-watcher is running. meeting-scanner / task-scanner / proxy-chat are active."
  exit 0
}

Log "Running MTProto authentication..."
Log "A QR code will appear below - scan it with your Telegram app:"
Log "  Settings -> Devices -> Link Desktop Device -> scan"
Write-Host ""

# auth-mtproto.js prints the session string to stdout. We `tee` to a file on the
# mounted config volume (./config on host = /home/node/.openclaw in container) so
# we can read it after the container exits. QR rendering in the terminal is unaffected.
$sessionFileHost = Join-Path $ROOT 'config\.tg_session.tmp'
Remove-Item $sessionFileHost -ErrorAction SilentlyContinue

docker compose run --rm `
  --entrypoint sh openclaw-cli -c `
  "node /home/node/.openclaw/workspace/skills/meeting-scanner/scripts/auth-mtproto.js | tee /home/node/.openclaw/.tg_session.tmp"

$newSession = ''
if (Test-Path $sessionFileHost) {
  $raw = Get-Content $sessionFileHost -Raw
  $line = ($raw -split "`n") | Where-Object { $_ -match '^TG_USER_SESSION=.+' } | Select-Object -Last 1
  if ($line) { $newSession = ($line -replace '^TG_USER_SESSION=', '').Trim() }
  Remove-Item $sessionFileHost -ErrorAction SilentlyContinue
}

if (-not $newSession) {
  Err "MTProto auth did not produce a session string."
  Err "If the QR expired before you scanned, just re-run: scripts\mtproto-setup.ps1"
  Read-Host "Press Enter to exit"
  exit 1
}

# Replace or append TG_USER_SESSION in .env
$envText = Get-Content $envPath -Raw
if ($envText -match '(?m)^TG_USER_SESSION=') {
  $envText = $envText -replace '(?m)^TG_USER_SESSION=.*', "TG_USER_SESSION=$newSession"
  Set-Content -Path $envPath -Value $envText -Encoding UTF8
} else {
  Add-Content -Path $envPath -Value "`nTG_USER_SESSION=$newSession"
}
Log "TG_USER_SESSION saved to .env"

Log "Starting tg-watcher..."
docker compose --profile mtproto up -d --force-recreate tg-watcher
Log "Done. meeting-scanner / task-scanner / proxy-chat are now active."
