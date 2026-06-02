@echo off
chcp 65001 >/dev/null

:: 设置路径（请根据实际情况修改）
set CC_IM_PATH=%~dp0
set PROJECT_DIR=%~dp0..

:: Clean old channel registry to prevent stale client receiving messages
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item '$env:USERPROFILE\.cc-im\channel-registry.json' -ErrorAction SilentlyContinue; Remove-Item '$env:USERPROFILE\.cc-im\channel-port' -ErrorAction SilentlyContinue; Remove-Item '$env:USERPROFILE\.cc-im\bridge-port' -ErrorAction SilentlyContinue"
timeout /t 1 /nobreak >/dev/null

echo Starting CC-IM in channel mode...
start "CC-IM" cmd /c "cd /d "%CC_IM_PATH%" && node dist/cli.js channel"
timeout /t 3 /nobreak >/dev/null
start "Claude Code" cmd /c "cd /d "%PROJECT_DIR%" && claude --dangerously-load-development-channels server:wechat-work"

echo CC-IM started in channel mode.
echo.
pause
