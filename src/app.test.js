const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('./utils/errors');

// Test that the error module and its exports are correct
describe('Error handling integration', () => {
  // T-29: AppError returns correct JSON envelope for API paths
  it('AppError VALIDATION_ERROR produces correct JSON', () => {
    const details = [{ field: 'email', message: 'required' }];
    const err = new AppError('VALIDATION_ERROR', 'Validation failed', details);

    assert.equal(err.statusCode, 400);
    const json = err.toJSON();
    assert.deepEqual(json, {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: [{ field: 'email', message: 'required' }],
    });
  });

  // T-30: details[] only present on VALIDATION_ERROR
  it('non-VALIDATION_ERROR AppError omits details', () => {
    const err = new AppError('NOT_FOUND', 'Not found');
    const json = err.toJSON();
    assert.equal(json.code, 'NOT_FOUND');
    assert.equal(json.message, 'Not found');
    assert.equal('details' in json, false);
  });

  // T-31: 500 error never exposes stack traces
  it('INTERNAL_ERROR does not include stack in toJSON', () => {
    const err = new AppError('INTERNAL_ERROR', 'An unexpected error occurred');
    const json = err.toJSON();
    assert.equal(json.code, 'INTERNAL_ERROR');
    assert.equal('stack' in json, false);
  });

  // T-33: All 13 error codes map to correct HTTP status
  it('all 13 error codes have correct HTTP status', () => {
    const mapping = [
      ['VALIDATION_ERROR', 400],
      ['RESUME_NOT_CONFIRMED', 400],
      ['INVALID_FILE_TYPE', 400],
      ['FILE_TOO_LARGE', 400],
      ['AUTHENTICATION_REQUIRED', 401],
      ['SESSION_EXPIRED', 401],
      ['INVALID_CREDENTIALS', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['SCORE_NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['RATE_LIMITED', 429],
      ['INTERNAL_ERROR', 500],
    ];

    for (const [code, expectedStatus] of mapping) {
      const err = new AppError(code, 'test');
      assert.equal(err.statusCode, expectedStatus, `${code} -> ${expectedStatus}`);
    }
  });
});

// Test that require('./src/app') works without errors
describe('App module loading', () => {
  it('require("./app") does not throw', () => {
    assert.doesNotThrow(() => {
      require('./app');
    });
  });
});
