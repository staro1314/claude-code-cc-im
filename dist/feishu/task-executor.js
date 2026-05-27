import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply, uploadAndSendImage } from './message-sender.js';
import { buildCardV2 } from './card-builder.js';
import { destroySession, updateCardFull, disableStreaming } from './cardkit-manager.js';
import { runClaudeTask } from '../shared/claude-task.js';
import { CARDKIT_THROTTLE_MS } from '../constants.js';
import { createLogger } from '../logger.js';
const log = createLogger('FeishuTask');
export async function executeClaudeTask(deps, userId, chatId, prompt, workDir, convId, threadCtx, mentionedBot, isGroup) {
    const { config, sessionManager, userCosts, runningTasks } = deps;
    const sessionId = threadCtx && threadCtx.threadId
        ? sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
        : convId
            ? sessionManager.getSessionIdForConv(userId, convId)
            : undefined;
    log.info(`Running Claude for user ${userId}, ${threadCtx ? `thread=${threadCtx.threadId}` : `convId=${convId}`}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);
    let cardHandle;
    try {
        cardHandle = await sendThinkingCard(chatId, threadCtx);
    }
    catch (err) {
        log.error('Failed to send thinking card:', err);
        return;
    }
    const { messageId, cardId } = cardHandle;
    if (!cardId) {
        log.error('No card_id returned for thinking card');
        return;
    }
    const taskKey = `${userId}:${cardId}`;
    let waitingTimer = null;
    await runClaudeTask({ config, sessionManager, userCosts }, {
        userId,
        chatId,
        workDir,
        sessionId,
        convId,
        threadId: threadCtx?.threadId,
        threadRootMsgId: threadCtx?.rootMessageId,
        platform: 'feishu',
        taskKey,
    }, prompt, {
        throttleMs: CARDKIT_THROTTLE_MS,
        streamUpdate: (content, toolNote) => {
            streamContentUpdate(cardId, content, toolNote).catch((e) => log.warn('Stream update failed:', e?.message ?? e));
        },
        sendComplete: async (content, note, thinkingText) => {
            try {
                await sendFinalCards(chatId, messageId, cardId, content, note, threadCtx, thinkingText);
                if (isGroup && mentionedBot) {
                    const replyText = `<at user_id="${userId}"></at> 任务已完成 ✅`;
                    await sendTextReply(chatId, replyText, threadCtx);
                }
            }
            catch (err) {
                log.error('Failed to send final cards:', err);
            }
        },
        sendError: async (error) => {
            try {
                await sendErrorCard(cardId, error);
            }
            catch (err) {
                log.error('Failed to send error card:', err);
            }
        },
        onThinkingToText: (content, _thinkingText) => {
            const resetCard = buildCardV2({ content: content || '...', status: 'streaming' }, cardId);
            updateCardFull(cardId, resetCard)
                .catch((e) => log.warn('Thinking→text transition update failed:', e?.message ?? e));
        },
        extraCleanup: () => {
            if (waitingTimer) {
                clearInterval(waitingTimer);
                waitingTimer = null;
            }
            runningTasks.delete(taskKey);
        },
        onTaskReady: (state) => {
            runningTasks.set(taskKey, { ...state, cardId, messageId });
            const startTime = Date.now();
            waitingTimer = setInterval(() => {
                const taskInfo = runningTasks.get(taskKey);
                if (!taskInfo) {
                    if (waitingTimer) {
                        clearInterval(waitingTimer);
                        waitingTimer = null;
                    }
                    return;
                }
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const dots = '.'.repeat((Math.floor(elapsed / 2) % 4));
                const loadingText = `⏳ **模型思考中**${dots}\n\n已等待 ${elapsed} 秒`;
                streamContentUpdate(cardId, loadingText).catch(() => { });
            }, 2000);
        },
        onFirstContent: () => {
            if (waitingTimer) {
                clearInterval(waitingTimer);
                waitingTimer = null;
            }
        },
        sendImage: (imagePath) => uploadAndSendImage(chatId, imagePath, threadCtx),
    });
}
export function handleStopAction(runningTasks, userId, cardId) {
    const taskKey = `${userId}:${cardId}`;
    const taskInfo = runningTasks.get(taskKey);
    if (taskInfo) {
        log.info(`User ${userId} stopped task for card ${cardId}`);
        const stoppedContent = taskInfo.latestContent || '(任务已停止，暂无输出)';
        runningTasks.delete(taskKey);
        taskInfo.settle();
        taskInfo.handle.abort();
        const stoppedCard = buildCardV2({ content: stoppedContent, status: 'done', note: '⏹️ 已停止' });
        disableStreaming(cardId)
            .then(() => updateCardFull(cardId, stoppedCard))
            .catch((e) => log.warn('Stop card update failed:', e?.message ?? e))
            .finally(() => destroySession(cardId));
    }
    else {
        log.warn(`No running task found for key: ${taskKey}`);
        log.info(`Current running tasks: ${Array.from(runningTasks.keys()).join(', ')}`);
    }
}
