import { getWSClient } from './client.js';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { createLogger } from '../logger.js';
import { splitLongContent, buildInputSummary } from '../shared/utils.js';
import { MAX_WECOM_MESSAGE_LENGTH, WECOM_STREAM_TIMEOUT_MS } from '../constants.js';
const log = createLogger('WecomSender');
/**
 * 创建企业微信消息发送器
 */
export function createWecomSender(wsClient) {
    let session = null;
    // 忙碌锁：防止并发 replyStream 调用导致 SDK 排队/丢弃/阻塞
    let streamBusy = false;
    let pendingStreamUpdate = null;
    /**
     * 如果流式消息接近超时（330s），结束当前流并开始新流。
     * 旧流结束时保留到截断点的内容，新流只发截断点之后的增量内容，
     * 避免每次续接都重复显示之前的全部文本。
     */
    async function renewStreamIfNeeded(content) {
        if (!session)
            return;
        const elapsed = Date.now() - session.streamStartedAt;
        if (elapsed > WECOM_STREAM_TIMEOUT_MS) {
            log.info(`Stream ${session.streamId} elapsed ${Math.round(elapsed / 1000)}s, renewing`);
            // 旧流结束，显示当前增量内容 + 续接标记
            const oldContent = content.slice(session.contentOffset);
            try {
                await wsClient.replyStream(session.frame, session.streamId, oldContent + '\n\n---\n> _(续)_', true);
            }
            catch (err) {
                log.warn('Failed to finish stream during renewal:', err);
            }
            // 记录截断点，新流从此偏移开始
            session.contentOffset = content.length;
            session.streamId = generateReqId('stream');
            session.streamStartedAt = Date.now();
            session.isFirstUpdate = true;
        }
    }
    /** 构建停止按钮模板卡片 */
    function buildStopCard(taskKey) {
        // 使用时间戳避免 task_id 冲突（WeCom 要求每个消息的 task_id 唯一）
        const uniqueId = `stop_${taskKey}_${Date.now()}`;
        return {
            card_type: 'button_interaction',
            main_title: { title: 'Claude Code' },
            task_id: uniqueId,
            button_list: [
                { text: '⏹️ 停止', style: 3, key: `stop_${taskKey}` },
            ],
        };
    }
    /** 等待 streamBusy 释放，带 5 秒超时保护 */
    async function waitForStreamIdle() {
        const waitStart = Date.now();
        while (streamBusy) {
            if (Date.now() - waitStart > 5000) {
                log.warn('Timed out waiting for streamBusy lock (5s), proceeding anyway');
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    /**
     * 首次流式更新后，单独发一条停止按钮卡片消息。
     * replyStreamWithCard 在手机端可能不渲染卡片，改为 sendMessage 独立发送。
     */
    async function sendStopCardIfNeeded() {
        if (!session || !session.chatId || !session.taskKey || session.stopCardSent)
            return;
        session.stopCardSent = true;
        try {
            await wsClient.sendMessage(session.chatId, {
                msgtype: 'template_card',
                template_card: buildStopCard(session.taskKey),
            });
        }
        catch (err) {
            log.warn('Failed to send stop card:', err);
        }
    }
    /**
     * 内部串行化的流式更新
     * 保证同一时刻最多一个 replyStream 在飞行中
     */
    async function doStreamUpdate(content, toolNote) {
        if (!session)
            return;
        await renewStreamIfNeeded(content);
        // 只发送截断点之后的增量内容
        const sliced = content.slice(session.contentOffset);
        const text = toolNote ? `${sliced}\n\n---\n> ${toolNote}` : sliced;
        try {
            await wsClient.replyStream(session.frame, session.streamId, text, false);
            session.isFirstUpdate = false;
        }
        catch (err) {
            log.warn('Failed to send stream update:', err);
        }
    }
    return {
        async sendTextReply(chatId, text) {
            try {
                await wsClient.sendMessage(chatId, {
                    msgtype: 'markdown',
                    markdown: { content: text },
                });
            }
            catch (err) {
                log.error('Failed to send text reply:', err);
            }
        },
        initStream(frame, taskKey) {
            const body = frame.body;
            const chatId = body?.chatid ?? body?.from?.userid ?? null;
            streamBusy = false;
            pendingStreamUpdate = null;
            session = {
                frame,
                chatId,
                streamId: generateReqId('stream'),
                streamStartedAt: Date.now(),
                isFirstUpdate: true,
                taskKey: taskKey ?? '',
                stopCardSent: false,
                contentOffset: 0,
            };
        },
        async sendStreamUpdate(content, toolNote) {
            if (!session)
                return;
            // 如果前一个 replyStream 还在飞行中，保存最新内容，等它完成后再发
            if (streamBusy) {
                pendingStreamUpdate = { content, toolNote };
                return;
            }
            streamBusy = true;
            try {
                await doStreamUpdate(content, toolNote);
                // 首次流式更新成功后，单独发送停止按钮卡片
                await sendStopCardIfNeeded();
                // 发送期间如果有新的 pending 内容，循环处理（避免递归）
                while (pendingStreamUpdate) {
                    const pending = pendingStreamUpdate;
                    pendingStreamUpdate = null;
                    await doStreamUpdate(pending.content, pending.toolNote);
                }
            }
            finally {
                streamBusy = false;
            }
        },
        async resetStreamForTextSwitch(content, thinkingText) {
            if (!session)
                return;
            // 等待正在飞行的 replyStream 完成，避免并发调用
            await waitForStreamIdle();
            streamBusy = true;
            // 丢弃切换前的 pending 更新（思考阶段的内容已过时）
            pendingStreamUpdate = null;
            try {
                // 结束当前流，保留完整思考内容作为独立消息
                const thinkingContent = `💭 **思考过程**\n\n${thinkingText}`;
                try {
                    await wsClient.replyStream(session.frame, session.streamId, thinkingContent, true);
                }
                catch (err) {
                    log.warn('Failed to finish thinking stream:', err);
                }
                // 开启新流用于实际回答，重置偏移量（文本从头开始）
                session.contentOffset = 0;
                session.streamId = generateReqId('stream');
                session.streamStartedAt = Date.now();
                session.isFirstUpdate = true;
                // 立即发送首条文本内容到新流
                try {
                    await wsClient.replyStream(session.frame, session.streamId, content || '...', false);
                    session.isFirstUpdate = false;
                }
                catch (err) {
                    log.warn('Failed to start text stream:', err);
                }
            }
            finally {
                streamBusy = false;
            }
        },
        async sendStreamComplete(content, note) {
            if (!session)
                return;
            // 等待飞行中的 replyStream 完成，避免并发调用
            await waitForStreamIdle();
            streamBusy = true;
            // 只发送截断点之后的增量内容
            const sliced = content.slice(session.contentOffset);
            const parts = splitLongContent(sliced, MAX_WECOM_MESSAGE_LENGTH);
            const firstPart = note ? `${parts[0]}\n\n---\n> ${note}` : parts[0];
            try {
                try {
                    await wsClient.replyStream(session.frame, session.streamId, firstPart, true);
                }
                catch (err) {
                    log.warn('Failed to finish stream, falling back to sendMessage:', err);
                    if (session.chatId) {
                        try {
                            await wsClient.sendMessage(session.chatId, {
                                msgtype: 'markdown',
                                markdown: { content: firstPart },
                            });
                        }
                        catch (fallbackErr) {
                            log.error('Fallback sendMessage also failed:', fallbackErr);
                        }
                    }
                }
                // 发送后续分片
                if (parts.length > 1 && session.chatId) {
                    for (let i = 1; i < parts.length; i++) {
                        try {
                            const partText = `${parts[i]}\n\n---\n> (续 ${i + 1}/${parts.length}) ${note}`;
                            await wsClient.sendMessage(session.chatId, {
                                msgtype: 'markdown',
                                markdown: { content: partText },
                            });
                        }
                        catch (err) {
                            log.error(`Failed to send continuation part ${i + 1}/${parts.length}:`, err);
                        }
                    }
                }
            }
            finally {
                streamBusy = false;
            }
        },
        async sendStreamError(error) {
            if (!session)
                return;
            // 等待飞行中的 replyStream 完成，避免并发调用
            await waitForStreamIdle();
            streamBusy = true;
            const text = `❌ 错误\n\n${error}`;
            try {
                await wsClient.replyStream(session.frame, session.streamId, text, true);
            }
            catch (err) {
                log.warn('Failed to send stream error, falling back to sendMessage:', err);
                if (session.chatId) {
                    try {
                        await wsClient.sendMessage(session.chatId, {
                            msgtype: 'markdown',
                            markdown: { content: text },
                        });
                    }
                    catch (fallbackErr) {
                        log.error('Fallback sendMessage also failed:', fallbackErr);
                    }
                }
            }
            finally {
                streamBusy = false;
            }
        },
        cleanupStream() {
            session = null;
            streamBusy = false;
            pendingStreamUpdate = null;
        },
        async sendPermissionCard(chatId, requestId, toolName, toolInput) {
            const inputSummary = buildInputSummary(toolName, toolInput);
            // 动态生成按钮文案
            const actionMap = {
                Bash: '执行', Edit: '修改', Write: '写入',
                Read: '读取', Grep: '搜索', Glob: '搜索',
            };
            const action = actionMap[toolName] || '操作';
            try {
                await wsClient.sendMessage(chatId, {
                    msgtype: 'template_card',
                    template_card: {
                        card_type: 'button_interaction',
                        main_title: { title: `🔐 ${toolName} - 请求${action}` },
                        sub_title_text: inputSummary.length > 300 ? inputSummary.slice(0, 300) + '...' : inputSummary,
                        task_id: `perm_${requestId}`,
                        button_list: [
                            { text: `允许${action}`, style: 1, key: `perm_allow_${requestId}` },
                            { text: '始终允许', style: 1, key: `perm_allowall_${requestId}` },
                            { text: '拒绝', style: 3, key: `perm_deny_${requestId}` },
                        ],
                    },
                });
            }
            catch (err) {
                log.error('Failed to send permission card:', err);
            }
            return '';
        },
        async updatePermissionCard(params) {
            // 企业微信的模板卡片更新通过 template_card_event 事件的回调帧完成
            // 在 event-handler 中处理，此处仅记录日志
            log.info(`Permission card update: ${params.toolName} ${params.decision} (handled via template_card_event)`);
        },
        async sendImage(chatId, imagePath) {
            // 企业微信智能机器人不支持独立发送图片消息
            log.info(`Image sending not supported in WeCom (path: ${imagePath})`);
        },
    };
}
/**
 * 独立的 sendTextReply 函数，使用全局 WSClient
 * 供 index.ts 等模块发送生命周期通知使用
 */
export async function sendTextReply(chatId, text) {
    try {
        const client = getWSClient();
        await client.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: text },
        });
    }
    catch (err) {
        log.error('Failed to send text reply (standalone):', err);
    }
}
