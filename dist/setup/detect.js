import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const isWin = platform() === 'win32';

/**
 * 检测 Node.js 版本
 */
export function checkNode() {
    const version = process.version;
    const major = parseInt(version.slice(1), 10);
    if (major >= 20) {
        return { name: 'Node.js', ok: true, message: `${version}` };
    }
    return {
        name: 'Node.js',
        ok: false,
        message: `${version} (需要 >= 20)`,
        fix: '请升级 Node.js: https://nodejs.org/',
    };
}

/**
 * 检测 npm 是否可用
 */
export function checkNpm() {
    try {
        const ver = execSync('npm --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        return { name: 'npm', ok: true, message: `v${ver}` };
    } catch {
        return {
            name: 'npm',
            ok: false,
            message: '未找到',
            fix: '请安装 Node.js (自带 npm): https://nodejs.org/',
        };
    }
}

/**
 * 检测 Claude Code CLI
 */
export function checkClaudeCli() {
    const detected = detectClaudeCliPath();
    if (detected) {
        return { name: 'Claude Code CLI', ok: true, message: detected, path: detected };
    }
    return {
        name: 'Claude Code CLI',
        ok: false,
        message: '未找到',
        fix: '请安装: npm install -g @anthropic-ai/claude-code',
    };
}

/**
 * 检测 cc-im 包自身
 */
export function checkCcIm() {
    try {
        const thisFile = fileURLToPath(import.meta.url);
        // dist/setup/detect.js → dist/setup → dist → cc-im/
        const pkgPath = join(dirname(dirname(dirname(thisFile))), 'package.json');
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            return { name: 'cc-im', ok: true, message: `v${pkg.version}` };
        }
    } catch { /* ignore */ }
    return {
        name: 'cc-im',
        ok: false,
        message: '包文件不完整',
        fix: '请重新安装: npm install -g cc-im',
    };
}

/**
 * 运行所有环境检测
 * @returns {{ allPassed: boolean, results: Array<{name, ok, message, fix?}> }}
 */
export function runChecks() {
    const results = [checkNode(), checkNpm(), checkClaudeCli(), checkCcIm()];
    const allPassed = results.every(r => r.ok);
    return { allPassed, results };
}

/**
 * 自动检测 Claude CLI 路径
 */
export function detectClaudeCliPath() {
    // 1. 尝试 which/where
    try {
        const cmd = isWin ? 'where claude' : 'which claude';
        const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const firstLine = result.split('\n')[0].trim();
        if (firstLine && existsSync(firstLine)) {
            return firstLine;
        }
    } catch { /* ignore */ }

    // 2. 检查 npm 全局前缀
    try {
        const prefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const claudePath = isWin
            ? join(prefix, 'claude.cmd')
            : join(prefix, 'bin', 'claude');
        if (existsSync(claudePath)) {
            return claudePath;
        }
    } catch { /* ignore */ }

    // 3. 常见路径
    const commonPaths = isWin ? [
        join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        join(homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
    ] : [
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        join(homedir(), '.nvm', 'current', 'bin', 'claude'),
    ];

    for (const p of commonPaths) {
        if (existsSync(p)) {
            return p;
        }
    }

    // 4. 检查 .nvm 版本目录
    if (!isWin) {
        try {
            const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
            if (existsSync(nvmDir)) {
                const versions = readdirSync(nvmDir).filter(v => v.startsWith('v')).sort().reverse();
                for (const v of versions) {
                    const p = join(nvmDir, v, 'bin', 'claude');
                    if (existsSync(p)) return p;
                }
            }
        } catch { /* ignore */ }
    }

    return null;
}

/**
 * 自动检测工作目录
 */
export function detectWorkDir() {
    // 优先使用当前目录
    const cwd = process.cwd();
    if (cwd && cwd !== homedir()) {
        return cwd;
    }
    return join(homedir(), 'project');
}
