param(
  [string]$Container = "workshop-openclaw-gateway-1",
  [string]$Name = "topic-intelligence-daily",
  [string]$GroupId = "-1001234567890",
  [string]$Cron = "30 9 * * *",
  [string]$TimeZone = "Asia/Tashkent"
)

$ErrorActionPreference = "Stop"

$listJson = docker exec $Container sh -lc "node /app/dist/index.js cron list --json" | Out-String
$jobs = ($listJson | ConvertFrom-Json).jobs
$existing = $jobs | Where-Object { $_.name -eq $Name } | Select-Object -First 1

if ($existing) {
  Write-Output "Cron job already exists: $($existing.id)"
  exit 0
}

$message = "Read /home/node/.openclaw/workspace/docs/topic-intelligence/daily-audit-prompt.md and execute the audit. Keep external plugin installs as recommendations only."

docker exec $Container sh -lc "node /app/dist/index.js cron add --name '$Name' --description 'Daily Telegram topic skill audit' --agent main --session isolated --session-key agent:main:cron:topic-intelligence-daily --cron '$Cron' --tz '$TimeZone' --message '$message' --announce --channel telegram --to '$GroupId' --best-effort-deliver --expect-final --timeout 60000 --json"
