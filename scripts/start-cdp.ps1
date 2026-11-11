# OpenClaw + Chrome CDP - Windows PowerShell launcher
# Resilient: continues on non-critical errors.

$ErrorActionPreference = 'Continue'

# Force UTF-8 console output so any Unicode (including QR codes) renders correctly
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 | Out-Null
} catch {}

$ROOT = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ROOT

$CDP_PORT         = 9222
$CDP_PROXY_PORT   = 19222
$CDP_WAIT_SECONDS = 60
$CDP_DATA         = Join-Path $env:USERPROFILE '.openclaw\chrome-cdp-data'
$CHROME_DIR       = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$PROFILE_SAVE     = Join-Path $env:USERPROFILE '.openclaw\.cdp-profile'
$OPENCLAW_CONFIG  = Join-Path $ROOT 'config\openclaw.json'
$SKILL_FILE       = Join-Path $ROOT 'workspace\.agents\skills\browser-use\SKILL.md'
$envPath          = Join-Path $ROOT '.env'

$CHROME_CANDIDATES = @(
  (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$CHROME_APP = $null
foreach ($c in $CHROME_CANDIDATES) { if (Test-Path $c) { $CHROME_APP = $c; break } }

function Log($msg)  { Write-Host "[cdp] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[cdp] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[cdp] $msg" -ForegroundColor Red }

function Get-DotEnvValue($key) {
  $processValue = [Environment]::GetEnvironmentVariable($key, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue.Trim() }
  if (-not (Test-Path $envPath)) { return $null }

  $pattern = "^\s*$([regex]::Escape($key))\s*=\s*(.*)$"
  foreach ($line in Get-Content $envPath) {
    $match = [regex]::Match($line, $pattern)
    if (-not $match.Success) { continue }
    $value = $match.Groups[1].Value.Trim()
    $value = [regex]::Replace($value, '\s+#.*$', '').Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2).Trim()
    }
    return $value
  }
  return $null
}

function Test-TruthyValue($value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  return @('1','true','yes','on') -contains $value.Trim().ToLowerInvariant()
}

function Test-SkipCdp {
  return (Test-TruthyValue (Get-DotEnvValue 'OPENCLAW_SKIP_CDP'))
}

# Try both 127.0.0.1 and localhost (some systems only resolve one)
function Get-CdpVersion {
  foreach ($cdpHost in @('127.0.0.1','localhost')) {
    try { return Invoke-RestMethod "http://${cdpHost}:$CDP_PORT/json/version" -TimeoutSec 2 } catch {}
  }
  return $null
}
function Test-CdpRunning { return ($null -ne (Get-CdpVersion)) }

function Test-DockerCdpProxy {
  try {
    $cmd = "fetch('http://127.0.0.1:$CDP_PROXY_PORT/json/version').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    docker compose exec -T openclaw-gateway node -e $cmd 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

# Port conflict detection
function Test-PortInUse($port) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start(); $listener.Stop(); return $false
  } catch { return $true }
}

# --- First run: create .env from template ---
if (-not (Test-Path $envPath) -and (Test-Path (Join-Path $ROOT '.env.example'))) {
  Copy-Item (Join-Path $ROOT '.env.example') $envPath
  Log "Created .env from .env.example"
  Log "Open .env and paste your TELEGRAM_BOT_TOKEN, then re-run START.bat"
  Read-Host "Press Enter to exit"
  exit 0
}

# --- Auto-generate gateway token ---
$envText = Get-Content $envPath -Raw
if ($envText -notmatch '(?m)^OPENCLAW_GATEWAY_TOKEN=') {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  Add-Content -Path $envPath -Value "`nOPENCLAW_GATEWAY_TOKEN=$token"
  Log "Generated OPENCLAW_GATEWAY_TOKEN (saved to .env)"
}

# --- Setup (pull image, start gateway) ---
Log "Pulling OpenClaw image (first run downloads ~500MB)..."
docker pull ghcr.io/openclaw/openclaw:latest 2>&1 | ForEach-Object { Write-Host "  $_" }

Log "Starting gateway..."
docker compose up -d openclaw-gateway cdp-proxy 2>&1 | ForEach-Object { Write-Host "  $_" }
Start-Sleep -Seconds 8

Log "Ensuring browser-use CLI is installed (one-time)..."
docker compose exec --user root openclaw-gateway sh -c 'command -v python3 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq python3-pip python3-venv)' 2>&1 | Out-Null
docker compose exec openclaw-gateway sh -c '
  if [ ! -x /home/node/.openclaw/browser-use-env/bin/browser-use ]; then
    python3 -m venv /home/node/.openclaw/browser-use-env
    . /home/node/.openclaw/browser-use-env/bin/activate
    pip install "browser-use @ git+https://github.com/browser-use/browser-use.git@main" 2>&1 | tail -3
  fi
