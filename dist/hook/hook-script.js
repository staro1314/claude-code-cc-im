#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook script.
 *
 * This script is invoked by Claude Code before each tool execution.
 * It sends a permission request to the cc-im permission server,
 * which notifies the user via the messaging platform and waits for their decision.
 *
 * Environment variables:
 *   CC_IM_CHAT_ID   - Chat ID to send the permission card to
 *   CC_IM_HOOK_PORT - Port of the local permission server (default: 18900)
 *
 * stdin: JSON { session_id, tool_name, tool_input }
 * stdout: JSON { permissionDecision: "allow" | "deny" }
 *
 * Exit codes:
 *   0 - Success (decision written to stdout)
 *   1 - General error (input parsing failed, etc.)
 *   2 - Permission server unreachable (deny decision written to stdout)
 */
import { request } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { READ_ONLY_TOOLS, HOOK_EXIT_CODES } from '../constants.js';

/**
 * 获取 chatId：优先环境变量，fallback 到文件
 * channel 模式下 CC_IM_CHAT_ID 未设置，需要从 bridge 写入的文件读取
 */
function resolveChatId() {
    const envId = process.env.CC_IM_CHAT_ID;
    if (envId) return envId;
    try {
        const chatIdFile = join(homedir(), '.cc-im', 'active-chat-id');
        return readFileSync(chatIdFile, 'utf-8').trim();
    } catch {
        return '';
    }
}

/**
 * 判断是否为推送模式（通过 wecom-mode 标记文件）
 * 启动脚本创建此文件，/wecom off 删除，/wecom on 恢复
 */
function isPushMode() {
    try {
        readFileSync(join(homedir(), '.cc-im', 'wecom-mode'), 'utf-8');
        return true;
    } catch { return false; }
}

/**
 * 检测 Bash 命令中的 wecom-mode 文件操作，自动切换推送模式
 * 用户说"打开企业微信推送"→ Claude 执行 touch 命令 → hook 拦截并创建文件
 * @returns true 表示已处理（放行命令但不走正常流程）
 */
function handleWecomCommand(command) {
    const wecomModePath = join(homedir(), '.cc-im', 'wecom-mode');
    const normalized = command.replace(/\\/g, '/');

    // 检测创建 wecom-mode 的命令（touch、echo >、mkdir + touch 等）
    if (normalized.includes('wecom-mode') && !normalized.includes('rm ') && !normalized.includes('del ')) {
        try {
            mkdirSync(join(homedir(), '.cc-im'), { recursive: true });
            writeFileSync(wecomModePath, String(Date.now()), 'utf-8');
            process.stderr.write('[cc-im] Push mode ON (auto-detected)\n');
        } catch { /* ignore */ }
        return false; // 放行命令，让 Claude 继续执行
    }

    // 检测删除 wecom-mode 的命令
    if (normalized.includes('wecom-mode') && (normalized.includes('rm ') || normalized.includes('del '))) {
        try {
            const { unlinkSync } = require('node:fs');
            unlinkSync(wecomModePath);
            process.stderr.write('[cc-im] Push mode OFF (auto-detected)\n');
        } catch { /* ignore */ }
        return false; // 放行命令
    }

    return false;
}

/**
 * 将当前会话的 transcript_path 写入文件，供 SessionWatcher 定位正确的 session 文件
 */
function writeTranscriptPath(transcriptPath) {
    if (!transcriptPath) return;
    try {
        const dir = join(homedir(), '.cc-im');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'active-transcript'), transcriptPath, 'utf-8');
    } catch { /* ignore */ }
}

