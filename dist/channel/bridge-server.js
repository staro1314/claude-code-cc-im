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
export async function startBridgeServer({ port, sendTextReply, sendPermissionCard, resolvePermission, updateHeartbeatCard }) {
  // Track the last active chat_id for permission relay
  let lastChatId = '';
  // Track heartbeat card for in-place update
  let heartbeatTaskId = '';
  // Current message frame for streaming (from incoming WeChat Work message)
  let currentFrame = null;
  // Current stream ID for replyStream
  let streamId = '';
  // Accumulated lines for batch send
  let streamLines = [];
  let streamFlushTimer = null;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Claude's reply → forward to WeChat Work
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
          // Write chatId to file so hook-script can read it in channel mode
          try {
            const chatIdFile = join(homedir(), '.cc-im', 'active-chat-id');
            mkdirSync(join(homedir(), '.cc-im'), { recursive: true });
            writeFileSync(chatIdFile, chat_id, 'utf-8');
          } catch { /* ignore */ }
          log.debug(`Channel reply → chat_id=${chat_id}, len=${text.length}`);
          await sendTextReply(chat_id, text);
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
          const { request_id, decision } = body;
          log.info(`Permission decision: ${request_id} → ${decision}`);
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

      // Save current message frame for template card updates
      if (req.method === 'POST' && req.url === '/set-frame') {
        try {
          const body = await readBody(req);
          currentFrame = body.frame || null;
          lastChatId = body.chat_id || lastChatId;
          log.debug(`Frame saved: chat=${lastChatId}`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Tool event notification → buffer and batch-send to WeChat Work
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

          // 心跳单独发送
          if (tool_name === 'heartbeat' || tool_name === 'heartbeat-done') {
            await sendTextReply(chatId, notification);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // 普通事件：缓冲 1 秒后批量发送
          streamLines.push(notification);
          if (streamLines.length > 15) streamLines = streamLines.slice(-15);
          if (!streamFlushTimer) {
            streamFlushTimer = setTimeout(async () => {
              streamFlushTimer = null;
              if (streamLines.length === 0) return;
              const batch = streamLines.splice(0, streamLines.length);
              try {
                await sendTextReply(chatId, batch.join('\n'));
              } catch (err) {
                log.error('Batch send error:', err);
              }
            }, 1000);
            streamFlushTimer.unref?.();
          }
          log.debug(`Tool event buffered → chat=${chatId}: ${tool_name}`);
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
