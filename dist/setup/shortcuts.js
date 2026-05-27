import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { APP_HOME } from '../constants.js';

const isWin = platform() === 'win32';

/**
 * 获取 cc-im 包安装路径
 */
function getCcImPath() {
    const thisFile = fileURLToPath(import.meta.url);
    // dist/setup/shortcuts.js → dist/setup → dist → cc-im/
    return join(dirname(dirname(dirname(thisFile))));
}

/**
 * 生成 BAT 脚本内容
 */
function batStart(ccImPath) {
    return `@echo off
chcp 65001 >nul
echo Starting CC-IM with Monitor...
echo.

:: Start cc-im service (background)
echo [1/3] Starting cc-im service...
start "CC-IM Service" cmd /c "cd /d "${ccImPath}" && node dist/cli.js start"

:: Wait for service to start
timeout /t 3 /nobreak >nul

:: Open cc-im log monitor
echo [2/3] Opening cc-im log monitor...
set "TODAY=%date:~0,4%-%date:~5,2%-%date:~8,2%"
set "LOG_FILE=${join(homedir(), '.cc-im', 'logs')}\\%TODAY%.log"
start "CC-IM Log" cmd /c "title CC-IM Log && color 0A && echo Monitoring: %LOG_FILE% && echo. && powershell -Command "Get-Content -Path '%LOG_FILE%' -Wait -Tail 50""

:: Open Claude Monitor
echo [3/3] Opening Claude Code Monitor...
start "Claude Code Monitor" cmd /c "title Claude Code Monitor && color 0B && node "${join(homedir(), '.cc-im', 'claude-monitor.js')}"

echo.
echo ========================================
echo   All windows opened
echo ========================================
echo.
echo Windows:
echo   1. CC-IM Service      - Main service process
echo   2. CC-IM Log          - Service log monitor
echo   3. Claude Code Monitor - Real-time Claude output
echo.
echo Send message in WeChat Work to test...
echo.
pause
`;
}

function batStop(ccImPath) {
    return `@echo off
chcp 65001 >nul
echo Stopping CC-IM...
cd /d "${ccImPath}"
node dist/cli.js stop
echo.
pause
`;
}

function batRestart(ccImPath) {
    return `@echo off
chcp 65001 >nul
echo Restarting CC-IM...
cd /d "${ccImPath}"
node dist/cli.js stop 2>nul
timeout /t 2 /nobreak >nul
node dist/cli.js start
echo.
pause
`;
}

function batStatus(ccImPath) {
    return `@echo off
chcp 65001 >nul
cd /d "${ccImPath}"
node dist/cli.js status
echo.
pause
`;
}

/**
 * 生成 PS1 脚本内容
 */
function ps1Start(ccImPath) {
    return `$ErrorActionPreference = "Stop"
Write-Host "Starting CC-IM..." -ForegroundColor Cyan
Set-Location "${ccImPath}"
node dist/cli.js start
`;
}

function ps1Stop(ccImPath) {
    return `$ErrorActionPreference = "Stop"
Write-Host "Stopping CC-IM..." -ForegroundColor Cyan
Set-Location "${ccImPath}"
node dist/cli.js stop
`;
}

/**
 * 生成快捷脚本到 ~/.cc-im/
 */
export function generateShortcuts() {
    const ccImPath = getCcImPath();

    if (!existsSync(APP_HOME)) {
        mkdirSync(APP_HOME, { recursive: true });
    }

    const scripts = [
        { name: '启动.bat', content: batStart(ccImPath) },
        { name: '停止.bat', content: batStop(ccImPath) },
        { name: '重启.bat', content: batRestart(ccImPath) },
        { name: '状态.bat', content: batStatus(ccImPath) },
        { name: '启动.ps1', content: ps1Start(ccImPath) },
        { name: '停止.ps1', content: ps1Stop(ccImPath) },
    ];

    let generated = 0;
    for (const script of scripts) {
        const filePath = join(APP_HOME, script.name);
        try {
            writeFileSync(filePath, script.content, 'utf-8');
            generated++;
        } catch { /* skip on error */ }
    }

    return { generated, total: scripts.length, dir: APP_HOME };
}
