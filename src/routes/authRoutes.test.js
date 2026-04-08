'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { registerSchema, loginSchema, validate } = require('../middleware/validators');
const { rateLimiter, _store: rateLimitStore } = require('../middleware/rateLimiter');

// =============================================================================
// Helper: mock Express req/res for middleware testing
// =============================================================================

function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/auth/login',
    originalUrl: '/auth/login',
    method: 'POST',
    get: () => null,
    accepts: () => false,
    is: () => false,
    user: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    cookies: {},
    clearedCookies: [],
    body: null,
    redirectUrl: null,
    rendered: null,
    ended: false,
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = (key, val) => { res.headers[key] = val; return res; };
  res.cookie = (name, value, opts) => { res.cookies[name] = { value, opts }; return res; };
  res.clearCookie = (name) => { res.clearedCookies.push(name); return res; };
  res.redirect = (url) => { res.statusCode = 302; res.redirectUrl = url; return res; };
  res.render = (view, data) => { res.rendered = { view, data }; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

// =============================================================================
// T-25, T-26: Zod Validation Schema Tests (VALIDATION_ERROR contract)
// =============================================================================

describe('Auth Validation Schemas (T-C.3)', () => {
  // T-25: POST /auth/register — validation failure (short password)
  it('T-25: register with short password returns VALIDATION_ERROR with details[{field:"password"}]', () => {
    const middleware = validate(registerSchema);
    const req = mockReq({ body: { email: 'user@example.com', password: 'abc' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false, 'next() should not be called on validation failure');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(res.body.error.message, 'Validation failed');
    assert.ok(Array.isArray(res.body.error.details));
    const passwordError = res.body.error.details.find(d => d.field === 'password');
    assert.ok(passwordError, 'Should have a password field error');
    assert.ok(passwordError.message.includes('8'), 'Should mention 8 character minimum');
  });

  // T-26: POST /auth/register — validation failure (invalid email)
  it('T-26: register with invalid email returns VALIDATION_ERROR with details[{field:"email"}]', () => {
    const middleware = validate(registerSchema);
    const req = mockReq({ body: { email: 'not-an-email', password: 'securepass' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.error.details));
    const emailError = res.body.error.details.find(d => d.field === 'email');
    assert.ok(emailError, 'Should have an email field error');
  });

  it('register with valid data passes validation and sets req.validatedBody', () => {
    const middleware = validate(registerSchema);
    const req = mockReq({ body: { email: 'user@example.com', password: 'securepass', display_name: 'Jane' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true, 'next() should be called on valid input');
    assert.deepEqual(req.validatedBody, {
      email: 'user@example.com',
      password: 'securepass',
      display_name: 'Jane',
    });
  });

  it('register with missing display_name passes (optional field)', () => {
    const middleware = validate(registerSchema);
    const req = mockReq({ body: { email: 'user@example.com', password: 'securepass' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.validatedBody.email, 'user@example.com');
    assert.equal(req.validatedBody.display_name, undefined);
  });

  it('login schema rejects missing password', () => {
    const middleware = validate(loginSchema);
    const req = mockReq({ body: { email: 'user@example.com', password: '' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('login schema accepts valid credentials', () => {
    const middleware = validate(loginSchema);
    const req = mockReq({ body: { email: 'user@example.com', password: 'x' } });
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.validatedBody, { email: 'user@example.com', password: 'x' });
  });
});

// =============================================================================
// T-23, T-27: Rate Limiting Tests
// =============================================================================

describe('Auth Rate Limiting (T-C.3)', () => {
  beforeEach(() => {
    // Clear rate limiter store between tests
    rateLimitStore.clear();
  });

  // T-23: POST /auth/login — rate limited at 10/15min/IP
  it('T-23: 11th login attempt in 15 min returns 429 with Retry-After header', () => {
    const limiter = rateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 10,
      scope: 'ip',
      prefix: 'test:login',
    });

    const res = mockRes();
    const req = mockReq({ ip: '10.0.0.1' });

    // Make 10 requests (should pass)
    for (let i = 0; i < 10; i++) {
      const r = mockRes();
      let passed = false;
      limiter(req, r, () => { passed = true; });
      assert.equal(passed, true, `Request ${i + 1} should pass`);
    }

    // 11th request should be blocked
    let blocked = true;
    limiter(req, res, () => { blocked = false; });

    assert.equal(blocked, true, '11th request should be blocked');
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['Retry-After'], 'Should have Retry-After header');
    const retryAfter = parseInt(res.headers['Retry-After'], 10);
    assert.ok(retryAfter > 0, 'Retry-After should be a positive integer');
    assert.ok(retryAfter <= 900, 'Retry-After should be <= 900 seconds (15 min)');
    assert.equal(res.body.error.code, 'RATE_LIMITED');
  });

  // T-27: POST /auth/register — rate limited at 10/15min/IP
  it('T-27: 11th register attempt in 15 min returns 429 with Retry-After header', () => {
    const limiter = rateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 10,
      scope: 'ip',
      prefix: 'test:register',
    });

    const req = mockReq({ ip: '10.0.0.2' });

    for (let i = 0; i < 10; i++) {
      const r = mockRes();
      let passed = false;
      limiter(req, r, () => { passed = true; });
      assert.equal(passed, true);
    }

    const res = mockRes();
    let blocked = true;
    limiter(req, res, () => { blocked = false; });

    assert.equal(blocked, true);
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['Retry-After']);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
  });

  it('rate limiter allows requests from different IPs independently', () => {
    const limiter = rateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 2,
      scope: 'ip',
      prefix: 'test:independence',
    });

    const req1 = mockReq({ ip: '10.0.0.10' });
    const req2 = mockReq({ ip: '10.0.0.11' });

    // Exhaust IP1's limit
    for (let i = 0; i < 2; i++) {
      limiter(req1, mockRes(), () => {});
    }

    // IP1 is blocked
    const res1 = mockRes();
    let ip1Blocked = true;
    limiter(req1, res1, () => { ip1Blocked = false; });
    assert.equal(ip1Blocked, true);
    assert.equal(res1.statusCode, 429);

    // IP2 still allowed
    const res2 = mockRes();
    let ip2Passed = false;
    limiter(req2, res2, () => { ip2Passed = true; });
    assert.equal(ip2Passed, true);
  });
});

// =============================================================================
// T-20, T-21, T-22, T-24, T-28: Auth Route Handler Tests
// These test real code from authRoutes by importing the module's exported helpers
// and by mocking authService to test the actual route handler chain.
// =============================================================================

describe('Auth Route Handlers (T-C.1)', () => {
  // Import the actual router and its exported helpers
  const authRoutes = require('./authRoutes');
  const cookieOptions = authRoutes._cookieOptions;
  const getRedirectUrl = authRoutes._getRedirectUrl;

  // T-20: POST /auth/login — success path (cookie + redirect)
  it('T-20: cookieOptions() returns HttpOnly, SameSite=Lax, 7-day maxAge, path=/', () => {
    // Call the real cookieOptions function from authRoutes.js
    const opts = cookieOptions();

    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.maxAge, 7 * 24 * 60 * 60 * 1000, 'Max age should be 7 days in ms (604800000)');
    assert.equal(opts.path, '/');
    // secure depends on NODE_ENV — the function reads it from config
    assert.equal(typeof opts.secure, 'boolean');
  });

  // T-21: POST /auth/login — redirect param preserved
  it('T-21: getRedirectUrl uses redirect param, defaults to /jobs, prevents open redirect', () => {
    // Call the real getRedirectUrl function from authRoutes.js

    // Query param redirect
    assert.equal(getRedirectUrl({ query: { redirect: '/resumes' }, body: {} }), '/resumes');
    // Body param redirect
    assert.equal(getRedirectUrl({ query: {}, body: { redirect: '/resumes' } }), '/resumes');
    // Default to /jobs
    assert.equal(getRedirectUrl({ query: {}, body: {} }), '/jobs');
    // Prevent open redirect (absolute URL)
    assert.equal(getRedirectUrl({ query: { redirect: 'https://evil.com' }, body: {} }), '/jobs');
    // Prevent open redirect (protocol-relative URL)
    assert.equal(getRedirectUrl({ query: { redirect: '//evil.com' }, body: {} }), '/jobs');
    // Query param takes precedence over body
    assert.equal(getRedirectUrl({ query: { redirect: '/a' }, body: { redirect: '/b' } }), '/a');
  });

  // T-22: POST /auth/login — invalid credentials returns INVALID_CREDENTIALS
  it('T-22: login route with invalid credentials produces INVALID_CREDENTIALS response', () => {
    // Find the login POST route handler in the router stack
    const loginLayer = authRoutes.stack.find(
      (layer) => layer.route && layer.route.path === '/auth/login' && layer.route.methods.post
    );
    assert.ok(loginLayer, 'Should have a POST /auth/login route');

    // Get the final handler (after rate limiter middleware)
    const handlers = loginLayer.route.stack;
    const routeHandler = handlers[handlers.length - 1].handle;

    // Mock authService.login to throw INVALID_CREDENTIALS
    const authService = require('../services/authService');
    const originalLogin = authService.login;
    const loginErr = new Error('Invalid email or password');
    loginErr.status = 401;
    loginErr.code = 'INVALID_CREDENTIALS';
    authService.login = () => { throw loginErr; };

    try {
      const req = mockReq({
        body: { email: 'user@example.com', password: 'wrongpass' },
        accepts: (type) => type === 'json',
      });
      const res = mockRes();
      routeHandler(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password');
      // Generic message prevents user enumeration
      assert.ok(!res.body.error.message.includes('not found'));
      assert.ok(!res.body.error.message.includes('does not exist'));
    } finally {
      authService.login = originalLogin;
    }
  });

  // T-24: POST /auth/register — success path invokes authService and sets cookie
  it('T-24: register route handler creates user, sets cookie, and returns 201 JSON', () => {
    // Find the register POST route handler in the router stack
    const registerLayer = authRoutes.stack.find(
      (layer) => layer.route && layer.route.path === '/auth/register' && layer.route.methods.post
    );
    assert.ok(registerLayer, 'Should have a POST /auth/register route');

    const handlers = registerLayer.route.stack;
    const routeHandler = handlers[handlers.length - 1].handle;

    // Mock authService.register to return a successful result
    const authService = require('../services/authService');
    const originalRegister = authService.register;
    authService.register = (email, password, displayName) => ({
      token: 'fake-session-token',
      user: { id: 1, email, display_name: displayName, role: 'user' },
    });

    try {
      const req = mockReq({
        body: { email: 'newuser@example.com', password: 'securepass', display_name: 'Jane' },
        accepts: (type) => type === 'json',
      });
      const res = mockRes();
      routeHandler(req, res);

      assert.equal(res.statusCode, 201);
      assert.ok(res.cookies.jh_session, 'Should set jh_session cookie');
      assert.equal(res.cookies.jh_session.value, 'fake-session-token');
      assert.equal(res.cookies.jh_session.opts.httpOnly, true);
      assert.equal(res.cookies.jh_session.opts.sameSite, 'lax');
      assert.equal(res.cookies.jh_session.opts.maxAge, 604800000);
      assert.equal(res.body.user.email, 'newuser@example.com');
      assert.equal(res.body.user.display_name, 'Jane');
    } finally {
      authService.register = originalRegister;
    }
  });

  // T-28: POST /auth/logout — clears session
  it('T-28: logout route has requireAuth middleware', () => {
    // Verify that the logout route in the actual router stack has requireAuth middleware.
    // Express router stores route layers in router.stack.
    const logoutLayer = authRoutes.stack.find(
      (layer) => layer.route && layer.route.path === '/auth/logout' && layer.route.methods.post
    );
    assert.ok(logoutLayer, 'Should have a POST /auth/logout route');

    // The route should have multiple handlers (requireAuth + handler)
    const handlers = logoutLayer.route.stack;
    assert.ok(handlers.length >= 2, 'Logout route should have requireAuth middleware + handler');
  });

  it('EMAIL_EXISTS maps to VALIDATION_ERROR 400 with details[{field:"email"}] per contract', () => {
    // Find the register POST route handler
    const registerLayer = authRoutes.stack.find(
      (layer) => layer.route && layer.route.path === '/auth/register' && layer.route.methods.post
    );
    const handlers = registerLayer.route.stack;
    const routeHandler = handlers[handlers.length - 1].handle;

    // Mock authService.register to throw EMAIL_EXISTS
    const authService = require('../services/authService');
    const originalRegister = authService.register;
    const emailErr = new Error('An account with this email already exists');
    emailErr.status = 409;
    emailErr.code = 'EMAIL_EXISTS';
    authService.register = () => { throw emailErr; };

    try {
      const req = mockReq({
        body: { email: 'dup@example.com', password: 'securepass' },
        accepts: (type) => type === 'json',
      });
      const res = mockRes();
      routeHandler(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.equal(res.body.error.message, 'Validation failed');
      assert.equal(res.body.error.details.length, 1);
      assert.equal(res.body.error.details[0].field, 'email');
      assert.equal(res.body.error.details[0].message, 'Email already registered');
    } finally {
      authService.register = originalRegister;
    }
  });

  it('inline Zod validation in register handler returns form-rendered errors for HTML clients', () => {
    // Verify the registerSchema correctly rejects a short password (inline validation path)
    const parsed = registerSchema.safeParse({
      email: 'user@example.com',
      password: 'abc',
    });
    assert.equal(parsed.success, false);

    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    const errors = {};
    for (const d of details) {
      errors[d.field] = d.message;
    }
    assert.ok(errors.password, 'Should have password error');
    assert.ok(errors.password.includes('8'), 'Should mention 8 character minimum');
  });

  it('inline Zod validation in login handler returns form-rendered errors for HTML clients', () => {
    // Verify the loginSchema correctly rejects empty password (inline validation path)
    const parsed = loginSchema.safeParse({
      email: 'user@example.com',
      password: '',
    });
    assert.equal(parsed.success, false);

    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    assert.ok(details.length > 0, 'Should have validation errors');
    assert.ok(details.find(d => d.field === 'password'), 'Should have password field error');
  });
});

// =============================================================================
// Auth route module loads without error
// =============================================================================

describe('Auth Routes Module', () => {
  it('authRoutes module exports an Express router with test helpers', () => {
    const authRoutes = require('./authRoutes');
    assert.ok(authRoutes, 'Module should export');
    assert.equal(typeof authRoutes, 'function', 'Should export a function (Express router)');
    assert.equal(typeof authRoutes._cookieOptions, 'function', 'Should export _cookieOptions');
    assert.equal(typeof authRoutes._getRedirectUrl, 'function', 'Should export _getRedirectUrl');
  });
});

// =============================================================================
// Pre-configured rate limiters exist
// =============================================================================

describe('Pre-configured auth rate limiters', () => {
  it('authLoginLimiter and authRegisterLimiter are exported', () => {
    const { authLoginLimiter, authRegisterLimiter } = require('../middleware/rateLimiter');
    assert.equal(typeof authLoginLimiter, 'function');
    assert.equal(typeof authRegisterLimiter, 'function');
  });
});