' 2>&1 | Out-Null

Log "Installing workspace npm deps..."
docker compose exec openclaw-gateway sh -c 'cd /home/node/.openclaw/workspace && [ -d node_modules ] || npm install --omit=dev --silent' 2>&1 | Out-Null

# --- Chrome profile selection ---
function Select-ChromeProfile {
  if (Test-Path $PROFILE_SAVE) {
    $saved = (Get-Content $PROFILE_SAVE).Trim()
    if (Test-Path (Join-Path $CHROME_DIR $saved)) {
      Log "Using saved profile: $saved"
      return $saved
    }
  }
  $localState = Join-Path $CHROME_DIR 'Local State'
  $profiles = @(); $labels = @()
  if (Test-Path $localState) {
    try {
      $state = Get-Content $localState -Raw | ConvertFrom-Json
      foreach ($prop in $state.profile.info_cache.PSObject.Properties) {
        $folder = $prop.Name
        if (Test-Path (Join-Path $CHROME_DIR $folder)) {
          $name = $prop.Value.name
          $email = $prop.Value.user_name
          $label = if ($email) { "$name ($email)" } else { $name }
          $profiles += $folder; $labels += $label
        }
      }
    } catch { Warn "Could not parse Chrome Local State: $_" }
  }
  if ($profiles.Count -eq 0) { Warn "No Chrome profiles found. Using 'Default'."; return 'Default' }
  if ($profiles.Count -eq 1) {
    Log "Only one profile found: $($labels[0])"
    $chosen = $profiles[0]
  } else {
    Write-Host ""; Log "Select Chrome profile:"; Write-Host ""
    for ($i = 0; $i -lt $profiles.Count; $i++) { Write-Host "  $($i+1). $($labels[$i])" }
    Write-Host ""
    $choice = Read-Host "  Enter number [1-$($profiles.Count)]"
    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $profiles.Count) { Err "Invalid choice"; exit 1 }
    $chosen = $profiles[$idx]
    Log "Selected: $($labels[$idx]) ($chosen)"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $PROFILE_SAVE) | Out-Null
  Set-Content -Path $PROFILE_SAVE -Value $chosen
  return $chosen
}

function Setup-ChromeProfile {
  $cdpDefault = Join-Path $CDP_DATA 'Default'
  if ((Test-Path $cdpDefault) -and (Test-Path (Join-Path $cdpDefault 'Cookies'))) {
    Log "CDP profile dir exists. Reusing."; return
  }
  $profileName = Select-ChromeProfile
  Log "Copying Chrome profile '$profileName' (cookies, logins, storage)..."
  New-Item -ItemType Directory -Force -Path $CDP_DATA | Out-Null
  $src = Join-Path $CHROME_DIR $profileName
  if (Test-Path $src) {
    $excludeDirs  = @('Cache','Code Cache','Service Worker','GPUCache','DawnGraphiteCache','DawnWebGPUCache','ShaderCache','GrShaderCache')
    $excludeFiles = @('*.log','SingletonLock','SingletonSocket','SingletonCookie','LOCK')
    $roboArgs = @($src, $cdpDefault, '/E','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XD') + $excludeDirs + @('/XF') + $excludeFiles
    & robocopy @roboArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ge 8) { Warn "robocopy exit $LASTEXITCODE - profile copy may be incomplete." }
    $localState = Join-Path $CHROME_DIR 'Local State'
    if (Test-Path $localState) { Copy-Item $localState (Join-Path $CDP_DATA 'Local State') -Force }
    Log "Profile copied. Logins and cookies preserved."
  } else {
    Warn "Profile '$profileName' not found. A fresh profile will be created."
  }
}

