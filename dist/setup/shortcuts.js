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
    return join(dirname(dirname(thisFile)));
}

/**
 * 生成 BAT 脚本内容
 */
function batStart(ccImPath) {
    return `@echo off
chcp 65001 >nul
echo Starting CC-IM...
cd /d "${ccImPath}"
node dist/cli.js start
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
