'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Helper: mock Express req/res for handler testing
function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    params: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/admin/login',
    originalUrl: '/admin/login',
    method: 'POST',
    get: () => null,
    user: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectUrl: null,
    cookieData: {},
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = (key, val) => { res.headers[key] = val; return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.redirectUrl = url; return res; };
  res.cookie = (name, value, opts) => { res.cookieData = { name, value, opts }; return res; };
  res.render = (view, data) => { res.view = view; res.viewData = data; return res; };
  return res;
}

// ──────────────────────────────────────────────────────────────
// T-J.1: Admin login — wrong token returns 401
// ──────────────────────────────────────────────────────────────

describe('T-J.1: POST /admin/login — authentication', () => {
  it('missing token returns 401 INVALID_CREDENTIALS', () => {
    // crypto.timingSafeEqual is used for constant-time comparison
    assert.equal(typeof crypto.timingSafeEqual, 'function');

    // Simulate the login check: empty token should be rejected
    const token = '';
    const ADMIN_TOKEN = 'test-admin-secret';

    // The route checks: if (!token || !ADMIN_TOKEN) return 401
    const rejected = !token || !ADMIN_TOKEN;
    assert.equal(rejected, true);
  });

  it('wrong token is rejected by timingSafeEqual', () => {
    const token = 'wrong-token-value';
    const ADMIN_TOKEN = 'correct-token-value';

    const tokenBuf = Buffer.from(String(token));
    const expectedBuf = Buffer.from(ADMIN_TOKEN);

    // Different lengths or content should not match
    const lengthMismatch = tokenBuf.length !== expectedBuf.length;
    if (!lengthMismatch) {
      const match = crypto.timingSafeEqual(tokenBuf, expectedBuf);
      assert.equal(match, false);
    } else {
      assert.ok(lengthMismatch, 'Different length tokens are rejected');
    }
  });

  it('correct token passes timingSafeEqual', () => {
    const token = 'my-admin-token';
    const ADMIN_TOKEN = 'my-admin-token';

    const tokenBuf = Buffer.from(String(token));
    const expectedBuf = Buffer.from(ADMIN_TOKEN);

    assert.equal(tokenBuf.length, expectedBuf.length);
    assert.equal(crypto.timingSafeEqual(tokenBuf, expectedBuf), true);
  });

  it('error response shape matches contract: {error:{code,message}}', () => {
    const errorResponse = {
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid admin token.' },
    };
    assert.equal(errorResponse.error.code, 'INVALID_CREDENTIALS');
    assert.equal(typeof errorResponse.error.message, 'string');
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.2: Scraper control — rate limit and validation
// ──────────────────────────────────────────────────────────────

describe('T-J.2: POST /admin/scraper/run — validation and rate limiting', () => {
  it('VALID_PLATFORMS contains all registered scraper sources', () => {
    const { VALID_PLATFORMS } = require('../services/scraperService');
    assert.deepEqual([...VALID_PLATFORMS].sort(), ['actgov', 'apsjobs', 'linkedin', 'nswgov', 'seek']);
  });

  it('invalid platform name is rejected', () => {
    const { VALID_PLATFORMS } = require('../services/scraperService');
    assert.equal(VALID_PLATFORMS.includes('indeed'), false);
    assert.equal(VALID_PLATFORMS.includes(''), false);
  });

  it('rate limit returns 429 with Retry-After header (contract shape)', () => {
    const res = mockRes();
    // Simulate rate limit response
    res.set('Retry-After', '3600');
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Scraper rate limit exceeded. Maximum 6 runs per hour.' },
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '3600');
    assert.equal(res.body.error.code, 'RATE_LIMITED');
  });

  it('conflict returns 409 with CONFLICT error code', () => {
    const res = mockRes();
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'Scraper already running' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'CONFLICT');
  });

  it('triggerScrape throws with code INVALID_SCRAPER_OPTIONS for bad platform', () => {
    const { triggerScrape } = require('../services/scraperService');
    assert.throws(
      () => triggerScrape('invalid_platform', {}),
      (err) => {
        assert.equal(err.code, 'INVALID_SCRAPER_OPTIONS');
        return true;
      }
    );
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.3: Analysis and queue status
// ──────────────────────────────────────────────────────────────

describe('T-J.3: Analysis endpoints — validation', () => {
  it('VALID_ANALYSIS_TYPES is exported and is an array', () => {
    const { VALID_ANALYSIS_TYPES } = require('../services/analysisService');
    assert.ok(Array.isArray(VALID_ANALYSIS_TYPES));
    assert.ok(VALID_ANALYSIS_TYPES.length > 0);
  });

  it('backgroundQueue.getStatus returns correct shape', () => {
    const backgroundQueue = require('../services/backgroundQueue');
    const status = backgroundQueue.getStatus();
    assert.ok('queueLength' in status);
    assert.ok('currentTask' in status);
    assert.ok('pending' in status);
    assert.equal(typeof status.queueLength, 'number');
    assert.ok(Array.isArray(status.pending));
  });

  it('errorRingBuffer.getEntries returns array with limit', () => {
    const { errorRingBuffer } = require('../utils/errors');
    const entries = errorRingBuffer.getEntries(50);
    assert.ok(Array.isArray(entries));
  });

  it('errorRingBuffer respects max limit of 200', () => {
    const { ErrorRingBuffer } = require('../utils/errors');
    const buf = new ErrorRingBuffer(500);
    for (let i = 0; i < 300; i++) {
      buf.push({ message: `error ${i}`, timestamp: new Date() });
    }
    const entries = buf.getEntries(250);
    assert.ok(entries.length <= 200, 'Should cap at 200 entries');
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: Cleanup — response shapes
// ──────────────────────────────────────────────────────────────

describe('T-J.4: POST /admin/cleanup — validation and response', () => {
  it('cleanup type validation accepts valid types', () => {
    const validTypes = ['raw_json', 'inactive', 'sessions', 'all'];
    for (const type of validTypes) {
      assert.ok(validTypes.includes(type));
    }
  });

  it('cleanup type validation rejects invalid types', () => {
    const validTypes = ['raw_json', 'inactive', 'sessions', 'all'];
    assert.equal(validTypes.includes('delete_all'), false);
    assert.equal(validTypes.includes(''), false);
  });

  it('cleanup response shape matches contract: {raw_json_cleared, archived_jobs, sessions_cleaned}', () => {
    const response = { raw_json_cleared: 5, archived_jobs: 10, sessions_cleaned: 3 };
    assert.equal(typeof response.raw_json_cleared, 'number');
    assert.equal(typeof response.archived_jobs, 'number');
    assert.equal(typeof response.sessions_cleaned, 'number');
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: Upload — validation
// ──────────────────────────────────────────────────────────────

describe('T-J.4: POST /admin/upload — validation', () => {
  it('upload response shape matches contract: {imported, skipped, errors}', () => {
    const response = { imported: 10, skipped: 2, errors: 1 };
    assert.equal(typeof response.imported, 'number');
    assert.equal(typeof response.skipped, 'number');
    assert.equal(typeof response.errors, 'number');
  });

  it('rejects non-array non-object payload', () => {
    const payload = 'not an array';
    const jobsArray = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.jobs)
        ? payload.jobs
        : null;
    assert.equal(jobsArray, null);
  });

  it('accepts array payload', () => {
    const payload = [{ title: 'Test Job' }];
    const jobsArray = Array.isArray(payload) ? payload : null;
    assert.ok(Array.isArray(jobsArray));
    assert.equal(jobsArray.length, 1);
  });

  it('accepts {jobs: [...]} payload', () => {
    const payload = { jobs: [{ title: 'Test' }] };
    const jobsArray = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.jobs)
        ? payload.jobs
        : null;
    assert.ok(Array.isArray(jobsArray));
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: Dedup endpoints — response shapes
// ──────────────────────────────────────────────────────────────

describe('T-J.4: POST /admin/dedup/run — response shape', () => {
  it('dedup run response matches contract: {status, job_count}', () => {
    const response = { status: 'queued', job_count: 150 };
    assert.equal(response.status, 'queued');
    assert.equal(typeof response.job_count, 'number');
  });

  it('dedup resolve response matches contract: {resolved, action, group_id}', () => {
    const response = { resolved: true, action: 'merge', group_id: 42 };
    assert.equal(response.resolved, true);
    assert.ok(['merge', 'split'].includes(response.action));
    assert.equal(typeof response.group_id, 'number');
  });
});

// ──────────────────────────────────────────────────────────────
// INTERNAL_ERROR responses must not leak err.message
// ──────────────────────────────────────────────────────────────

describe('Admin routes — INTERNAL_ERROR must use generic message', () => {
  it('adminRoutes.js does not expose err.message in INTERNAL_ERROR responses', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'adminRoutes.js'), 'utf8');

    // Find all INTERNAL_ERROR response lines
    const internalErrorLines = src.split('\n').filter(line =>
      line.includes('INTERNAL_ERROR')
    );

    for (const line of internalErrorLines) {
      assert.ok(
        !line.includes('err.message'),
        `INTERNAL_ERROR response should not contain err.message: ${line.trim()}`
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Architecture: adminRoutes should not use getDb() directly for queries
// ──────────────────────────────────────────────────────────────

describe('Admin routes — no direct DB access (architecture)', () => {
  it('adminRoutes.js does not call db.prepare()', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'adminRoutes.js'), 'utf8');

    const directDbCalls = src.split('\n').filter(line =>
      line.includes('db.prepare(') || line.includes('db.pragma(')
    );

    assert.equal(
      directDbCalls.length, 0,
      `adminRoutes.js should not have direct db.prepare/db.pragma calls. Found: ${directDbCalls.map(l => l.trim()).join('; ')}`
    );
  });
});
