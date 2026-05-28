/**
 * Channel Mode Entry Point
 *
 * Starts cc-im in channel mode: the bridge server receives messages from
 * the WeChat Work channel MCP server and forwards them to WeChat Work.
 *
 * This is the "service side" of the channel architecture:
 *   1. Start bridge server (receives replies from channel server)
 *   2. Connect to WeChat Work WebSocket
 *   3. Register channel-mode message handler
 *   4. Wait for messages → forward to channel server
 *
 * The "Claude side" is started separately:
 *   claude --dangerously-load-development-channels server:wechat-work
 */
import { loadConfig } from '../config.js';
import { initWecom, stopWecom } from '../wecom/client.js';
import { setupWecomChannelHandlers } from './wecom-channel-handler.js';
import { startBridgeServer } from './bridge-server.js';
import { SessionWatcher } from './session-watcher.js';
import { startPermissionServer } from '../hook/permission-server.js';
import { ensureHookConfigured } from '../hook/ensure-hook.js';
import { initLogger, createLogger, closeLogger } from '../logger.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');
const log = createLogger('Channel');

export async function runChannel() {
    process.on('unhandledRejection', (reason) => {
        log.error('Unhandled rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
        log.error('Uncaught exception:', err);
        process.exit(1);
    });

    const config = loadConfig();
    initLogger(config.logDir, config.logLevel);

    log.info('Starting cc-im in CHANNEL mode...');
    log.info('This mode bridges WeChat Work messages into a Claude Code session.');
    log.info('');
    log.info('To use this mode:');
    log.info('  1. This service (cc-im channel) handles WeChat Work messages');
    log.info('  2. Start Claude Code with: claude --dangerously-load-development-channels server:wechat-work');
    log.info('  3. WeChat Work messages will appear in the Claude Code terminal');
    log.info('');

    // Ensure hooks are configured
    ensureHookConfigured();

    // Start permission server (needed for hook callbacks)
    const permissionServer = await startPermissionServer(config.hookPort);
    log.info(`Hook server started on port ${permissionServer.port}`);

    // Start bridge server (for channel ↔ WeChat Work communication)
    const bridgePort = parseInt(process.env.CC_IM_BRIDGE_PORT || '0', 10) || 18790;
    const bridgeServer = await startBridgeServer({
        port: bridgePort,
        sendTextReply: async (chatId, text) => {
            // Dynamically import to avoid circular deps
            const { sendTextReply } = await import('../wecom/message-sender.js');
            await sendTextReply(chatId, text);
        },
        sendPermissionCard: async (chatId, requestId, toolName, toolInput) => {
            // Dynamically import to avoid circular deps
            const { createWecomSender } = await import('../wecom/message-sender.js');
            const { initWecom: getWecomClient } = await import('../wecom/client.js');
            // Use the wsClient that's already connected
            if (wecomWsClient) {
                const sender = createWecomSender(wecomWsClient);
                await sender.sendPermissionCard(chatId, requestId, toolName, toolInput);
                log.info(`Permission card sent: ${toolName} (${requestId}) to ${chatId}`);
            } else {
                log.warn(`Cannot send permission card: WeChat Work client not available`);
            }
        },
        resolvePermission: (requestId, decision) => {
            const { resolvePermissionById } = require('../hook/permission-server.js');
            resolvePermissionById(requestId, decision);
        },
        updateHeartbeatCard: async (chatId, existingTaskId, text) => {
            if (!wecomWsClient) return '';
            try {
                if (existingTaskId) {
                    // 更新已有卡片
                    await wecomWsClient.updateTemplateCard(null, {
                        card_type: 'text_notice',
                        main_title: { title: '⏳ 模型处理中' },
                        sub_title_text: text,
                        task_id: existingTaskId,
                    });
                    return existingTaskId;
                } else {
                    // 发送新卡片
                    const result = await wecomWsClient.sendMessage(chatId, {
                        msgtype: 'template_card',
                        template_card: {
                            card_type: 'text_notice',
                            main_title: { title: '⏳ 模型处理中' },
                            sub_title_text: text,
                        },
                    });
                    return result?.task_id ?? '';
                }
            } catch (err) {
                log.debug(`Heartbeat card update failed: ${err.message}`);
                return existingTaskId || '';
            }
        },
    });
    log.info(`Bridge server started on port ${bridgeServer.port}`);

    // Write bridge port for other modules
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const appHome = join(homedir(), '.cc-im');
    mkdirSync(appHome, { recursive: true });
    writeFileSync(join(appHome, 'bridge-port'), String(bridgeServer.port), 'utf-8');
    // 创建并持续刷新 channel-active 标记文件（hook-script 通过时间戳判断是否为 channel 模式）
    writeFileSync(join(appHome, 'channel-active'), String(Date.now()), 'utf-8');
    const channelActiveRefresh = setInterval(() => {
        try { writeFileSync(join(appHome, 'channel-active'), String(Date.now()), 'utf-8'); } catch { /* ignore */ }
    }, 10_000);
    channelActiveRefresh.unref();

    // Initialize WeChat Work in channel mode
    let wecomHandle = null;
    let wecomWsClient = null;
    try {
        await initWecom(config, (wsClient) => {
            wecomWsClient = wsClient;
            wecomHandle = setupWecomChannelHandlers(wsClient, config, null, {});
            return wecomHandle;
        });
        log.info('WeChat Work bot initialized (channel mode)');
    } catch (err) {
        log.error('Failed to initialize WeChat Work bot:', err);
        process.exit(1);
    }

    // Start session file watcher for real-time thinking push
    const sessionWatcher = new SessionWatcher({
        bridgeUrl: `http://127.0.0.1:${bridgeServer.port}`,
        chatId: '',
    });
    sessionWatcher.start().catch(err => log.warn('Session watcher start failed:', err));

    // Update watcher's chatId when WeChat Work messages arrive
    const origOnMessage = wecomHandle?.stop;
    if (wecomWsClient) {
        wecomWsClient.on('message.text', (frame) => {
            const chatId = frame.body?.chatid || frame.body?.from?.userid;
            if (chatId) sessionWatcher.setChatId(chatId);
        });
        wecomWsClient.on('message.voice', (frame) => {
            const chatId = frame.body?.chatid || frame.body?.from?.userid;
            if (chatId) sessionWatcher.setChatId(chatId);
        });
    }

    log.info('');
    log.info('Channel service is running!');
    log.info('');
    log.info('Now start Claude Code in another terminal:');
    log.info(`  claude --dangerously-load-development-channels server:wechat-work`);
    log.info('');
    log.info('Send a message in WeChat Work to see it in Claude Code.');
    log.info('Press Ctrl+C to stop.');

    // Graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('Shutting down channel service...');
        // 删除 channel-active 标记文件并停止刷新
        clearInterval(channelActiveRefresh);
        try { unlinkSync(join(homedir(), '.cc-im', 'channel-active')); } catch { /* ignore */ }
        sessionWatcher.stop();
        wecomHandle?.stop();
        stopWecom();
        await bridgeServer.close();
        await permissionServer.close();
        closeLogger();
        process.exit(0);
    };
    const onSignal = () => { shutdown().catch(() => process.exit(1)); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
}
