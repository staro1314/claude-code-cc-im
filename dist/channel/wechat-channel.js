/**
 * WeChat Work Channel MCP Server
 *
 * Bridges WeChat Work messages into Claude Code via the channels protocol.
 * Claude Code spawns this as a subprocess and communicates over stdio.
 *
 * Architecture:
 *   WeChat Work → cc-im service → HTTP POST → this server → MCP notification → Claude Code
 *   Claude Code → MCP tool call → this server → HTTP POST → cc-im service → WeChat Work
 *
 * Usage:
 *   node dist/channel/wechat-channel.js [--port PORT]
 *
 * Environment variables:
 *   CC_IM_BRIDGE_PORT - Port cc-im bridge server listens on (for replies)
 *   CC_IM_CHANNEL_PORT - Port this channel server listens on (for incoming messages)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerChannel, unregisterChannel } from './channel-registry.js';

// --- Configuration ---
// Use port 0 to let OS assign random available port (supports multiple instances)
const CHANNEL_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '0', 10) || 0;
const BRIDGE_PORT = parseInt(process.env.CC_IM_BRIDGE_PORT || '0', 10) || 18790;
const APP_HOME = join(homedir(), '.cc-im');

// Generate unique client ID for this instance
const CLIENT_ID = `claude-${randomBytes(4).toString('hex')}`;

// --- State ---
/** @type {Map<string, {resolve: (decision: string) => void, timer: NodeJS.Timeout}>} */
const pendingPermissions = new Map();

// --- MCP Server ---
const mcp = new Server(
  { name: 'wechat-work', version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      'You are connected to WeChat Work (企业微信) through a channel bridge.',
      'Messages arrive as <channel source="wechat-work" chat_id="..." user_id="..." platform="wecom">message content</channel>.',
      'Reply to messages using the "reply" tool, passing the chat_id from the channel tag.',
      'For permission requests, use the "permission" tool with request_id and decision (allow/deny).',
      'Always reply in the same language as the incoming message.',
      'Keep responses concise and helpful.',
    ].join('\n'),
  },
);

// --- Reply Tool ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to WeChat Work user through the channel',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat ID to reply to (from the channel tag)' },
          text: { type: 'string', description: 'The message text to send' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'permission',
      description: 'Approve or deny a permission request from WeChat Work user',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The permission request ID' },
          decision: { type: 'string', enum: ['allow', 'deny'], description: 'allow or deny' },
        },
        required: ['request_id', 'decision'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'reply') {
    const { chat_id, text } = args;
    // Forward reply to cc-im bridge server
    try {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text }),
      });
      return { content: [{ type: 'text', text: 'Message sent to WeChat Work' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to send: ${err.message}` }] };
    }
  }

  if (name === 'permission') {
    const { request_id, decision } = args;
    try {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/permission-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, decision }),
      });
      return { content: [{ type: 'text', text: `Permission ${decision}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to send decision: ${err.message}` }] };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Permission Relay Handler ---
// When Claude Code has a permission dialog, it notifies us via this handler.
// We forward the prompt to cc-im which shows it in WeChat Work.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params;
    log(`Permission request: ${tool_name} (${request_id})`);

    // Forward to cc-im bridge for display in WeChat Work
    try {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/permission-relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, tool_name, description, input_preview }),
      });
    } catch (err) {
      log(`Failed to relay permission to cc-im: ${err.message}`);
    }
  },
);

// --- HTTP Server (receives messages from cc-im) ---
function startHttpServer(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS headers for local requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/message') {
        try {
          const body = await readBody(req);
          const { content, chat_id, user_id, platform, msg_id } = body;

          if (!content || !chat_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'content and chat_id required' }));
            return;
          }

          // Push message into Claude Code session
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content,
              meta: {
                chat_id,
                user_id: user_id || '',
                platform: platform || 'wecom',
                msg_id: msg_id || '',
              },
            },
          });

          log(`Message forwarded to Claude: chat_id=${chat_id}, len=${content.length}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log(`Error handling message: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/permission-decision') {
        try {
          const body = await readBody(req);
          const { request_id, decision } = body;

          if (!request_id || !decision) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'request_id and decision required' }));
            return;
          }

          // Forward permission decision to Claude Code
          await mcp.notification({
            method: 'notifications/claude/channel/permission',
            params: {
              request_id,
              behavior: decision,
            },
          });

          log(`Permission decision forwarded: ${request_id} -> ${decision}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'wechat-work-channel' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log(`HTTP server listening on 127.0.0.1:${actualPort}`);

      // Write port info so cc-im can discover it
      try {
        const portFile = join(APP_HOME, 'channel-port');
        mkdirSync(APP_HOME, { recursive: true });
        writeFileSync(portFile, String(actualPort), 'utf-8');
      } catch { /* ignore */ }

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
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] [WeChatChannel] ${msg}\n`);
}

// --- Main ---
async function main() {
  log('Starting WeChat Work Channel MCP Server...');
  log(`Client ID: ${CLIENT_ID}`);

  // Start HTTP server for receiving messages from cc-im
  const httpServer = await startHttpServer(CHANNEL_PORT);
  log(`Channel HTTP port: ${httpServer.port}`);

  // Register with channel registry
  const registered = registerChannel(CLIENT_ID, httpServer.port);
  if (!registered) {
    log('Warning: Port already in use by another channel instance');
  }

  // Connect MCP server to Claude Code over stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP server connected to Claude Code');

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    unregisterChannel(CLIENT_ID);
    await httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => unregisterChannel(CLIENT_ID));
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
