@echo off
setlocal
set "ROOT=%~dp0.."
if exist "%ROOT%\node_modules\.bin\gws.cmd" (
  "%ROOT%\node_modules\.bin\gws.cmd" %*
  exit /b %ERRORLEVEL%
)
if exist "%ROOT%\node_modules\@googleworkspace\cli\run.js" (
  node "%ROOT%\node_modules\@googleworkspace\cli\run.js" %*
  exit /b %ERRORLEVEL%
)
if exist "%ROOT%\vendor\googleworkspace-cli\npm\run.js" (
  node "%ROOT%\vendor\googleworkspace-cli\npm\run.js" %*
  exit /b %ERRORLEVEL%
)
gws %*
exit /b %ERRORLEVEL%
