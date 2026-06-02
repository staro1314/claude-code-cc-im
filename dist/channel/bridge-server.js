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
export async function startBridgeServer({ port, sendTextReply, sendPermissionCard, resolvePermission }) {
  // Track the last active chat_id for permission relay
  let lastChatId = '';
  // 缓存 hook 推送的工具通知全文，供权限卡片使用（MCP 通知的 input_preview 是截断的）
  const toolNotificationCache = new Map(); // chatId → { text, ts }

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
          log.info(`  description: ${(description || '').slice(0, 150)}`);
          log.info(`  input_preview len=${input_preview ? input_preview.length : 0}`);
          if (chatId) {
            // 优先从缓存取 hook 推送的工具通知全文（含完整 diff）
            const cacheKey = `${chatId}:${tool_name}`;
            const cached = toolNotificationCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < 30000) {
              body._inputPreview = cached.text.replace(/^[^\n]*?→\s*/, '');
              toolNotificationCache.delete(cacheKey);
              log.info(`Using cached notification for ${cacheKey}: len=${body._inputPreview.length}, has_plus=${body._inputPreview.includes('+')}, preview=${body._inputPreview.slice(0, 200)}`);
            } else {
              log.info(`No cache hit for ${cacheKey}: cached=${!!cached}, age=${cached ? Date.now() - cached.ts : 'N/A'}ms`);
            }
            // 回退：从截断 JSON 提取可读信息
            if (!body._inputPreview && input_preview && input_preview.startsWith('{')) {
              try {
                const p = JSON.parse(input_preview);
                if (p.old_string != null && p.new_string != null) {
                  const parts = [];
                  if (p.file_path) parts.push(p.file_path);
                  parts.push(...String(p.old_string).split('\n').map(l => `- ${l}`));
                  parts.push(...String(p.new_string).split('\n').map(l => `+ ${l}`));
                  body._inputPreview = parts.join('\n');
                } else if (p.command) {
                  body._inputPreview = `Bash → ${String(p.command).slice(0, 120)}`;
                }
              } catch {
                // 截断 JSON：字符串定位提取（不依赖正则，避免引号内转义干扰）
                const extract = (key) => {
                  const marker = `"${key}":"`;
                  const idx = input_preview.indexOf(marker);
                  if (idx < 0) return '';
                  const start = idx + marker.length;
                  // 提取到 JSON 字符串结束位置（引号或逗号或大括号）
                  let end = start;
                  let escaped = false;
                  while (end < input_preview.length) {
                    const ch = input_preview[end];
                    if (escaped) {
                      escaped = false;
                    } else if (ch === '\\') {
                      escaped = true;
                    } else if (ch === '"') {
                      break;
                    }
                    end++;
                  }
                  return input_preview.slice(start, end)
                    .replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/\\"/g, '"').trim();
                };
                const fpM = input_preview.match(/"file_path"\s*:\s*"([^"]+)"/);
                const fp = fpM ? fpM[1].replace(/\\\\/g, '\\').replace(/.*[/\\]/, '') : '';
                const os = extract('old_string');
                const ns = extract('new_string');
                log.info(`[DEBUG] extract: fp="${fp}", os len=${os.length}, ns len=${ns.length}`);
                log.info(`[DEBUG] extract os="${os.slice(0, 80)}"`);
                log.info(`[DEBUG] extract ns="${ns.slice(0, 80)}"`);
                if (os || ns) {
                  const parts = [];
                  if (fp) parts.push(`📝 ${fp}`);
                  if (os) parts.push(...os.split('\n').filter(Boolean).map(l => `- ${l}`));
                  if (ns) parts.push(...ns.split('\n').filter(Boolean).map(l => `+ ${l}`));
                  body._inputPreview = parts.join('\n');
                  log.info(`[DEBUG] body._inputPreview="${body._inputPreview.slice(0, 100)}"`);
                } else if (fp) {
                  body._inputPreview = `📝 ${fp}`;
                }
              }
            }
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

          // 心跳：仅后台检测，不推送（停止卡片已作为加载指示器）
          if (tool_name === 'heartbeat' || tool_name === 'heartbeat-done') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // 所有其他事件：直接发送文本
          log.debug(`Tool event → chat=${chatId}: ${tool_name}`);
          // 缓存需要权限的工具通知全文（Edit/Bash/Write 等），供权限卡片使用
          // 只缓存包含 diff 或命令详情的长通知，排除 thinking/text 等短通知
          const permissionTools = ['Edit', 'Bash', 'Write', 'WebFetch', 'WebSearch', 'Agent'];
          if (notification && permissionTools.includes(tool_name) && notification.length > 80) {
            toolNotificationCache.set(`${chatId}:${tool_name}`, { text: notification, ts: Date.now() });
            log.debug(`Cached tool notification for ${chatId}:${tool_name}: len=${notification.length}`);
          }
          await sendTextReply(chatId, notification);
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
