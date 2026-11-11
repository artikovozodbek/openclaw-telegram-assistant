@echo off
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\bin\gws-register-account.js" %*
exit /b %ERRORLEVEL%
