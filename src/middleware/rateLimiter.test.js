const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimiter, companyResearchLimiter, batchCompanyResearchLimiter, resumeOverrideLimiter, _store } = require('./rateLimiter');

function createMockReq(overrides = {}) {
  return {
    ip: '127.0.0.1',
    user: null,
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.jsonBody = body;
      return res;
    },
    set(key, value) {
      res.headers[key] = value;
      return res;
    },
  };
  return res;
}

describe('rateLimiter', () => {
  beforeEach(() => {
    _store.clear();
  });

  it('allows requests within limit', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 3, scope: 'ip', prefix: 'test1' });
    let nextCount = 0;

    for (let i = 0; i < 3; i++) {
      const req = createMockReq();
      const res = createMockRes();
      limiter(req, res, () => { nextCount++; });
    }

    assert.equal(nextCount, 3);
  });

  it('returns 429 when limit exceeded with Retry-After header', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 2, scope: 'ip', prefix: 'test2' });

    // Use up the limit
    for (let i = 0; i < 2; i++) {
      const req = createMockReq();
      const res = createMockRes();
      limiter(req, res, () => {});
    }

    // This one should be rate limited
    const req = createMockReq();
    const res = createMockRes();
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['Retry-After']);
    const retryAfter = parseInt(res.headers['Retry-After'], 10);
    assert.ok(retryAfter > 0);
    assert.ok(retryAfter <= 60);
    assert.equal(res.jsonBody.error.code, 'RATE_LIMITED');
  });

  it('supports user scope', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 2, scope: 'user', prefix: 'test3' });

    // User 1 uses their limit
    for (let i = 0; i < 2; i++) {
      const req = createMockReq({ user: { id: 1 } });
      const res = createMockRes();
      limiter(req, res, () => {});
    }

    // User 1 is rate limited
    const req1 = createMockReq({ user: { id: 1 } });
    const res1 = createMockRes();
    let next1 = false;
    limiter(req1, res1, () => { next1 = true; });
    assert.equal(next1, false);
    assert.equal(res1.statusCode, 429);

    // User 2 is not rate limited
    const req2 = createMockReq({ user: { id: 2 } });
    const res2 = createMockRes();
    let next2 = false;
    limiter(req2, res2, () => { next2 = true; });
    assert.ok(next2);
  });

  it('supports global scope', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 2, scope: 'global', prefix: 'test4' });

    // Different IPs hit the same global counter
    for (let i = 0; i < 2; i++) {
      const req = createMockReq({ ip: `192.168.1.${i}` });
      const res = createMockRes();
      limiter(req, res, () => {});
    }

    const req = createMockReq({ ip: '10.0.0.1' });
    const res = createMockRes();
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
  });

  it('sets X-RateLimit-Limit and X-RateLimit-Remaining headers', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 10, scope: 'ip', prefix: 'test5' });
    const req = createMockReq();
    const res = createMockRes();
    limiter(req, res, () => {});

    assert.equal(res.headers['X-RateLimit-Limit'], '10');
    assert.equal(res.headers['X-RateLimit-Remaining'], '9');
  });

  // T-117: Counters are in-memory (reset on store clear / restart)
  it('counters reset when store is cleared (T-117)', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 1, scope: 'ip', prefix: 'test-reset' });

    const req1 = createMockReq();
    const res1 = createMockRes();
    limiter(req1, res1, () => {});

    // Should be rate limited
    const req2 = createMockReq();
    const res2 = createMockRes();
    limiter(req2, res2, () => {});
    assert.equal(res2.statusCode, 429);

    // Clear store (simulates server restart)
    _store.clear();

    // Same IP should now be allowed
    const req3 = createMockReq();
    const res3 = createMockRes();
    let nextCalled = false;
    limiter(req3, res3, () => { nextCalled = true; });
    assert.ok(nextCalled, 'Should be allowed after store clear');
    assert.equal(res3.statusCode, 200);
  });

  it('retryAfter is an integer in seconds', () => {
    const limiter = rateLimiter({ windowMs: 60000, max: 1, scope: 'ip', prefix: 'test6' });

    const req1 = createMockReq();
    const res1 = createMockRes();
    limiter(req1, res1, () => {});

    const req2 = createMockReq();
    const res2 = createMockRes();
    limiter(req2, res2, () => {});

    const retryAfter = parseInt(res2.headers['Retry-After'], 10);
    assert.equal(retryAfter, Math.ceil(retryAfter)); // Must be integer
    assert.ok(retryAfter > 0);
  });

  // T-12: Company research rate limiter instances
  describe('companyResearchLimiter', () => {
    it('is exported as a function', () => {
      assert.equal(typeof companyResearchLimiter, 'function');
    });

    it('allows 10 requests then returns 429 with flat error shape', () => {
      let passedCount = 0;

      for (let i = 0; i < 10; i++) {
        const req = createMockReq({ ip: '10.10.10.10' });
        const res = createMockRes();
        companyResearchLimiter(req, res, () => { passedCount++; });
      }
      assert.equal(passedCount, 10);

      // 11th request should be rate limited
      const req = createMockReq({ ip: '10.10.10.10' });
      const res = createMockRes();
      let nextCalled = false;
      companyResearchLimiter(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 429);
      // Flat error shape: { error: "string" }, not { error: { code, message } }
      assert.equal(typeof res.jsonBody.error, 'string', 'error should be a flat string');
      assert.ok(res.headers['Retry-After']);
    });
  });

  // T-E.2: Resume override rate limiter (30 req/min per IP)
  describe('resumeOverrideLimiter', () => {
    it('is exported as a function', () => {
      assert.equal(typeof resumeOverrideLimiter, 'function');
    });

    it('allows 30 requests then returns 429', () => {
      let passedCount = 0;

      for (let i = 0; i < 30; i++) {
        const req = createMockReq({ ip: '30.30.30.30' });
        const res = createMockRes();
        resumeOverrideLimiter(req, res, () => { passedCount++; });
      }
      assert.equal(passedCount, 30);

      // 31st request should be rate limited
      const req = createMockReq({ ip: '30.30.30.30' });
      const res = createMockRes();
      let nextCalled = false;
      resumeOverrideLimiter(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 429);
      assert.ok(res.headers['Retry-After']);
      // Nested error shape (default)
      assert.equal(typeof res.jsonBody.error, 'object');
      assert.equal(res.jsonBody.error.code, 'RATE_LIMITED');
    });

    it('different IPs have independent counters', () => {
      // Fill up IP A
      for (let i = 0; i < 30; i++) {
        const req = createMockReq({ ip: '40.40.40.40' });
        const res = createMockRes();
        resumeOverrideLimiter(req, res, () => {});
      }

      // IP B should still be allowed
      const req = createMockReq({ ip: '50.50.50.50' });
      const res = createMockRes();
      let nextCalled = false;
      resumeOverrideLimiter(req, res, () => { nextCalled = true; });
      assert.ok(nextCalled);
    });
  });

  describe('batchCompanyResearchLimiter', () => {
    it('is exported as a function', () => {
      assert.equal(typeof batchCompanyResearchLimiter, 'function');
    });

    it('allows 2 requests then returns 429 with nested error shape', () => {
      let passedCount = 0;

      for (let i = 0; i < 2; i++) {
        const req = createMockReq({ ip: '20.20.20.20' });
        const res = createMockRes();
        batchCompanyResearchLimiter(req, res, () => { passedCount++; });
      }
      assert.equal(passedCount, 2);

      // 3rd request should be rate limited
      const req = createMockReq({ ip: '20.20.20.20' });
      const res = createMockRes();
      let nextCalled = false;
      batchCompanyResearchLimiter(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 429);
      // Nested error shape (default): { error: { code, message } }
      assert.equal(typeof res.jsonBody.error, 'object', 'error should be nested object');
      assert.equal(res.jsonBody.error.code, 'RATE_LIMITED');
      assert.ok(res.headers['Retry-After']);
    });
  });
});
