import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sanitize } from './sanitize.js';
import { APP_HOME } from './constants.js';
const DEFAULT_LOG_DIR = join(APP_HOME, 'logs');
const MAX_LOG_FILES = 10;
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let logDir = DEFAULT_LOG_DIR;
let minLevel = LOG_LEVELS.DEBUG;
let logStream;
let reopenTimer = null;
function pad(n) {
    return String(n).padStart(2, '0');
}
function getTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function getLogFileName() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}
function rotateOldLogs() {
    try {
        const files = readdirSync(logDir)
            .filter((f) => f.endsWith('.log'))
            .map((f) => ({ name: f, time: statSync(join(logDir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        for (let i = MAX_LOG_FILES; i < files.length; i++) {
            unlinkSync(join(logDir, files[i].name));
        }
    }
    catch {
        // ignore
    }
}
export function initLogger(dir, level) {
    if (dir) {
        logDir = dir;
    }
    if (level) {
        minLevel = LOG_LEVELS[level] ?? LOG_LEVELS.DEBUG;
    }
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    rotateOldLogs();
    logStream = createWriteStream(join(logDir, getLogFileName()), { flags: 'a' });
    // Reopen log file at midnight
    const scheduleReopen = () => {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const ms = tomorrow.getTime() - now.getTime() + 1000;
        reopenTimer = setTimeout(() => {
            const oldStream = logStream;
            rotateOldLogs();
            logStream = createWriteStream(join(logDir, getLogFileName()), { flags: 'a' });
            oldStream.end();
            scheduleReopen();
        }, ms);
        reopenTimer.unref();
    };
    scheduleReopen();
}
function write(level, tag, msg, ...args) {
    if (LOG_LEVELS[level] < minLevel)
        return;
    const extra = args.length > 0
        ? ' ' + args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')
        : '';
    const line = sanitize(`${getTimestamp()} [${level}] [${tag}] ${msg}${extra}\n`);
    if (level === 'ERROR') {
        process.stderr.write(line);
    }
    else {
        process.stdout.write(line);
    }
    logStream?.write(line);
}
export function createLogger(tag) {
    return {
        info: (msg, ...args) => write('INFO', tag, msg, ...args),
        warn: (msg, ...args) => write('WARN', tag, msg, ...args),
        error: (msg, ...args) => write('ERROR', tag, msg, ...args),
        debug: (msg, ...args) => write('DEBUG', tag, msg, ...args),
    };
}
export function closeLogger() {
    if (reopenTimer) {
        clearTimeout(reopenTimer);
        reopenTimer = null;
    }
    logStream?.end();
}
