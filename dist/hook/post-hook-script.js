#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook script.
 *
 * Captures tool execution RESULTS and pushes them to the bridge server
 * for real-time display in WeChat Work.
 *
 * stdin: JSON { session_id, tool_name, tool_input, tool_result }
 * stdout: not used (fire-and-forget notification)
 */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function isPushMode() {
    try {
        readFileSync(join(homedir(), '.cc-im', 'wecom-mode'), 'utf-8');
        return true;
    } catch { return false; }
}

function resolveChatId() {
    const envId = process.env.CC_IM_CHAT_ID;
    if (envId) return envId;
    try {
        return readFileSync(join(homedir(), '.cc-im', 'active-chat-id'), 'utf-8').trim();
    } catch { return ''; }
}

function truncate(s, max) { return s.length > max ? s.slice(0, max) + '...' : s; }

function formatResult(toolName, result) {
    if (!result) return '';
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (!text.trim()) return '';
    switch (toolName) {
        case 'Bash': {
            const preview = truncate(text.trim(), 600);
            return `\n\`\`\`\n${preview}\n\`\`\``;
        }
        case 'Read': {
            const preview = truncate(text.trim(), 600);
            return `\n\`\`\`\n${preview}\n\`\`\``;
        }
        case 'Grep': case 'Glob': {
            const preview = truncate(text.trim(), 400);
            return `\n${preview}`;
        }
        case 'Edit': case 'Write': {
            const preview = truncate(text.replace(/\n+/g, ' ').trim(), 200);
            return preview ? ` → ${preview}` : '';
        }
        default: {
            const preview = truncate(text.replace(/\n+/g, ' ').trim(), 300);
            return preview ? ` → ${preview}` : '';
        }
    }
}

function notifyToolResult(chatId, toolName, result) {
    const bridgePort = parseInt(process.env.CC_IM_BRIDGE_PORT ?? '18790', 10);
    if (!bridgePort || !chatId) return Promise.resolve();
    const detail = formatResult(toolName, result);
    const notification = `✅ ${toolName} 完成${detail}`;
    const payload = JSON.stringify({ chat_id: chatId, tool_name: toolName, notification });
    return new Promise((resolve) => {
        const req = request({
            hostname: '127.0.0.1', port: bridgePort, path: '/tool-event', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 3000,
        }, () => { resolve(); });
        req.on('error', () => { resolve(); });
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(payload);
        req.end();
    });
}

async function main() {
    if (!isPushMode()) return;
    const chatId = resolveChatId();
    if (!chatId) return;

    let input;
    try {
        const raw = await new Promise(resolve => {
            let data = '';
            process.stdin.setEncoding('utf-8');
            process.stdin.on('data', c => { data += c; });
            process.stdin.on('end', () => resolve(data));
            setTimeout(() => resolve(data), 100);
        });
        input = raw.trim() ? JSON.parse(raw) : {};
    } catch { return; }

    const toolName = input.tool_name ?? 'unknown';
    const result = input.tool_response;
    await notifyToolResult(chatId, toolName, result);
}

const isDirectRun = process.argv[1]?.endsWith('post-hook-script.js');
if (isDirectRun) main().catch(() => process.exit(0));
export { main };
