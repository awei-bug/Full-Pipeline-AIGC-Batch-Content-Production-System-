@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [INFO] Starting content stack (api-server + ai-orchestrator + studio-web)...
echo.

where npm.cmd >nul 2>&1 || goto no_npm

if not exist "node_modules" (
  echo [SETUP] Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 goto failed
)

call npm.cmd run local:start
if errorlevel 1 goto failed

set "STUDIO_URL="
if exist ".local-stack\state.json" (
  for /f "usebackq delims=" %%U in (`powershell.exe -NoProfile -Command "$s = Get-Content -Raw '.local-stack\state.json' ^| ConvertFrom-Json; $s.urls.studio"`) do set "STUDIO_URL=%%U"
)
if not defined STUDIO_URL goto no_state

start "" "!STUDIO_URL!"
echo.
echo [OK] Content studio is running at !STUDIO_URL!
echo [OK] Stop it with: npm run local:stop
echo.
pause
exit /b 0

:no_state
echo.
echo [ERROR] Services were started but .local-stack\state.json was not written.
echo         At least one service failed its health check.
goto show_logs

:failed
echo.
echo [ERROR] Startup command returned a non-zero exit code.
goto show_logs

:show_logs
echo.
echo --- recent service logs ---
call :tail ".local-stack\ai-orchestrator.err.log"
call :tail ".local-stack\api-server.err.log"
call :tail ".local-stack\studio-web.err.log"
echo.
echo Full logs are in: .local-stack\
echo.
pause
exit /b 1

:tail
if not exist "%~1" exit /b 0
echo.
echo === %~1 ===
powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%~1' -Tail 12"
exit /b 0

:no_npm
echo [ERROR] npm was not found. Install Node.js and add it to PATH.
pause
exit /b 1
