@echo off
setlocal
cd /d "%~dp0"

set "HAD_ENV=0"
if exist "%~dp0.env" set "HAD_ENV=1"

call :LoadStartupFlags
if /I "%OPENCLAW_SKIP_CDP%"=="1" echo [start] OPENCLAW_SKIP_CDP is enabled; Chrome CDP/profile setup will be skipped.
if /I "%OPENCLAW_SKIP_CDP%"=="true" echo [start] OPENCLAW_SKIP_CDP is enabled; Chrome CDP/profile setup will be skipped.
if /I "%OPENCLAW_SKIP_CDP%"=="yes" echo [start] OPENCLAW_SKIP_CDP is enabled; Chrome CDP/profile setup will be skipped.
if /I "%OPENCLAW_SKIP_CDP%"=="on" echo [start] OPENCLAW_SKIP_CDP is enabled; Chrome CDP/profile setup will be skipped.

call :SetupGoogleWorkspaceAccount
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\start-cdp.ps1"
if errorlevel 1 (
  echo.
  echo [error] Start failed. See messages above.
  pause
  exit /b 1
)

if "%HAD_ENV%"=="0" call :SetupGoogleWorkspaceAccount
pause
exit /b 0

:LoadStartupFlags
if not exist "%~dp0.env" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
  if /I "%%A"=="OPENCLAW_SKIP_CDP" set "OPENCLAW_SKIP_CDP=%%B"
)
exit /b 0

:SetupGoogleWorkspaceAccount
if not exist "%~dp0.env" exit /b 0

set "GWS_ACCOUNT_CONFIGURED="
for %%K in (GOOGLE_WORKSPACE_ACCOUNT_EMAIL OPENCLAW_GWS_ACCOUNT_EMAIL GWS_ACCOUNT_EMAIL GMAIL_ACCOUNT) do (
  findstr /R /C:"^[ ]*%%K[ ]*=[ ]*[^ #]" "%~dp0.env" >nul 2>nul && set "GWS_ACCOUNT_CONFIGURED=1"
)
if not defined GWS_ACCOUNT_CONFIGURED exit /b 0

where node >nul 2>nul
if errorlevel 1 (
  echo [start] Google Workspace account is configured, but Node.js was not found on the host.
  echo [start] Skipping Google Workspace auth; run workspace\bin\gws-register-account.cmd after installing Node.js.
  exit /b 0
)

if exist "%~dp0workspace\bin\gws-register-account.cmd" (
  call "%~dp0workspace\bin\gws-register-account.cmd" --from-env --skip-if-missing --set-default --yes --startup
  if errorlevel 1 echo [start] Google Workspace account setup did not complete. Run workspace\bin\gws-register-account.cmd manually.
)
exit /b 0
