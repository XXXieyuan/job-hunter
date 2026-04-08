const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AppError, ERROR_STATUS_MAP, ErrorRingBuffer, errorRingBuffer } = require('./errors');

describe('AppError', () => {
  // T-33: All 13 error codes map to correct HTTP status
  it('maps all 13 error codes to correct HTTP status', () => {
    const expected = {
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

    for (const [code, status] of Object.entries(expected)) {
      const err = new AppError(code, 'test');
      assert.equal(err.statusCode, status, `${code} should map to ${status}`);
    }
  });

  // T-29: AppError returns correct JSON envelope
  it('VALIDATION_ERROR includes details in toJSON()', () => {
    const details = [{ field: 'email', message: 'required' }];
    const err = new AppError('VALIDATION_ERROR', 'Validation failed', details);
    const json = err.toJSON();

    assert.equal(json.code, 'VALIDATION_ERROR');
    assert.equal(json.message, 'Validation failed');
    assert.deepEqual(json.details, details);
  });

  // T-30: details[] only present on VALIDATION_ERROR
  it('NOT_FOUND does not include details in toJSON()', () => {
    const err = new AppError('NOT_FOUND', 'Resource not found');
    const json = err.toJSON();

    assert.equal(json.code, 'NOT_FOUND');
    assert.equal(json.message, 'Resource not found');
    assert.equal(json.details, undefined);
  });

  it('is an instance of Error', () => {
    const err = new AppError('INTERNAL_ERROR', 'test');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AppError');
  });

  it('unknown code defaults to 500', () => {
    const err = new AppError('UNKNOWN_CODE', 'test');
    assert.equal(err.statusCode, 500);
  });
});

describe('ErrorRingBuffer', () => {
  // T-34: Error ring buffer stores entries for admin viewer
  it('stores entries up to max size', () => {
    const buf = new ErrorRingBuffer(5);

    for (let i = 0; i < 7; i++) {
      buf.push({ message: `error-${i}`, timestamp: new Date().toISOString() });
    }

    assert.equal(buf.total, 5);
    const entries = buf.getEntries(10);
    assert.equal(entries.length, 5);
    // Most recent first
    assert.equal(entries[0].message, 'error-6');
    assert.equal(entries[4].message, 'error-2');
  });

  it('getEntries respects limit param (max 200)', () => {
    const buf = new ErrorRingBuffer(500);
    for (let i = 0; i < 100; i++) {
      buf.push({ message: `error-${i}` });
    }

    const entries = buf.getEntries(10);
    assert.equal(entries.length, 10);

    // Requesting > 200 caps at 200
    const capped = buf.getEntries(300);
    assert.equal(capped.length, 100); // Only 100 entries exist
  });

  it('returns entries with each having timestamp, level, message, context', () => {
    const entry = {
      timestamp: '2026-04-08T10:00:00Z',
      level: 'error',
      message: 'test error',
      stack: 'Error: test\n  at ...',
      context: { path: '/api/test', method: 'GET', userId: 1 },
    };

    errorRingBuffer.push(entry);
    const entries = errorRingBuffer.getEntries(1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].timestamp, '2026-04-08T10:00:00Z');
    assert.equal(entries[0].level, 'error');
    assert.equal(entries[0].message, 'test error');
    assert.deepEqual(entries[0].context, { path: '/api/test', method: 'GET', userId: 1 });
  });
});
