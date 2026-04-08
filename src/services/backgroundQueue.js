const crypto = require('crypto');
const { getLogger } = require('../logger');

const logger = getLogger('backgroundQueue');

class BackgroundQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.currentTask = null;
    this.history = [];
    this.maxHistory = 100;
    this.handlers = {};
  }

  /**
   * Register a handler for a task type.
   * @param {string} type - Task type name
   * @param {function} handler - Async function that processes the task
   */
  registerHandler(type, handler) {
    this.handlers[type] = handler;
  }

  /**
   * Enqueue a background task. Tasks execute sequentially (concurrency = 1).
   * This prevents: concurrent scoring writes, AI API rate limit conflicts,
   * and SQLite write lock contention during batch operations.
   *
   * @param {string} taskType - Type of task (must match a registered handler)
   * @param {object} params - Parameters passed to the handler
   * @param {object} [meta={}] - Optional metadata (description, user info, etc.)
   * @returns {string} Task ID
   */
  enqueue(taskType, params, meta = {}) {
    const task = {
      id: crypto.randomUUID(),
      type: taskType,
      params,
      meta,
      enqueuedAt: new Date(),
      startedAt: null,
      completedAt: null,
      status: 'pending',
      error: null,
    };
    this.queue.push(task);
    logger.info('Task enqueued', {
      taskId: task.id,
      type: taskType,
      queueLength: this.queue.length,
    });
    this._processNext();
    return task.id;
  }

  /**
   * Process the next task in the queue.
   * @private
   */
  async _processNext() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    this.currentTask = this.queue.shift();
    this.currentTask.status = 'running';
    this.currentTask.startedAt = new Date();

    try {
      const handler = this.handlers[this.currentTask.type];
      if (!handler) {
        throw new Error(`Unknown task type: ${this.currentTask.type}`);
      }

      await this._executeWithRetry(handler, this.currentTask.params);

      this.currentTask.status = 'completed';
      this.currentTask.completedAt = new Date();
      logger.info('Task completed', {
        taskId: this.currentTask.id,
        type: this.currentTask.type,
        durationMs: this.currentTask.completedAt - this.currentTask.startedAt,
      });
    } catch (err) {
      this.currentTask.status = 'failed';
      this.currentTask.completedAt = new Date();
      this.currentTask.error = err.message;
      logger.error('Task failed', {
        taskId: this.currentTask.id,
        type: this.currentTask.type,
        error: err.message,
      });
    } finally {
      this._addToHistory(this.currentTask);
      this.currentTask = null;
      this.running = false;
      this._processNext();
    }
  }

  /**
   * Execute handler with retry for 429 rate limit responses.
   * Base 2s delay, max 3 retries.
   * @private
   */
  async _executeWithRetry(handler, params, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await handler(params);
      } catch (err) {
        lastError = err;
        const is429 =
          err.status === 429 ||
          err.statusCode === 429 ||
          (err.message && err.message.includes('429'));
        if (is429 && attempt < maxRetries) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          logger.warn('Rate limited (429), retrying', {
            attempt: attempt + 1,
            delayMs: delay,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * @private
   */
  _addToHistory(task) {
    this.history.unshift({
      id: task.id,
      type: task.type,
      status: task.status,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      meta: task.meta,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }
  }

  /**
   * Get current queue status.
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      currentTask: this.currentTask
        ? {
            id: this.currentTask.id,
            type: this.currentTask.type,
            startedAt: this.currentTask.startedAt,
            meta: this.currentTask.meta,
          }
        : null,
      pending: this.queue.map((t) => ({
        id: t.id,
        type: t.type,
        enqueuedAt: t.enqueuedAt,
        meta: t.meta,
      })),
    };
  }

  /**
   * Get completed/failed task history.
   * @param {number} [limit=20]
   */
  getHistory(limit = 20) {
    return this.history.slice(0, limit);
  }

  /**
   * Cancel a pending (not yet running) task.
   * @param {string} taskId
   * @returns {boolean} True if the task was found and removed
   */
  cancelTask(taskId) {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    const [removed] = this.queue.splice(idx, 1);
    removed.status = 'cancelled';
    removed.completedAt = new Date();
    this._addToHistory(removed);
    logger.info('Task cancelled', { taskId });
    return true;
  }
}

// Singleton instance
module.exports = new BackgroundQueue();
