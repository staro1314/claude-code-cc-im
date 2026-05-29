/**
 * Channel Bridge Server
 *
 * Runs inside the cc-im service process. Bridges between the WeChat Work
 * channel MCP server and the existing WeChat Work message sender.
 *
 * Responsibilities:
 * - Receives replies from the channel server and forwards to WeChat Work
 * - Receives permission relay requests and shows them in WeChat Work
 * - Forwards permission decisions back to the channel server
 * - Tracks active chat sessions for the channel
 *
 * Port: reads CC_IM_BRIDGE_PORT from config or uses default 18790
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';
import { APP_HOME } from '../constants.js';
import { getDefaultChannelPort, getAllChannels, cleanupRegistry } from './channel-registry.js';

const log = createLogger('Bridge');

/**
 * Create and start the bridge server.
 *
 * @param {object} options
 * @param {number} options.port - Port to listen on
 * @param {Function} options.sendTextReply - async (chatId, text) => void
 * @param {Function} options.sendPermissionCard - async (chatId, requestId, toolName, toolInput) => void
 * @param {Function} options.resolvePermission - (requestId, decision) => void
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startBridgeServer({ port, sendTextReply, sendPermissionCard, resolvePermission, updateHeartbeatCard, streamController }) {
  // Track the last active chat_id for permission relay
  let lastChatId = '';

  // Stream state: accumulate tool events for progressive display
  let streamLines = [];
  const MAX_STREAM_LINES = 40;

  function appendStreamLine(line) {
    streamLines.push(line);
    if (streamLines.length > MAX_STREAM_LINES) streamLines.shift();
    return streamLines.join('\n');
  }

  function resetStreamState() { streamLines = []; }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Claude's reply → complete stream or forward as text
      if (req.method === 'POST' && req.url === '/reply') {
        try {
          const body = await readBody(req);
          const { chat_id, text } = body;
          if (!chat_id || !text) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'chat_id and text required' }));
            return;
          }
          lastChatId = chat_id;
          try {
            const chatIdFile = join(homedir(), '.cc-im', 'active-chat-id');
            mkdirSync(join(homedir(), '.cc-im'), { recursive: true });
            writeFileSync(chatIdFile, chat_id, 'utf-8');
          } catch { /* ignore */ }
          log.debug(`Channel reply → chat_id=${chat_id}, len=${text.length}`);
          if (streamController?.isActive?.()) {
            try {
              await streamController.complete(text);
              resetStreamState();
            } catch (err) {
              log.warn('Stream complete failed, fallback to text:', err);
              await sendTextReply(chat_id, text);
            }
          } else {
            await sendTextReply(chat_id, text);
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.error('Bridge reply error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Permission relay → show permission card in WeChat Work
      if (req.method === 'POST' && req.url === '/permission-relay') {
        try {
          const body = await readBody(req);
          const { request_id, tool_name, description, input_preview } = body;
          const chatId = body.chat_id || lastChatId;
          log.info(`Permission relay: ${tool_name} (${request_id}) → chat=${chatId}`);
          if (chatId) {
            await sendPermissionCard(chatId, request_id, tool_name, body);
            log.info(`Permission card sent to chat=${chatId}`);
          } else {
            log.warn('Permission relay: no chat_id available');
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.error('Bridge permission-relay error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Permission decision → forward to channel server
      if (req.method === 'POST' && req.url === '/permission-decision') {
        try {
          const body = await readBody(req);
          const { request_id, decision, allow_all } = body;
          log.info(`Permission decision: ${request_id} → ${decision}${allow_all ? ' (allow_all)' : ''}`);
          if (allow_all && decision === 'allow') {
            // "全部允许": resolve all pending + enable auto-allow
            const { resolveAllPending } = await import('../hook/permission-server.js');
            resolveAllPending(lastChatId || '', 'allow');
          }
          resolvePermission(request_id, decision);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.error('Bridge permission-decision error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Tool event notification → stream update or fallback to text
      if (req.method === 'POST' && req.url === '/tool-event') {
        try {
          const body = await readBody(req);
          const { chat_id, tool_name, notification } = body;
          const chatId = chat_id || lastChatId;
          if (!chatId || !notification) {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // 心跳：仅后台检测，不推送到企业微信
          if (tool_name === 'heartbeat' || tool_name === 'heartbeat-done') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // 所有其他事件：累积到流式消息，失败则 fallback 文本
          log.debug(`Tool event → chat=${chatId}: ${tool_name}`);
          if (streamController?.isActive?.()) {
            const content = appendStreamLine(notification);
            const ok = await streamController.update(content);
            if (!ok) await sendTextReply(chatId, notification);
          } else {
            await sendTextReply(chatId, notification);
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.error('Bridge tool-event error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', server: 'bridge' }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log.info(`Bridge server listening on 127.0.0.1:${actualPort}`);
      resolve({ port: actualPort, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Forward a WeChat Work message to the channel server.
 *
 * @param {number} channelPort - Port the channel server is listening on
 * @param {object} message
 * @param {string} message.content - Message text
 * @param {string} message.chat_id - Chat ID
 * @param {string} message.user_id - User ID
 * @param {string} message.platform - Platform name (wecom)
 * @param {string} message.msg_id - Message ID for dedup
 */
export async function forwardToChannel(channelPort, message) {
  try {
    const res = await fetch(`http://127.0.0.1:${channelPort}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      log.warn(`Channel forward failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`Channel forward error: ${err.message}`);
    return false;
  }
}

/**
 * Read the channel server port from the registry.
 * Returns null if no channels are registered.
 */
export function getChannelPort() {
  // Clean up stale entries first
  cleanupRegistry();

  // Get default (first) channel port
  return getDefaultChannelPort();
}

/**
 * Get all registered channel ports.
 * Returns array of { clientId, port } objects.
 */
export function getAllChannelPorts() {
  cleanupRegistry();
  const channels = getAllChannels();
  return Object.entries(channels).map(([clientId, info]) => ({
    clientId,
    port: info.port,
  }));
}