function Launch-Chrome {
  if (Test-CdpRunning) { Log "Chrome CDP already running on port $CDP_PORT. Reusing."; return }

  # Check for port conflict (only if port is in use but CDP isn't responding)
  if (Test-PortInUse $CDP_PORT) {
    Warn "Port $CDP_PORT is already in use by another process (not Chrome CDP)."
    Warn "Close that process or change CDP_PORT in this script, then re-run."
    Read-Host "Press Enter to exit"; exit 1
  }

  if (-not $CHROME_APP) {
    Err "Chrome not found. Install Google Chrome from https://www.google.com/chrome/"
    Read-Host "Press Enter to exit"; exit 1
  }
  $chromeRunning = Get-Process chrome -ErrorAction SilentlyContinue
  if ($chromeRunning) {
    Warn "Chrome is already running without CDP. Launching a separate CDP Chrome profile instead of requiring all Chrome windows to be closed."
  }
  Log "Launching Chrome with remote debugging on port $CDP_PORT..."
  Start-Process -FilePath $CHROME_APP -ArgumentList @(
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=$CDP_PORT",
    '--remote-allow-origins=*',
    "--user-data-dir=$CDP_DATA",
    "--profile-directory=Default",
    "--no-first-run",
    "about:blank"
  )
  Log "Waiting for CDP (up to $CDP_WAIT_SECONDS seconds)..."
  for ($i = 1; $i -le $CDP_WAIT_SECONDS; $i++) {
    if (Test-CdpRunning) { Log "Chrome CDP ready."; return }
    Start-Sleep -Seconds 1
  }
  Err "Chrome CDP did not start within $CDP_WAIT_SECONDS seconds."
  Err "Manual check: open http://127.0.0.1:$CDP_PORT/json/version in your browser - should return JSON."
  Err "If that works, re-run START.bat (Chrome is ready but we missed it)."
  Read-Host "Press Enter to exit"; exit 1
}

function Wait-DockerCdpProxy {
  Log "Checking Docker CDP proxy..."
  for ($i = 1; $i -le 20; $i++) {
    if (Test-DockerCdpProxy) {
      Log "Docker CDP proxy ready."
      return $true
    }
    Start-Sleep -Seconds 1
  }
  Err "Chrome CDP is reachable on the host, but Docker cannot reach it through cdp-proxy."
  Err "Check that Chrome was launched with remote debugging and that cdp-proxy is running."
  return $false
}

function Get-WsUrl {
  $v = Get-CdpVersion
  if (-not $v) { Err "Could not fetch WebSocket URL from Chrome CDP"; return $null }
  $url = $v.webSocketDebuggerUrl
  $url = $url -replace "ws://localhost:$CDP_PORT", "ws://127.0.0.1:$CDP_PROXY_PORT"
  $url = $url -replace "ws://127\.0\.0\.1:$CDP_PORT", "ws://127.0.0.1:$CDP_PROXY_PORT"
  return $url
}

function Update-OpenclawConfig($wsUrl) {
  if (-not $wsUrl) { Warn "Skipping config patch (no WS URL)"; return }
  Log "Updating OpenClaw config..."
  try {
    $cfg = Get-Content $OPENCLAW_CONFIG -Raw | ConvertFrom-Json
    $cfg.browser.profiles.'chrome-cdp'.cdpUrl = $wsUrl
    $cfg.browser.profiles.'openclaw'.cdpUrl = $wsUrl
    $cfg.browser.profiles.'user'.cdpUrl = $wsUrl
    $cfg.browser.remoteCdpTimeoutMs = 10000
    $cfg.browser.remoteCdpHandshakeTimeoutMs = 15000
    $cfg | ConvertTo-Json -Depth 50 | Set-Content -Path $OPENCLAW_CONFIG -Encoding UTF8
    Log "Config updated."
  } catch { Err "Failed to update config: $_" }
}

function Update-Skill($wsUrl) {
  if (-not $wsUrl) { return }
  if (-not (Test-Path $SKILL_FILE)) { Warn "browser-use skill not found, skipping."; return }
  Log "Updating browser-use skill..."
  try {
    $content = Get-Content $SKILL_FILE -Raw
    $content = [regex]::Replace($content, '(?s)\r?\n## Default CDP Configuration\r?\n.*?(?=\r?\n## |$)', '')
    # Build the block via string concatenation with single-quoted parts so PS
    # does NOT interpret <command> as a redirection operator.
    $fence = '```'
    $block = "`n`n## Default CDP Configuration`n`n"
    $block += 'IMPORTANT: Always use the following flag to connect to the user existing Chrome browser:' + "`n"
    $block += $fence + "`n"
    $block += 'browser-use --cdp-url ' + $wsUrl + ' ' + '<command>' + "`n"
    $block += $fence + "`n`n"
    $block += 'This connects to the user real Chrome with all their existing logins and sessions.' + "`n"
    Set-Content -Path $SKILL_FILE -Value ($content.TrimEnd() + $block) -Encoding UTF8
    Log "Skill updated."
  } catch { Warn "Skill update failed: $_" }
}

