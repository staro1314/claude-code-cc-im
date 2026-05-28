/**
 * Session File Watcher
 *
 * Monitors Claude Code session JSONL files for thinking events
 * and pushes them to the bridge server in real-time.
 *
 * This solves the limitation that MCP channel protocol doesn't expose
 * thinking events - we read them directly from the session file.
 */
import { watch } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('SessionWatcher');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export class SessionWatcher {
  /** @type {Map<string, number>} filePath → last known file size */
  #fileSizes = new Map();
  /** @type {Set<string>} UUIDs of already-sent thinking events */
  #sentUuids = new Set();
  /** @type {import('node:fs').FSWatcher | null} */
  #watcher = null;
  /** @type {NodeJS.Timeout | null} */
  #scanTimer = null;
  /** @type {string} bridge server URL */
  #bridgeUrl;
  /** @type {string} chat_id for WeChat Work */
  #chatId;
  /** @type {number} max sent UUIDs to keep (prevent memory leak) */
  #maxSentUuids = 5000;

  /**
   * @param {object} options
   * @param {string} options.bridgeUrl - Bridge server base URL (e.g. http://127.0.0.1:18790)
   * @param {string} options.chatId - WeChat Work chat_id for sending messages
   */
  constructor({ bridgeUrl, chatId }) {
    this.#bridgeUrl = bridgeUrl;
    this.#chatId = chatId;
  }

  /**
   * Start watching session files for thinking events.
   */
  async start() {
    log.info(`Watching session files in ${PROJECTS_DIR}`);

    // Initial scan to record current file sizes
    await this.#scanAllFiles();

    // Watch for file changes in the projects directory
    try {
      this.#watcher = watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const filePath = join(PROJECTS_DIR, filename);
        // Debounce: schedule a read after a short delay
        this.#scheduleRead(filePath);
      });
      log.info('Session file watcher started');
    } catch (err) {
      log.warn('Failed to watch projects directory:', err);
      // Fallback: periodic scan
      this.#scanTimer = setInterval(() => this.#scanAllFiles(), 3000);
      log.info('Using periodic scan fallback (3s interval)');
    }
  }

  /**
   * Update the chat_id for sending messages.
   */
  setChatId(chatId) {
    this.#chatId = chatId;
  }

  /**
   * Stop watching.
   */
  stop() {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
    this.#fileSizes.clear();
    this.#sentUuids.clear();
    log.info('Session watcher stopped');
  }

  /** @type {Map<string, NodeJS.Timeout>} */
  #pendingReads = new Map();

  #scheduleRead(filePath) {
    // Clear existing timer for this file
    const existing = this.#pendingReads.get(filePath);
    if (existing) clearTimeout(existing);

    // Schedule read after 150ms debounce
    this.#pendingReads.set(filePath, setTimeout(() => {
      this.#pendingReads.delete(filePath);
      this.#readNewLines(filePath).catch(() => {});
    }, 150));
  }

  /**
   * Scan all JSONL files to record their current sizes.
   */
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
            } catch { /* file may have been deleted */ }
          }
        } catch { /* permission error etc */ }
      }
    } catch (err) {
      log.debug('Scan error:', err);
    }
  }

  /**
   * Read new lines from a file since last known position.
   */
  async #readNewLines(filePath) {
    const lastSize = this.#fileSizes.get(filePath) ?? 0;
    let currentSize;
    try {
      const s = await stat(filePath);
      currentSize = s.size;
    } catch {
      return;
    }

    if (currentSize <= lastSize) return;

    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      await fh.read(buf, 0, buf.length, lastSize);
      this.#fileSizes.set(filePath, currentSize);

      const newContent = buf.toString('utf-8');
      const lines = newContent.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'thinking' && event.uuid) {
            await this.#handleThinkingEvent(event);
          }
        } catch { /* skip malformed lines */ }
      }
    } catch (err) {
      log.debug(`Read error for ${filePath}:`, err);
    } finally {
      await fh?.close();
    }
  }

  /**
   * Handle a thinking event: extract text and push to bridge.
   */
  async #handleThinkingEvent(event) {
    // Deduplicate
    if (this.#sentUuids.has(event.uuid)) return;
    this.#sentUuids.add(event.uuid);

    // Prevent memory leak
    if (this.#sentUuids.size > this.#maxSentUuids) {
      const first = this.#sentUuids.values().next().value;
      if (first !== undefined) this.#sentUuids.delete(first);
    }

    // Extract thinking text
    const thinking = event.message?.content?.[0]?.thinking;
    if (!thinking) return;

    const elapsed = event.timestamp
      ? ` (${new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`
      : '';

    // Format for WeChat Work (markdown)
    const maxLen = 500;
    const truncated = thinking.length > maxLen ? thinking.slice(0, maxLen) + '...' : thinking;
    const notification = `🧠 **模型思考**${elapsed}\n\n${truncated}`;

    // Push to bridge (fire-and-forget)
    if (!this.#chatId) return;
    try {
      const res = await fetch(`${this.#bridgeUrl}/tool-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.#chatId,
          tool_name: 'thinking',
          notification,
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        log.debug(`Bridge push failed: ${res.status}`);
      }
    } catch (err) {
      log.debug(`Bridge push error: ${err.message}`);
    }
  }
}
