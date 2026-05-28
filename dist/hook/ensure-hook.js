import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { createLogger } from '../logger.js';
const log = createLogger('Hook');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOK_MATCHER = '';
const WATCH_EVENTS = ['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];
/**
 * 获取 hook-script.js 的绝对路径。
 * 无论从 src/ 还是 dist/ 运行，始终返回 dist/hook/hook-script.js
 */
function getHookScriptPath() {
    const thisFile = fileURLToPath(import.meta.url);
    // thisFile = <project>/(dist|src)/hook/ensure-hook.(js|ts)
    const projectRoot = dirname(dirname(dirname(thisFile)));
    return join(projectRoot, 'dist', 'hook', 'hook-script.js');
}
/**
 * 获取 post-hook-script.js 的绝对路径。
 */
function getPostHookScriptPath() {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = dirname(dirname(dirname(thisFile)));
    return join(projectRoot, 'dist', 'hook', 'post-hook-script.js');
}
/**
 * 获取 watch-script.js 的绝对路径。
 */
function getWatchScriptPath() {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = dirname(dirname(dirname(thisFile)));
    return join(projectRoot, 'dist', 'hook', 'watch-script.js');
}
/** 判断一个 hook command 是否指向本项目的 hook-script.js */
function isOurHook(command, projectHookPath) {
    if (!command)
        return false;
    // 精确匹配，或者同项目下的 src/ 版本（dev 模式残留）
    if (command === projectHookPath)
        return true;
    const srcVariant = projectHookPath.replace('/dist/hook/', '/src/hook/');
    if (command === srcVariant)
        return true;
    // Windows: command may have "node " prefix
    const nodePrefix = `node "${projectHookPath}"`;
    if (command === nodePrefix)
        return true;
    const nodePrefixSrc = `node "${srcVariant}"`;
    return command === nodePrefixSrc;
}
/**
 * 确保 Claude CLI 的 PreToolUse hook 已配置。
 * 如果 ~/.claude/settings.json 中缺少对应 hook，自动写入。
 * 如果存在指向 src/ 的旧条目，自动修正为 dist/。
 */
export function ensureHookConfigured() {
    const hookScriptPath = getHookScriptPath();
    if (!existsSync(hookScriptPath)) {
        log.warn(`Hook script not found at ${hookScriptPath}, run "pnpm build" first`);
        return false;
    }
    let settings;
    try {
        settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    }
    catch {
        settings = {};
    }
    const hooks = (settings.hooks ?? {});
    const preToolUse = (hooks.PreToolUse ?? []);
    const isWin = platform() === 'win32';
    const correctCmd = isWin ? `node "${hookScriptPath}"` : hookScriptPath;
    // Remove ALL existing entries that match our hook (deduplicate)
    let needsWrite = false;
    let foundCorrect = false;
    const filtered = [];
    for (const entry of preToolUse) {
        const hasOurHook = entry.hooks?.some(h => isOurHook(h.command, hookScriptPath));
        if (hasOurHook) {
            // Check if this entry already has the correct command
            const alreadyCorrect = entry.hooks?.some(h => h.command === correctCmd);
            if (alreadyCorrect && !foundCorrect) {
                foundCorrect = true;
                // Update matcher if it doesn't match (e.g. old "Bash|Write|Edit" → "")
                if (entry.matcher !== HOOK_MATCHER) {
                    log.info(`Fixing hook matcher: ${JSON.stringify(entry.matcher)} → ${JSON.stringify(HOOK_MATCHER)}`);
                    entry.matcher = HOOK_MATCHER;
                    needsWrite = true;
                }
                filtered.push(entry);
            }
            else if (!alreadyCorrect) {
                // Fix the command in this entry
                entry.hooks = entry.hooks.map(h => {
                    if (isOurHook(h.command, hookScriptPath) && h.command !== correctCmd) {
                        log.info(`Fixing hook command: ${h.command} → ${correctCmd}`);
                        needsWrite = true;
                        return { ...h, command: correctCmd };
                    }
                    return h;
                });
                if (!foundCorrect) {
                    foundCorrect = true;
                    filtered.push(entry);
                }
                // else: skip duplicate
            }
            // else: duplicate with correct cmd, skip
        }
        else {
            filtered.push(entry);
        }
    }
    if (!foundCorrect) {
        filtered.push({
            matcher: HOOK_MATCHER,
            hooks: [{ type: 'command', command: correctCmd }],
        });
        needsWrite = true;
    }
    if (filtered.length !== preToolUse.length) needsWrite = true;
    hooks.PreToolUse = filtered;
    // Watch hook 注册（PostToolUse, Stop, SubagentStart, SubagentStop）
    const watchScriptPath = getWatchScriptPath();
    const watchCmd = isWin ? `node "${watchScriptPath}"` : watchScriptPath;
    if (existsSync(watchScriptPath)) {
        for (const eventName of WATCH_EVENTS) {
            const eventHooks = (hooks[eventName] ?? []);
            // Deduplicate: keep only one correct entry, fix others
            let watchFoundCorrect = false;
            const watchFiltered = [];
            for (const entry of eventHooks) {
                const hasOurHook = entry.hooks?.some(h => isOurHook(h.command, watchScriptPath));
                if (hasOurHook) {
                    const alreadyCorrect = entry.hooks?.some(h => h.command === watchCmd);
                    if (alreadyCorrect && !watchFoundCorrect) {
                        watchFoundCorrect = true;
                        watchFiltered.push(entry);
                    }
                    else if (!alreadyCorrect) {
                        entry.hooks = entry.hooks.map(h => {
                            if (isOurHook(h.command, watchScriptPath) && h.command !== watchCmd) {
                                log.info(`Fixing watch hook: ${h.command} → ${watchCmd}`);
                                return { ...h, command: watchCmd };
                            }
                            return h;
                        });
                        if (!watchFoundCorrect) {
                            watchFoundCorrect = true;
                            watchFiltered.push(entry);
                        }
                    }
                }
                else {
                    watchFiltered.push(entry);
                }
            }
            if (!watchFoundCorrect) {
                watchFiltered.push({
                    matcher: '',
                    hooks: [{ type: 'command', command: watchCmd }],
                });
                needsWrite = true;
            }
            if (watchFiltered.length !== eventHooks.length) needsWrite = true;
            hooks[eventName] = watchFiltered;
        }
    }

    // PostToolUse hook 注册（工具执行结果推送）
    const postHookScriptPath = getPostHookScriptPath();
    if (existsSync(postHookScriptPath)) {
        const postHookCmd = isWin ? `node "${postHookScriptPath}"` : postHookScriptPath;
        const postToolUse = hooks.PostToolUse ?? [];
        let postFoundCorrect = false;
        const postFiltered = [];
        for (const entry of postToolUse) {
            const hasOurHook = entry.hooks?.some(h => isOurHook(h.command, postHookScriptPath));
            if (hasOurHook) {
                const alreadyCorrect = entry.hooks?.some(h => h.command === postHookCmd);
                if (alreadyCorrect && !postFoundCorrect) {
                    postFoundCorrect = true;
                    postFiltered.push(entry);
                }
                else if (!alreadyCorrect) {
                    entry.hooks = entry.hooks.map(h => {
                        if (isOurHook(h.command, postHookScriptPath) && h.command !== postHookCmd) {
                            log.info(`Fixing post-hook command: ${h.command} → ${postHookCmd}`);
                            return { ...h, command: postHookCmd };
                        }
                        return h;
                    });
                    if (!postFoundCorrect) {
                        postFoundCorrect = true;
                        postFiltered.push(entry);
                    }
                }
            }
            else {
                postFiltered.push(entry);
            }
        }
        if (!postFoundCorrect) {
            postFiltered.push({
                matcher: '',
                hooks: [{ type: 'command', command: postHookCmd }],
            });
            needsWrite = true;
        }
        if (postFiltered.length !== postToolUse.length) needsWrite = true;
        hooks.PostToolUse = postFiltered;
    }

    settings.hooks = hooks;
    try {
        mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
        writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        log.info(`PreToolUse hook auto-configured → ${hookScriptPath}`);
        return true;
    }
    catch (err) {
        log.error(`Failed to write hook config to ${CLAUDE_SETTINGS_PATH}:`, err);
        return false;
    }
}