function Restart-Gateway {
  Log "Restarting OpenClaw gateway..."
  docker compose restart openclaw-gateway 2>&1 | Out-Null
  docker compose up -d --force-recreate openclaw-cli cdp-proxy 2>&1 | Out-Null
  Start-Sleep -Seconds 5
  for ($i = 1; $i -le 5; $i++) {
    try { Invoke-RestMethod 'http://127.0.0.1:18789/healthz' -TimeoutSec 5 | Out-Null; Log "Gateway healthy."; return } catch { Start-Sleep -Seconds 3 }
  }
  Warn "Gateway health check timed out."
}

# --- Main ---
$skipCdp = Test-SkipCdp
$wsUrl = $null
Write-Host ""
if ($skipCdp) {
  Log "OpenClaw setup (Chrome CDP skipped)"
} else {
  Log "OpenClaw + Chrome CDP setup"
}
Write-Host ""

if ($skipCdp) {
  Log "OPENCLAW_SKIP_CDP is enabled; skipping Chrome profile selection and CDP launch."
} else {
  Setup-ChromeProfile
  Launch-Chrome
  Wait-DockerCdpProxy | Out-Null
  $wsUrl = Get-WsUrl
  if ($wsUrl) { Log "WebSocket URL: $wsUrl" }
  Update-OpenclawConfig $wsUrl
  Update-Skill $wsUrl
  Restart-Gateway
  Wait-DockerCdpProxy | Out-Null
}

# --- MTProto setup (if API creds present but no session yet) ---
$envText = Get-Content $envPath -Raw
$hasApi = ($envText -match '(?m)^TG_API_ID=.+') -and ($envText -match '(?m)^TG_API_HASH=.+')
$hasSession = $envText -match '(?m)^TG_USER_SESSION=.+'
if ($hasApi -and -not $hasSession) {
  Log "MTProto app credentials detected, session missing - launching setup..."
  & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $PSScriptRoot 'mtproto-setup.ps1')
} elseif ($hasSession) {
  Log "Starting tg-watcher daemon..."
  docker compose --profile mtproto up -d --force-recreate tg-watcher 2>&1 | Out-Null
}

# --- Owner lock: prompt for the Telegram ID that should own the bot ---
# If blank/invalid, fall back to the background watcher (locks to first DM).
$lockMarker = Join-Path $ROOT 'config\.owner_locked'
if (-not (Test-Path $lockMarker)) {
  Write-Host ""
  Write-Host "==============================================="
  Write-Host " Restrict Telegram bot to a single user"
  Write-Host "==============================================="
  Write-Host "DM @userinfobot on Telegram to get your numeric ID."
  Write-Host "Leave blank to auto-lock to the first user who DMs the bot."
  Write-Host ""
  $tgId = ''
  try { $tgId = (Read-Host "Your Telegram user ID").Trim() } catch {}
  if ($tgId -match '^\d+$') {
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
console.log('[start] Bot locked to Telegram ID $tgId');
"@
    docker compose exec -T openclaw-gateway node -e $nodeScript
    if ($LASTEXITCODE -eq 0) {
      docker compose restart openclaw-gateway | Out-Null
      Set-Content -Path $lockMarker -Value $tgId -NoNewline
      Log "Telegram bot is now restricted to user ID: $tgId"
    } else {
      Err "Config patch failed. Bot was NOT locked. Run scripts\lock-owner.bat to retry."
    }
  } else {
    if ($tgId) { Warn "'$tgId' is not a valid numeric ID. Falling back to auto-lock watcher." }
    Start-Process powershell -ArgumentList @(
      '-ExecutionPolicy','Bypass','-NoProfile','-WindowStyle','Hidden',
      '-File', (Join-Path $PSScriptRoot 'owner-lock-watcher.ps1')
    ) -WorkingDirectory $ROOT -WindowStyle Hidden | Out-Null
    Log "Owner auto-lock watcher is active - first person to DM the bot locks it."
  }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
if ($skipCdp) {
  Write-Host "  OpenClaw ready! Chrome CDP skipped."  -ForegroundColor Green
} else {
  Write-Host "  OpenClaw + Chrome CDP ready!"         -ForegroundColor Green
}
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
if (-not $skipCdp) {
  Write-Host "  Chrome CDP:  http://127.0.0.1:$CDP_PORT"
  if ($wsUrl) { Write-Host "  Docker CDP:  $wsUrl" }
}
Write-Host "  Gateway:     http://127.0.0.1:18789"
if ($skipCdp) { Write-Host "  Browser CDP: skipped by OPENCLAW_SKIP_CDP" }
Write-Host ""
Write-Host "  Now message your Telegram bot from your phone."
Write-Host ""
