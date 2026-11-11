# Auto-lock watcher (Windows): runs in background after start-cdp.ps1.
# Watches gateway logs for the first outgoing Telegram reply, grabs that chat ID,
# switches dmPolicy to "allowlist" with just that ID, restarts gateway, exits.
#
# Idempotent: exits immediately if config\.owner_locked exists.

$ErrorActionPreference = 'Continue'
$ROOT = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ROOT

$lockMarker = Join-Path $ROOT 'config\.owner_locked'
$log        = Join-Path $ROOT 'config\.owner_lock.log'

if (Test-Path $lockMarker) { exit 0 }

function AppendLog($msg) {
  try { Add-Content $log "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')] $msg" } catch {}
}
AppendLog "owner-lock-watcher started"

for ($i = 0; $i -lt 1200; $i++) {
  Start-Sleep -Seconds 3
  try {
    $rawLogs = docker compose logs --no-color openclaw-gateway 2>$null
    # Defensive: strip any remaining ANSI color escapes
    if ($rawLogs) { $rawLogs = ($rawLogs -join "`n") -replace "`e\[[0-9;]*m", '' }
    $m = $rawLogs | Select-String -Pattern '\[telegram\]\s+sendMessage\s+ok\s+chat=(\d+)' | Select-Object -First 1
    if ($m) {
      $chatId = $m.Matches[0].Groups[1].Value
      AppendLog "detected first CEO chat=$chatId, locking..."

      $script = @"
const fs = require('fs');
const path = '/home/node/.openclaw/openclaw.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.dmPolicy = 'allowlist';
cfg.channels.telegram.allowFrom = ['$chatId'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('config patched: allowlist = [$chatId]');
"@
      docker compose exec -T openclaw-gateway node -e $script 2>&1 | ForEach-Object { AppendLog $_ }
      docker compose restart openclaw-gateway 2>&1 | ForEach-Object { AppendLog $_ }
      Set-Content -Path $lockMarker -Value $chatId
      AppendLog "locked to $chatId, exiting."
      exit 0
    }
  } catch {
    AppendLog "poll error: $_"
  }
}
AppendLog "timed out after 60 min. Not locked."
exit 0
