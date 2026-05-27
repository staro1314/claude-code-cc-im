import { createLogger } from '../logger.js';
import { MAX_QUEUE_SIZE } from '../constants.js';
const log = createLogger('Queue');
export class RequestQueue {
    queues = new Map();
    /**
     * Enqueue a task for a user's conversation.
     * Same convId tasks are serialized; different convId tasks run concurrently.
     * Returns 'running' if started immediately, 'queued' if waiting, 'rejected' if full.
     */
    enqueue(userId, convId, prompt, execute) {
        const queueKey = `${userId}:${convId}`;
        let queue = this.queues.get(queueKey);
        if (!queue) {
            queue = { running: false, tasks: [] };
            this.queues.set(queueKey, queue);
        }
        if (queue.running && queue.tasks.length >= MAX_QUEUE_SIZE) {
            return 'rejected';
        }
        if (queue.running) {
            queue.tasks.push({ prompt, execute, enqueuedAt: Date.now() });
            log.info(`Queued task for ${queueKey}, position: ${queue.tasks.length}/${MAX_QUEUE_SIZE}`);
            return 'queued';
        }
        // Not running, start immediately
        queue.running = true;
        this.run(queueKey, prompt, execute);
        return 'running';
    }
    async run(queueKey, prompt, execute) {
        try {
            await execute(prompt);
        }
        catch (err) {
            log.error(`Error executing task for ${queueKey}:`, err);
        }
        const queue = this.queues.get(queueKey);
        if (!queue)
            return;
        const next = queue.tasks.shift();
        if (next) {
            const waitSec = ((Date.now() - next.enqueuedAt) / 1000).toFixed(1);
            log.info(`Dequeuing task for ${queueKey}, waited ${waitSec}s, remaining: ${queue.tasks.length}`);
            setImmediate(() => this.run(queueKey, next.prompt, next.execute));
        }
        else {
            queue.running = false;
            this.queues.delete(queueKey);
        }
    }
}
