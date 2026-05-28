/**
 * Session File Watcher
 *
 * Monitors the ACTIVE Claude Code session JSONL file for thinking events
 * and pushes them to the bridge server in real-time.
 *
 * Only watches the file identified by ~/.cc-im/active-transcript
 * (written by hook-script.js) to prevent cross-talk between sessions.
 */
import { watch, readFileSync } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('SessionWatcher');
const APP_HOME = join(homedir(), '.cc-im');
const ACTIVE_TRANSCRIPT_FILE = join(APP_HOME, 'active-transcript');

export class SessionWatcher {
  /** @type {string|null} absolute path to the target session file */
  #targetFile = null;
  /** @type {number} last known file size of target */
  #lastSize = 0;
  /** @type {Set<string>} UUIDs of already-sent thinking events */
  #sentUuids = new Set();
  /** @type {import('node:fs').FSWatcher | null} */
  #watcher = null;
  /** @type {NodeJS.Timeout | null} */
  #pollTimer = null;
  /** @type {string} bridge server URL */
  #bridgeUrl;
  /** @type {string} chat_id for WeChat Work */
  #chatId;
  #maxSentUuids = 5000;
  /** @type {NodeJS.Timeout | null} heartbeat timer */
  #heartbeatTimer = null;
  /** @type {number} last time session file was modified */
  #lastActivityTime = 0;
  /** @type {number} heartbeat interval in ms */
  #heartbeatInterval = 30_000;

  constructor({ bridgeUrl, chatId }) {
    this.#bridgeUrl = bridgeUrl;
    this.#chatId = chatId;
  }

  /**
   * Start watching. Reads active-transcript to find the target file.
   */
  async start() {
    // Try to read the target file path from hook-script's output
    this.#loadTargetFile();

    // Poll for target file changes (new sessions, new hook invocations)
    this.#pollTimer = setInterval(() => this.#loadTargetFile(), 5000);
    this.#pollTimer.unref();

    // If we have a target, start watching it
    if (this.#targetFile) {
      this.#watchTarget();
    }

    log.info(`Session watcher started (target: ${this.#targetFile ?? 'waiting for first hook invocation'})`);
  }

  setChatId(chatId) {
    this.#chatId = chatId;
  }

  stop() {
    if (this.#watcher) { this.#watcher.close(); this.#watcher = null; }
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
    if (this.#heartbeatTimer) return; // already running
    // 首次立即发送心跳
    this.#sendHeartbeat(0);
    // 之后每 30 秒更新
    this.#heartbeatTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.#lastActivityTime) / 1000);
      if (elapsed > 60) {
        // 超过 60 秒无活动，模型空闲，发送完成并停止
        this.#sendHeartbeatDone();
        this.#clearHeartbeat();
        return;
      }
      this.#sendHeartbeat(elapsed);
    }, this.#heartbeatInterval);
    this.#heartbeatTimer.unref();
  }

  async #sendHeartbeat(elapsedSec) {
    if (!this.#chatId) return;
    const elapsed = elapsedSec ?? Math.floor((Date.now() - this.#lastActivityTime) / 1000);
    const notification = `⏳ 模型处理中... (${elapsed}s)`;
    try {
      await fetch(`${this.#bridgeUrl}/tool-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, tool_name: 'heartbeat', notification }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* ignore */ }
  }

  async #sendHeartbeatDone() {
    if (!this.#chatId) return;
    try {
      await fetch(`${this.#bridgeUrl}/tool-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, tool_name: 'heartbeat-done', notification: '✅ 模型处理完成' }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* ignore */ }
  }

  /**
   * Read active-transcript file to get/update the target session file path.
   */
  #loadTargetFile() {
    try {
      const newPath = readFileSync(ACTIVE_TRANSCRIPT_FILE, 'utf-8').trim();
      if (newPath && newPath !== this.#targetFile) {
        // Target changed — reset size tracking and re-watch
        this.#targetFile = newPath;
        this.#lastSize = 0;
        this.#sentUuids.clear();
        this.#watchTarget();
        log.info(`Session target updated: ${newPath}`);
      }
    } catch {
      // File doesn't exist yet — wait for hook-script to create it
    }
  }

  /**
   * Start or restart fs.watch on the target file.
   */
  #watchTarget() {
    if (!this.#targetFile) return;
    if (this.#watcher) { this.#watcher.close(); this.#watcher = null; }

    try {
      this.#watcher = watch(this.#targetFile, () => {
        this.#readNewLines().catch(() => {});
      });
      this.#watcher.on('error', () => {
        // File might have been recreated — will be picked up by pollTimer
        this.#watcher = null;
      });
      log.debug(`Watching: ${this.#targetFile}`);
    } catch (err) {
      log.debug(`Watch setup failed for ${this.#targetFile}: ${err.message}`);
    }
  }

  /**
   * Read new lines from the target file and extract thinking events.
   */
  async #readNewLines() {
    if (!this.#targetFile) return;
    let currentSize;
    try {
      const s = await stat(this.#targetFile);
      currentSize = s.size;
    } catch { return; }

    if (currentSize <= this.#lastSize) return;

    // 文件有新内容 → 模型在活跃，启动/刷新心跳
    this.#startHeartbeat();

    let fh;
    try {
      fh = await open(this.#targetFile, 'r');
      const buf = Buffer.alloc(currentSize - this.#lastSize);
      await fh.read(buf, 0, buf.length, this.#lastSize);
      this.#lastSize = currentSize;

      const lines = buf.toString('utf-8').split('\n');
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
      log.debug(`Read error: ${err.message}`);
    } finally {
      await fh?.close();
    }
  }

  async #handleThinkingEvent(event) {
    if (this.#sentUuids.has(event.uuid)) return;
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

    if (!this.#chatId) return;
    try {
      await fetch(`${this.#bridgeUrl}/tool-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, tool_name: 'thinking', notification }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* ignore */ }
  }
}
