import AiBot from '@wecom/aibot-node-sdk';
import { createLogger } from '../logger.js';
const log = createLogger('Wecom');
let wsClient = null;
export function getWSClient() {
    if (!wsClient)
        throw new Error('Wecom WSClient not initialized');
    return wsClient;
}
export async function initWecom(config, setupHandlers) {
    log.info('Initializing WeChat Work (WeCom) bot...');
    const client = new AiBot.WSClient({
        botId: config.wecomBotId,
        secret: config.wecomBotSecret,
        maxReconnectAttempts: -1, // 无限重连
        logger: {
            debug: (msg, ...args) => log.debug(`[SDK] ${msg}`, ...args),
            info: (msg, ...args) => log.info(`[SDK] ${msg}`, ...args),
            warn: (msg, ...args) => log.warn(`[SDK] ${msg}`, ...args),
            error: (msg, ...args) => log.error(`[SDK] ${msg}`, ...args),
        },
    });
    // 注册生命周期事件
    client.on('disconnected', (reason) => {
        log.warn(`WebSocket disconnected: ${reason}`);
    });
    client.on('reconnecting', (attempt) => {
        log.info(`Reconnecting (attempt ${attempt})...`);
    });
    client.on('error', (error) => {
        log.error('WebSocket error:', error);
    });
    // 建立连接
    client.connect();
    // 等待认证成功
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WeChat Work authentication timed out (30s)'));
        }, 30_000);
        client.on('authenticated', () => {
            clearTimeout(timeout);
            log.info('Authenticated successfully');
            resolve();
        });
    });
    wsClient = client;
    // 设置消息处理器
    const handle = setupHandlers(client);
    return { wsClient: client, handle };
}
export function stopWecom() {
    if (wsClient) {
        wsClient.disconnect();
        wsClient = null;
        log.info('WeChat Work bot stopped');
    }
}
