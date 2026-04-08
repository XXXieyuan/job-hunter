const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Set ADMIN_TOKEN before any module that reads config is loaded
process.env.ADMIN_TOKEN = 'test-admin-token-12345';

// Require the real authService so we can mock its validateSession method
const authService = require('../services/authService');

// Import the REAL middleware exports — these are the functions under test
const { optionalAuth, requireAuth, requireAdmin, csrfProtection } = require('./auth');

function createMockReq(overrides = {}) {
  return {
    cookies: {},
    path: '/api/test',
    originalUrl: '/api/test',
    method: 'GET',
    user: null,
    get(header) {
      const headers = overrides.headers || {};
      return headers[header] || headers[header.toLowerCase()] || undefined;
    },
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    locals: {},
    redirectUrl: null,
    jsonBody: null,
    clearedCookies: [],
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.jsonBody = body;
      return res;
    },
    redirect(url) {
      res.statusCode = 302;
      res.redirectUrl = url;
      return res;
    },
    clearCookie(name) {
      res.clearedCookies.push(name);
      return res;
    },
  };
  return res;
}

describe('optionalAuth middleware', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // T-10: optionalAuth populates req.user with valid session
  it('populates req.user when valid session exists', () => {
    const user = { id: 1, email: 'test@example.com', display_name: 'Test', role: 'user' };
    mock.method(authService, 'validateSession', () => user);

    const req = createMockReq({ cookies: { jh_session: 'valid-token' } });
    const res = createMockRes();
    let nextCalled = false;

    optionalAuth(req, res, () => { nextCalled = true; });

    assert.deepEqual(req.user, user);
    assert.deepEqual(res.locals.user, user);
    assert.ok(nextCalled);
    assert.equal(authService.validateSession.mock.calls.length, 1);
    assert.equal(authService.validateSession.mock.calls[0].arguments[0], 'valid-token');
  });

  // T-11: optionalAuth passes through when no session
  it('passes through when no session cookie', () => {
    mock.method(authService, 'validateSession', () => null);

    const req = createMockReq({});
    const res = createMockRes();
    let nextCalled = false;

    optionalAuth(req, res, () => { nextCalled = true; });

    assert.equal(req.user, null);
    assert.equal(res.locals.user, null);
    assert.ok(nextCalled);
    // validateSession should not be called when there's no cookie
    assert.equal(authService.validateSession.mock.calls.length, 0);
  });
});

describe('requireAuth middleware', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // T-12: requireAuth returns 401 JSON for /api/* paths
  it('returns 401 AUTHENTICATION_REQUIRED for /api/ paths without session', () => {
    const req = createMockReq({ path: '/api/resumes', originalUrl: '/api/resumes' });
    const res = createMockRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody.error.code, 'AUTHENTICATION_REQUIRED');
  });

  // T-13: requireAuth returns 302 redirect for page routes
  it('returns 302 redirect for page routes without session', () => {
    const req = createMockReq({ path: '/resumes', originalUrl: '/resumes' });
    const res = createMockRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 302);
    assert.ok(res.redirectUrl.includes('/auth/login?redirect='));
    assert.ok(res.redirectUrl.includes(encodeURIComponent('/resumes')));
  });

  // T-14: requireAuth returns 401 SESSION_EXPIRED for expired session
  it('returns 401 SESSION_EXPIRED when cookie exists but session is invalid', () => {
    mock.method(authService, 'validateSession', () => null);

    const req = createMockReq({
      path: '/api/resumes',
      originalUrl: '/api/resumes',
      cookies: { jh_session: 'expired-token' },
    });
    const res = createMockRes();

    requireAuth(req, res, () => {});

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody.error.code, 'SESSION_EXPIRED');
    assert.ok(res.clearedCookies.includes('jh_session'));
    assert.equal(authService.validateSession.mock.calls.length, 1);
  });

  it('proceeds when valid session exists', () => {
    const user = { id: 1, email: 'test@example.com', display_name: 'Test', role: 'user' };
    mock.method(authService, 'validateSession', () => user);

    const req = createMockReq({
      path: '/api/resumes',
      cookies: { jh_session: 'valid-token' },
    });
    const res = createMockRes();
    let nextCalled = false;

    requireAuth(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
    assert.deepEqual(req.user, user);
    assert.equal(authService.validateSession.mock.calls.length, 1);
  });
});

describe('requireAdmin middleware', () => {
  // T-15: requireAdmin validates jh_admin_session with constant-time comparison
  it('proceeds with valid admin token', () => {
    const req = createMockReq({
      cookies: { jh_admin_session: 'test-admin-token-12345' },
    });
    const res = createMockRes();
    let nextCalled = false;

    requireAdmin(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
  });

  it('returns 403 FORBIDDEN with invalid admin token', () => {
    const req = createMockReq({
      cookies: { jh_admin_session: 'wrong-token' },
    });
    const res = createMockRes();

    requireAdmin(req, res, () => {});

    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody.error.code, 'FORBIDDEN');
  });

  it('returns 403 FORBIDDEN with no admin token', () => {
    const req = createMockReq({});
    const res = createMockRes();

    requireAdmin(req, res, () => {});

    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody.error.code, 'FORBIDDEN');
  });
});

// CSRF protection tests (T-118, T-119)
describe('csrfProtection middleware', () => {
  it('allows safe methods (GET, HEAD, OPTIONS) without Origin', (t, done) => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();
    csrfProtection(req, res, () => { done(); });
  });

  // T-118: POST without Origin header is rejected
  it('rejects POST without Origin or Referer header (T-118)', () => {
    const req = createMockReq({ method: 'POST', headers: {} });
    const res = createMockRes();
    let nextCalled = false;

    csrfProtection(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody.error.code, 'FORBIDDEN');
  });

  // T-119: Valid Origin header accepted
  it('accepts POST with valid matching Origin header (T-119)', (t, done) => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'Origin': 'http://localhost:3001',
        'Host': 'localhost:3001',
      },
    });
    const res = createMockRes();

    csrfProtection(req, res, () => { done(); });
  });

  it('rejects POST with mismatched Origin header', () => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'Origin': 'http://evil.com',
        'Host': 'localhost:3001',
      },
    });
    const res = createMockRes();
    let nextCalled = false;

    csrfProtection(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  // T-119 variant: valid Referer without Origin
  it('accepts POST with valid Referer but no Origin', (t, done) => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'Referer': 'http://localhost:3001/jobs',
        'Host': 'localhost:3001',
      },
    });
    const res = createMockRes();

    csrfProtection(req, res, () => { done(); });
  });

  it('rejects PUT without Origin header', () => {
    const req = createMockReq({ method: 'PUT', headers: {} });
    const res = createMockRes();
    let nextCalled = false;

    csrfProtection(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it('rejects DELETE without Origin header', () => {
    const req = createMockReq({ method: 'DELETE', headers: {} });
    const res = createMockRes();
    let nextCalled = false;

    csrfProtection(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});
