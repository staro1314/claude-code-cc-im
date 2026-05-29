/**
 * WeChat Work Channel Handler
 *
 * In channel mode, instead of spawning `claude -p` for each message,
 * this handler forwards messages to the channel MCP server which pushes
 * them into the active Claude Code session.
 *
 * Falls back to the standard handler if the channel server is not running.
 */
import { createWecomSender, sendTextReply as wecomSendText } from '../wecom/message-sender.js';
import { AccessControl } from '../access/access-control.js';
import { RequestQueue } from '../queue/request-queue.js';
import { CommandHandler } from '../commands/handler.js';
import { registerPermissionSender, registerWatchSender } from '../hook/permission-server.js';
import { runClaudeTask } from '../shared/claude-task.js';
import { startTaskCleanup } from '../shared/task-cleanup.js';
import { MessageDedup } from '../shared/message-dedup.js';
import { WECOM_THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createLogger } from '../logger.js';
import { forwardToChannel, getChannelPort } from './bridge-server.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const log = createLogger('WecomChannel');

function extractInfo(body) {
    const userId = body.from?.userid ?? '';
    const isGroup = body.chattype === 'group';
    const chatId = isGroup ? (body.chatid ?? userId) : userId;
    const text = body.text?.content ?? body.voice?.content ?? '';
    const msgId = body.msgid ?? '';
    return { userId, chatId, isGroup, text, msgId };
}

export function cleanGroupText(text, botName) {
    let cleaned = text;
    if (botName) {
        const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(`@${escaped}\\s*`, 'gi'), '');
    }
    else {
        const slashIdx = cleaned.indexOf('/');
        if (slashIdx >= 0) {
            const cmdPart = cleaned.substring(slashIdx);
            cleaned = cmdPart.replace(/\s*@.*$/s, '');
        }
        else {
            cleaned = cleaned.replace(/^@\S+\s*/, '');
        }
    }
    return cleaned.trim();
}

async function downloadWecomImage(wsClient, url, aesKey) {
    await mkdir(IMAGE_DIR, { recursive: true });
    const { buffer, filename } = await wsClient.downloadFile(url, aesKey);
    const ext = filename?.split('.').pop() ?? 'jpg';
    const safeFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const imagePath = join(IMAGE_DIR, safeFilename);
    await writeFile(imagePath, buffer);
    return imagePath;
}

/**
 * Setup WeChat Work handlers in channel mode.
 * Messages are forwarded to the channel MCP server instead of spawning Claude.
 *
 * @param {object} wsClient - WeChat Work WebSocket client
 * @param {object} config - Configuration
 * @param {object} sessionManager - Session manager
 * @param {object} options - Additional options
 * @param {Function} options.onFallback - Called when channel server is unavailable (fall back to standard handler)
 */
