/**
 * Session File Watcher (Polling-based)
 *
 * Uses polling instead of fs.watch (unreliable on Windows).
 * Monitors ALL Claude Code session JSONL files for thinking events.
 * Thinking events have unique UUIDs for deduplication.
 * Also manages the heartbeat (loading indicator).
 */
import { readFileSync } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('SessionWatcher');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const POLL_INTERVAL = 1000; // 1 second for better streaming feel

export class SessionWatcher {
  /** @type {Map<string, number>} filePath → last known file size */
  #fileSizes = new Map();
  /** @type {Set<string>} UUIDs of already-sent events */
  #sentUuids = new Set();
  /** @type {NodeJS.Timeout | null} */
  #pollTimer = null;
  #bridgeUrl;
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
    // Initial scan to record current file sizes
    await this.#scanAllFiles();
    log.info(`Session watcher started (polling ${POLL_INTERVAL}ms, tracking ${this.#fileSizes.size} files)`);

    // Poll for changes
    this.#pollTimer = setInterval(() => this.#poll(), POLL_INTERVAL);
    this.#pollTimer.unref();
  }

  setChatId(chatId) { this.#chatId = chatId; }

  stop() {
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null; }
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

  async #poll() {
    // Discover new files
    await this.#scanAllFiles();
    // Check each tracked file for size changes
    let changedCount = 0;
    for (const [filePath, lastSize] of this.#fileSizes) {
      try {
        const s = await stat(filePath);
        if (s.size > lastSize) {
          changedCount++;
          await this.#readNewLines(filePath, lastSize);
          this.#fileSizes.set(filePath, s.size);
        }
      } catch { /* file deleted */ }
    }
    if (changedCount > 0) log.debug(`Poll: ${changedCount} files changed`);
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
            if (!this.#fileSizes.has(filePath)) {
              try {
                const s = await stat(filePath);
                this.#fileSizes.set(filePath, s.size);
              } catch { /* deleted */ }
            }
          }
        } catch { /* permission */ }
      }
    } catch (err) { log.debug('Scan error:', err); }
  }

  async #readNewLines(filePath, lastSize) {
    let fh;
    try {
      fh = await open(filePath, 'r');
      const s = await fh.stat();
      const buf = Buffer.alloc(s.size - lastSize);
      await fh.read(buf, 0, buf.length, lastSize);

      this.#startHeartbeat();

      const lines = buf.toString('utf-8').split('\n');
      let thinkingFound = 0;
      let textFound = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.uuid && !this.#sentUuids.has(event.uuid)) {
            const content = event.message?.content;
            if (!Array.isArray(content)) continue;
            const thinking = content.find(b => b.type === 'thinking')?.thinking;
            if (thinking) {
              thinkingFound++;
              await this.#handleThinkingEvent(event, thinking);
            }
            const textBlocks = content.filter(b => b.type === 'text' && b.text);
            if (textBlocks.length > 0) {
              textFound++;
              await this.#handleTextEvent(event, textBlocks);
            }
          }
        } catch { /* malformed */ }
      }
      if (thinkingFound > 0) log.info(`Pushed ${thinkingFound} thinking events`);
      if (textFound > 0) log.info(`Pushed ${textFound} text events`);
    } catch (err) { log.debug(`Read error: ${err.message}`); }
    finally { await fh?.close(); }
  }

  async #handleThinkingEvent(event, thinkingText) {
    this.#sentUuids.add(event.uuid);
    if (this.#sentUuids.size > this.#maxSentUuids) {
      const first = this.#sentUuids.values().next().value;
      if (first !== undefined) this.#sentUuids.delete(first);
    }
    const thinking = thinkingText || event.message?.content?.find?.(b => b.type === 'thinking')?.thinking;
    if (!thinking) return;
    const elapsed = event.timestamp
      ? ` (${new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`
      : '';
    const maxLen = 500;
    const truncated = thinking.length > maxLen ? thinking.slice(0, maxLen) + '...' : thinking;
    const notification = `🧠 **模型思考**${elapsed}\n\n${truncated}`;
    await this.#push(notification);
  }

  async #handleTextEvent(event, textBlocks) {
    this.#sentUuids.add(event.uuid);
    if (this.#sentUuids.size > this.#maxSentUuids) {
      const first = this.#sentUuids.values().next().value;
      if (first !== undefined) this.#sentUuids.delete(first);
    }
    const fullText = textBlocks.map(b => b.text).join('\n');
    if (!fullText.trim()) return;
    const elapsed = event.timestamp
      ? ` (${new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`
      : '';
    const maxLen = 1500;
    const truncated = fullText.length > maxLen ? fullText.slice(0, maxLen) + '...' : fullText;
    const notification = `💬 **模型回复**${elapsed}\n\n${truncated}`;
    await this.#push(notification, 'text');
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
