'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Tests for T-B.1: SMTP and alert configuration

describe('Config — SMTP and Alert env vars (T-B.1)', () => {
  it('exports all SMTP and alert config with correct defaults', () => {
    // Require config — env vars are not set so defaults apply
    const config = require('./index');

    assert.equal(config.SMTP_HOST, '', 'SMTP_HOST defaults to empty string');
    assert.equal(config.SMTP_PORT, 587, 'SMTP_PORT defaults to 587');
    assert.equal(config.SMTP_USER, '', 'SMTP_USER defaults to empty string');
    assert.equal(config.SMTP_PASS, '', 'SMTP_PASS defaults to empty string');
    assert.equal(config.SMTP_SECURE, true, 'SMTP_SECURE defaults to true');
    assert.equal(config.EMAIL_FROM, '', 'EMAIL_FROM defaults to empty string');
    assert.equal(config.EMAIL_ENABLED, false, 'EMAIL_ENABLED defaults to false');
    assert.equal(config.APP_BASE_URL, `http://localhost:${config.PORT}`, 'APP_BASE_URL defaults to http://localhost:PORT');
  });

  it('all existing config keys still present', () => {
    const config = require('./index');
    const existingKeys = [
      'PORT', 'DB_PATH', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'OPENAI_EMBEDDING_MODEL', 'OPENAI_CHAT_MODEL', 'ADMIN_TOKEN',
      'NODE_ENV', 'LOG_LEVEL', 'BCRYPT_ROUNDS', 'SESSION_MAX_AGE',
      'SESSION_MAX_PER_USER', 'SCRAPER_TIMEOUT_MS', 'SCRAPER_RATE_LIMIT_MS',
      'SCRAPER_MAX_PAGES', 'PYTHON_PATH', 'RESUME_MAX_SIZE_BYTES', 'RESUME_UPLOAD_DIR',
    ];
    for (const key of existingKeys) {
      assert.ok(key in config, `config should export ${key}`);
    }
  });
});
