/**
 * Session File Watcher
 *
 * Monitors ALL Claude Code session JSONL files for thinking events
 * and pushes them to the bridge server in real-time.
 *
 * Thinking events have unique UUIDs for deduplication.
 * Also manages the heartbeat (loading indicator) for active sessions.
 */
import { watch, readFileSync } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('SessionWatcher');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export class SessionWatcher {
  /** @type {Map<string, number>} filePath → last known file size */
  #fileSizes = new Map();
  /** @type {Set<string>} UUIDs of already-sent events (thinking + tool calls) */
  #sentUuids = new Set();
  /** @type {import('node:fs').FSWatcher | null} */
  #watcher = null;
  /** @type {NodeJS.Timeout | null} */
  #scanTimer = null;
  /** @type {string} bridge server URL */
  #bridgeUrl;
  /** @type {string} chat_id for WeChat Work */
  #chatId;
  #maxSentUuids = 5000;
  /** @type {NodeJS.Timeout | null} */
  #heartbeatTimer = null;
  #lastActivityTime = 0;
  #heartbeatInterval = 30_000;

  constructor({ bridgeUrl, chatId }) {
    this.#bridgeUrl = bridgeUrl;
    this.#chatId = chatId;
  }

  async start() {
    log.info(`Watching all session files in ${PROJECTS_DIR}`);
    await this.#scanAllFiles();
    try {
      this.#watcher = watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        this.#scheduleRead(join(PROJECTS_DIR, filename));
      });
      log.info('Session file watcher started');
    } catch (err) {
      log.warn('Failed to watch, using scan fallback:', err.message);
      this.#scanTimer = setInterval(() => this.#scanAllFiles(), 3000);
    }
  }

  setChatId(chatId) { this.#chatId = chatId; }

  stop() {
    if (this.#watcher) { this.#watcher.close(); this.#watcher = null; }
    if (this.#scanTimer) { clearInterval(this.#scanTimer); this.#scanTimer = null; }
    this.#clearHeartbeat();
    this.#sentUuids.clear();
    log.info('Session watcher stopped');
  }

  #clearHeartbeat() {
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null; }
  }

  #startHeartbeat() {
    this.#lastActivityTime = Date.now();
    if (this.#heartbeatTimer) return;
    this.#sendHeartbeat(0);
    this.#heartbeatTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.#lastActivityTime) / 1000);
      if (elapsed > 60) { this.#sendHeartbeatDone(); this.#clearHeartbeat(); return; }
      this.#sendHeartbeat(elapsed);
    }, this.#heartbeatInterval);
    this.#heartbeatTimer.unref();
  }

  /** @type {Map<string, NodeJS.Timeout>} */
  #pendingReads = new Map();

  #scheduleRead(filePath) {
    const existing = this.#pendingReads.get(filePath);
    if (existing) clearTimeout(existing);
    this.#pendingReads.set(filePath, setTimeout(() => {
      this.#pendingReads.delete(filePath);
      this.#readNewLines(filePath).catch(() => {});
    }, 200));
  }

  async #scanAllFiles() {
    try {
      const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = join(PROJECTS_DIR, dir.name);
        try {
          const files = await readdir(dirPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = join(dirPath, file);
            try {
              const s = await stat(filePath);
              this.#fileSizes.set(filePath, s.size);
            } catch { /* deleted */ }
          }
        } catch { /* permission */ }
      }
    } catch (err) { log.debug('Scan error:', err); }
  }

  async #readNewLines(filePath) {
    const lastSize = this.#fileSizes.get(filePath) ?? 0;
    let currentSize;
    try { const s = await stat(filePath); currentSize = s.size; } catch { return; }
    if (currentSize <= lastSize) return;

    this.#startHeartbeat();

    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      await fh.read(buf, 0, buf.length, lastSize);
      this.#fileSizes.set(filePath, currentSize);
      const lines = buf.toString('utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'thinking' && event.uuid && !this.#sentUuids.has(event.uuid)) {
            await this.#handleThinkingEvent(event);
          }
        } catch { /* malformed */ }
      }
    } catch (err) { log.debug(`Read error: ${err.message}`); }
    finally { await fh?.close(); }
  }

  async #handleThinkingEvent(event) {
    this.#sentUuids.add(event.uuid);
    if (this.#sentUuids.size > this.#maxSentUuids) {
      const first = this.#sentUuids.values().next().value;
      if (first !== undefined) this.#sentUuids.delete(first);
    }
    const thinking = event.message?.content?.[0]?.thinking;
    if (!thinking) return;
    const elapsed = event.timestamp
      ? ` (${new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`
      : '';
    const maxLen = 500;
    const truncated = thinking.length > maxLen ? thinking.slice(0, maxLen) + '...' : thinking;
    const notification = `🧠 **模型思考**${elapsed}\n\n${truncated}`;
    await this.#push(notification);
  }

  async #sendHeartbeat(elapsedSec) {
    if (!this.#chatId) return;
    const elapsed = elapsedSec ?? Math.floor((Date.now() - this.#lastActivityTime) / 1000);
    await this.#push(`⏳ 模型处理中... (${elapsed}s)`, 'heartbeat');
  }

  async #sendHeartbeatDone() {
    await this.#push('✅ 模型处理完成', 'heartbeat-done');
  }

  async #push(notification, toolName = 'thinking') {
    if (!this.#chatId) return;
    try {
      await fetch(`${this.#bridgeUrl}/tool-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, tool_name: toolName, notification }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* ignore */ }
  }
}
