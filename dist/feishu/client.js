import * as Lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../logger.js';
const log = createLogger('Feishu');
let client;
let wsClient;
let botOpenId;
export function getClient() {
    if (!client)
        throw new Error('Feishu client not initialized. Call initFeishu() first.');
    return client;
}
export function getBotOpenId() {
    return botOpenId;
}
export async function initFeishu(config, eventDispatcher) {
    const baseConfig = {
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
    };
    client = new Lark.Client(baseConfig);
    try {
        const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' });
        botOpenId = res?.bot?.open_id;
        if (botOpenId) {
            log.info(`Bot open_id obtained`);
        }
        else {
            log.warn('Failed to get bot open_id from /bot/v3/info, group @mention check will be skipped');
        }
    }
    catch (e) {
        log.warn(`Failed to fetch bot info: ${e instanceof Error ? e.message : e}, group @mention check will be skipped`);
    }
    wsClient = new Lark.WSClient({
        ...baseConfig,
        loggerLevel: Lark.LoggerLevel.info,
    });
    wsClient.start({ eventDispatcher });
    log.info('WSClient started');
}
export function stopFeishu() {
    log.info('Stopping WSClient...');
    wsClient?.close();
}
