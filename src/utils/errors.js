'use strict';

/**
 * Error code to HTTP status mapping.
 * All 13 error codes from INTERFACE_CONTRACT.md.
 */
const ERROR_STATUS_MAP = {
  VALIDATION_ERROR: 400,
  RESUME_NOT_CONFIRMED: 400,
  INVALID_FILE_TYPE: 400,
  FILE_TOO_LARGE: 400,
  AUTHENTICATION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SCORE_NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

class AppError extends Error {
  /**
   * @param {string} code - One of the 13 error codes
   * @param {string} message - Human-readable message
   * @param {Array} [details] - Per-field validation errors (VALIDATION_ERROR only)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS_MAP[code] || 500;
    if (code === 'VALIDATION_ERROR' && details) {
      this.details = details;
    }
  }

  toJSON() {
    const obj = { code: this.code, message: this.message };
    if (this.code === 'VALIDATION_ERROR' && this.details) {
      obj.details = this.details;
    }
    return obj;
  }
}

/**
 * In-memory ring buffer for error entries (admin error viewer).
 * Stores up to ~500 entries. Resets on server restart.
 */
class ErrorRingBuffer {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.buffer = [];
  }

  push(entry) {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  getEntries(limit = 50) {
    const max = Math.min(limit, 200);
    return this.buffer.slice(-max).reverse();
  }

  get total() {
    return this.buffer.length;
  }
}

const errorRingBuffer = new ErrorRingBuffer(500);

module.exports = {
  AppError,
  ERROR_STATUS_MAP,
  ErrorRingBuffer,
  errorRingBuffer,
};