function getToolEmoji(name) {
    const map = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '💻', Grep: '🔍', Glob: '📂', WebFetch: '🌐', WebSearch: '🔎', Agent: '🤖', Task: '📋', Skill: '⚡', NotebookEdit: '📓' };
    return map[name] || '🔧';
}
function truncate(s, max) { return s.length > max ? s.slice(0, max) + '...' : s; }
function formatToolDetail(name, input) {
    if (!input) return '';
    switch (name) {
        case 'Read': { const fp = input.file_path ?? ''; const parts = [fp]; if (input.offset) parts.push(`L${input.offset}`); if (input.limit) parts.push(`${input.limit}行`); return fp ? ` → ${parts.join(' ')}` : ''; }
        case 'Edit': { const fp = input.file_path ?? ''; const oc = (String(input.old_string ?? '')).split('\n').length; const nc = (String(input.new_string ?? '')).split('\n').length; return fp ? ` → ${fp} (-${oc}/+${nc} 行)` : ''; }
        case 'Write': { const fp = input.file_path ?? ''; const len = String(input.content ?? '').length; return fp ? ` → ${fp} (${len}字符)` : ''; }
        case 'Bash': return input.command ? ` → ${truncate(String(input.command), 60)}` : '';
        case 'Grep': case 'Glob': return input.pattern ? ` → ${input.pattern}` : '';
        case 'WebFetch': return input.url ? ` → ${truncate(String(input.url), 60)}` : '';
        case 'WebSearch': return input.query ? ` → ${input.query}` : '';
        case 'Agent': return input.prompt ? ` → ${truncate(String(input.prompt), 60)}` : '';
        case 'Task': return input.description ? ` → ${truncate(String(input.description), 40)}` : '';
        default: return '';
    }
}
function notifyToolUse(chatId, toolName, toolInput) {
    const bridgePort = parseInt(process.env.CC_IM_BRIDGE_PORT ?? '18790', 10);
    if (!bridgePort || !chatId) return Promise.resolve();
    const emoji = getToolEmoji(toolName);
    const detail = formatToolDetail(toolName, toolInput);
    const notification = `${emoji} ${toolName}${detail}`;
    const payload = JSON.stringify({ chat_id: chatId, tool_name: toolName, notification });
    return new Promise((resolve) => {
        const req = request({ hostname: '127.0.0.1', port: bridgePort, path: '/tool-event', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 3000 }, () => { resolve(); });
        req.on('error', () => { resolve(); });
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(payload);
        req.end();
    });
}
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        // If stdin is empty/closed immediately
        setTimeout(() => resolve(data), 100);
    });
}
function httpPost(port, path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 6 * 60 * 1000, // 6 minutes (server has 5 min timeout)
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) });
                }
                catch {
                    resolve({ status: res.statusCode ?? 500, data });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(payload);
        req.end();
    });
}
async function main() {
    const chatId = resolveChatId();
    const port = parseInt(process.env.CC_IM_HOOK_PORT ?? '18900', 10);
    // No chat ID configured - deny by default for security
    if (!chatId) {
        process.stderr.write('Warning: CC_IM_CHAT_ID not set, denying by default. Check hook configuration.\n');
        process.stdout.write(JSON.stringify({ permissionDecision: 'deny' }));
        process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    let input;
    try {
        const raw = await readStdin();
        input = raw.trim() ? JSON.parse(raw) : {};
    }
    catch (err) {
        // Cannot parse input - allow by default to avoid blocking legitimate operations
        process.stderr.write(`Warning: Failed to parse hook input, allowing by default: ${err}\n`);
        process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
        process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    const toolName = input.tool_name ?? 'unknown';
    const toolInput = input.tool_input ?? {};
    // 检测 Bash 命令中的 wecom-mode 文件操作，自动切换推送模式
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
        handleWecomCommand(toolInput.command);
    }
    // 推送模式下：写入 transcript_path 并推送通知
    if (isPushMode()) {
        writeTranscriptPath(input.transcript_path);
        await notifyToolUse(chatId, toolName, toolInput);
    }
    // Skip permission check for read-only tools - allow immediately
    if (READ_ONLY_TOOLS.includes(toolName)) {
        process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
        process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    // Skip permissions mode - auto-allow all tools
    // 新版 Claude Code 的 --dangerously-skip-permissions 不再跳过 hooks，
    // 需要通过环境变量让 hook 脚本自行放行
    if (process.env.CC_IM_SKIP_PERMISSIONS === '1') {
        if (isPushMode()) await notifyToolUse(chatId, toolName, toolInput);
        process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
        process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    const threadRootMsgId = process.env.CC_IM_THREAD_ROOT_MSG_ID;
    const threadId = process.env.CC_IM_THREAD_ID;
    const platform = process.env.CC_IM_PLATFORM;
    try {
        const result = await httpPost(port, '/permission-request', {
            chatId,
            toolName,
            toolInput,
            threadRootMsgId,
            threadId,
            platform,
        });
        const data = result.data;
        const decision = data?.decision ?? 'deny';
        // Output the decision as JSON to stdout
        const output = JSON.stringify({ permissionDecision: decision === 'allow' ? 'allow' : 'deny' });
        process.stdout.write(output);
        process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    catch (err) {
        // Permission server is not reachable - deny by default for security
        // Output deny decision to stdout so Claude Code can proceed (rather than hanging)
        const errorMessage = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: Permission server unreachable (port ${port}): ${errorMessage}\n`);
        process.stderr.write('Denying operation by default for security. Please check if cc-im is running.\n');
        // Write deny decision to stdout
        process.stdout.write(JSON.stringify({ permissionDecision: 'deny' }));
        process.exit(HOOK_EXIT_CODES.PERMISSION_SERVER_ERROR);
    }
}
/* c8 ignore next 3 */
const isDirectRun = process.argv[1]?.endsWith('hook-script.js');
if (isDirectRun)
    main();
export { main, readStdin, httpPost };