export function setupWecomChannelHandlers(wsClient, config, sessionManager, options) {
    const accessControl = new AccessControl(config.allowedUserIds);
    const dedup = new MessageDedup();
    const sender = createWecomSender(wsClient);
    let accepting = true;

    // Register senders for permission/watch (still needed for hooks)
    registerPermissionSender('wecom', {
        sendPermissionCard: (chatId, requestId, toolName, toolInput) => sender.sendPermissionCard(chatId, requestId, toolName, toolInput),
        updatePermissionCard: (params) => sender.updatePermissionCard(params),
    });
    registerWatchSender('wecom', {
        sendWatchNotify: (chatId, text) => wecomSendText(chatId, text),
    });

    /**
     * Try to forward a message to the channel server.
     * Returns true if forwarded successfully, false if channel unavailable.
     */
    async function tryChannelForward(userId, chatId, text, msgId, isGroup) {
        const channelPort = getChannelPort();
        if (!channelPort) {
            log.debug('Channel server port not found, falling back');
            return false;
        }

        const success = await forwardToChannel(channelPort, {
            content: text,
            chat_id: chatId,
            user_id: userId,
            platform: 'wecom',
            msg_id: msgId,
        });

        if (success) {
            log.info(`Message forwarded to channel: user=${userId}, chat=${chatId}`);
            return true;
        }

        log.warn('Channel forward failed, falling back to standard handler');
        return false;
    }

    async function handleMessage(frame, text, userId, chatId, msgId, isGroup) {
        if (!accepting) return;

        // Dedup
        if (dedup.isDuplicate(`${chatId}:${msgId}`)) {
            log.debug(`Duplicate message ${msgId}, skipping`);
            return;
        }

        // Access control
        if (!accessControl.isAllowed(userId)) {
            log.warn(`Access denied for user ${userId}`);
            await sender.sendTextReply(chatId, '抱歉，您没有访问权限。\n\n请联系管理员将您的用户 ID 添加到白名单。\n您的 ID: ' + userId);
            return;
        }

        setActiveChatId('wecom', chatId);

        let cleanText = text.trim();
        if (isGroup) {
            cleanText = cleanGroupText(cleanText, config.wecomBotName);
        }
        if (!cleanText) return;

        log.debug(`Processing message from user ${userId}: ${cleanText.slice(0, 100)}${cleanText.length > 100 ? '...' : ''}`);

        // /stop command
        if (cleanText === '/stop') {
            await sender.sendTextReply(chatId, '⏹️ Channel 模式下停止功能由 Claude Code 会话管理');
            return;
        }

        // Try channel forward
        const forwarded = await tryChannelForward(userId, chatId, cleanText, msgId, isGroup);
        if (forwarded) {
            // 初始化流式会话（如果有回调），否则发文本确认
            if (options?.onStreamInit && frame) {
                options.onStreamInit(frame);
            } else {
                await sender.sendTextReply(chatId, '📤 已发送到 Claude Code 会话');
            }
            return;
        }

        // Channel unavailable — fall back to standard handler
        if (options?.onFallback) {
            log.info('Channel unavailable, delegating to standard handler');
            await options.onFallback(frame, text, userId, chatId, msgId, isGroup);
        } else {
            await sender.sendTextReply(chatId, '❌ Channel 服务未启动，请先启动 Claude Code with --channels');
        }
    }

    // Text messages
    wsClient.on('message.text', async (frame) => {
        const body = frame.body;
        if (!body) return;
        const { userId, chatId, text, msgId, isGroup } = extractInfo(body);
        await handleMessage(frame, text, userId, chatId, msgId, isGroup);
    });

    // Voice messages
    wsClient.on('message.voice', async (frame) => {
        const body = frame.body;
        if (!body) return;
        const { userId, chatId, msgId, isGroup } = extractInfo(body);
        const text = body.voice?.content ?? '';
        await handleMessage(frame, text, userId, chatId, msgId, isGroup);
    });

    // Image messages
    wsClient.on('message.image', async (frame) => {
        const body = frame.body;
        if (!body) return;
        const { userId, chatId, msgId, isGroup } = extractInfo(body);
        if (!accessControl.isAllowed(userId)) return;
        if (dedup.isDuplicate(`${chatId}:${msgId}`)) return;

        const imageUrl = body.image?.url;
        const aesKey = body.image?.aeskey;
        if (!imageUrl) return;

        let imagePath;
        try {
            imagePath = await downloadWecomImage(wsClient, imageUrl, aesKey);
        } catch (err) {
            log.error('Failed to download image:', err);
            await sender.sendTextReply(chatId, '图片下载失败，请重试。');
            return;
        }

        const prompt = `用户发送了一张图片，已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`;
        const forwarded = await tryChannelForward(userId, chatId, prompt, msgId, isGroup);
        if (forwarded) {
            if (options?.onStreamInit && frame) {
                options.onStreamInit(frame);
            } else {
                await sender.sendTextReply(chatId, '📤 图片已发送到 Claude Code 会话');
            }
        } else if (options?.onFallback) {
            await options.onFallback(frame, prompt, userId, chatId, msgId, isGroup);
        }
    });

    // Mixed messages
    wsClient.on('message.mixed', async (frame) => {
        const body = frame.body;
        if (!body) return;
        const { userId, chatId, msgId, isGroup } = extractInfo(body);
        if (!accessControl.isAllowed(userId)) return;
        if (dedup.isDuplicate(`${chatId}:${msgId}`)) return;

        const msgItems = body.mixed?.msg_item ?? [];
        const textParts = [];
        const imagePaths = [];

        for (const item of msgItems) {
            if (item.msgtype === 'text' && item.text?.content) {
                textParts.push(item.text.content);
            } else if (item.msgtype === 'image' && item.image?.url) {
                try {
                    const path = await downloadWecomImage(wsClient, item.image.url, item.image.aeskey);
                    imagePaths.push(path);
                } catch (err) {
                    log.error('Failed to download mixed image:', err);
                }
            }
        }

        const textContent = isGroup
            ? cleanGroupText(textParts.join(' '), config.wecomBotName)
            : textParts.join(' ').trim();

        let prompt;
        if (imagePaths.length > 0) {
            const imageDesc = imagePaths.map(p => `已保存到 ${p}`).join('，');
            const captionPart = textContent ? `（附言：${textContent}）` : '';
            prompt = `用户发送了 ${imagePaths.length} 张图片${captionPart}，${imageDesc}。请用 Read 工具查看并分析图片内容。`;
        } else {
            prompt = textContent;
        }
        if (!prompt) return;

        const forwarded = await tryChannelForward(userId, chatId, prompt, msgId, isGroup);
        if (forwarded) {
            if (options?.onStreamInit && frame) {
                options.onStreamInit(frame);
            } else {
                await sender.sendTextReply(chatId, '📤 已发送到 Claude Code 会话');
            }
        } else if (options?.onFallback) {
            await options.onFallback(frame, prompt, userId, chatId, msgId, isGroup);
        }
    });

    // Template card events (stop button, permission buttons)
    wsClient.on('event.template_card_event', async (frame) => {
        const body = frame.body;
        if (!body) return;
        const eventKey = body.event?.template_card_event?.event_key ?? '';
        const userId = body.from?.userid ?? '';
        log.info(`Template card event from ${userId}: key=${eventKey}`);

        // Handle stop button — in channel mode, forward to channel
        if (eventKey.startsWith('stop_')) {
            const taskKey = eventKey.replace('stop_', '');
            const forwarded = await tryChannelForward(userId, userId, `/stop`, `stop_${taskKey}`, false);
            if (!forwarded) {
                await sender.sendTextReply(userId, '⏹️ Channel 服务未连接');
            }
        }
        // Permission buttons (allow / allow-all / deny)
        else if (eventKey.startsWith('perm_allow') || eventKey.startsWith('perm_deny_')) {
            const isAllowAll = eventKey.startsWith('perm_allowall_');
            const isAllow = eventKey.startsWith('perm_allow_') || isAllowAll;
            const requestId = eventKey.replace(/^perm_(allowall|allow|deny)_/, '');
            const decision = isAllow ? 'allow' : 'deny';

            // Forward decision to channel server
            const channelPort = getChannelPort();
            if (channelPort) {
                try {
                    await fetch(`http://127.0.0.1:${channelPort}/permission-decision`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ request_id: requestId, decision, allow_all: isAllowAll }),
                    });
                    log.info(`Permission decision forwarded: ${requestId} → ${decision}${isAllowAll ? ' (all)' : ''}`);
                } catch (err) {
                    log.warn(`Failed to forward permission decision: ${err.message}`);
                }
            }

            // Update card
            const label = isAllowAll ? '✅ 已全部允许' : (isAllow ? '✅ 已允许' : '❌ 已拒绝');
            try {
                const taskId = body.event?.template_card_event?.task_id ?? '';
                await wsClient.updateTemplateCard(frame, {
                    card_type: 'button_interaction',
                    main_title: { title: label },
                    sub_title_text: `权限请求${label}`,
                    task_id: taskId,
                    button_list: [
                        { text: '✅ 允许', style: 1, key: `perm_allow_${requestId}`, disabled: true },
                        { text: '✅ 全部允许', style: 1, key: `perm_allowall_${requestId}`, disabled: true },
                        { text: '❌ 拒绝', style: 3, key: `perm_deny_${requestId}`, disabled: true },
                    ],
                });
            } catch (err) {
                log.warn('Failed to update permission card:', err);
            }
        }
    });

    return {
        stop: () => { accepting = false; },
        getRunningTaskCount: () => 0,
    };
}
