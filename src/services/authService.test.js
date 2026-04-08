'use strict';

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

// Require the actual repos so we can mock their methods at the object level.
// These are the same cached objects that authService holds references to.
const usersRepo = require('../repositories/usersRepo');
const sessionsRepo = require('../repositories/sessionsRepo');

// Require the actual service under test
const authService = require('./authService');

describe('Auth Service', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // T-16: Session token is 64-character hex string (tested via login return value)
  it('login returns a 64-char hex session token (T-16)', () => {
    const passwordHash = bcrypt.hashSync('correct-password', 4); // low cost for speed
    const userRow = { id: 1, email: 'test@example.com', password_hash: passwordHash, display_name: 'Test', role: 'user' };

    mock.method(usersRepo, 'findByEmail', () => userRow);
    mock.method(sessionsRepo, 'countByUser', () => 0);
    mock.method(sessionsRepo, 'create', () => 1);

    const result = authService.login('test@example.com', 'correct-password');

    assert.equal(result.token.length, 64);
    assert.match(result.token, /^[0-9a-f]{64}$/);
    assert.equal(result.user.email, 'test@example.com');
    assert.equal(result.user.role, 'user');
  });

  it('session tokens are unique across multiple logins', () => {
    const passwordHash = bcrypt.hashSync('pass', 4);
    const userRow = { id: 1, email: 'a@b.com', password_hash: passwordHash, display_name: 'A', role: 'user' };

    mock.method(usersRepo, 'findByEmail', () => userRow);
    mock.method(sessionsRepo, 'countByUser', () => 0);
    mock.method(sessionsRepo, 'create', () => 1);

    const tokens = new Set();
    for (let i = 0; i < 20; i++) {
      tokens.add(authService.login('a@b.com', 'pass').token);
    }
    assert.equal(tokens.size, 20, 'All 20 tokens should be unique');
  });

  // T-17: Session cap enforcement — oldest session deleted when at capacity
  it('login enforces session cap by deleting oldest sessions (T-17)', () => {
    const passwordHash = bcrypt.hashSync('pass', 4);
    const userRow = { id: 1, email: 'a@b.com', password_hash: passwordHash, display_name: 'A', role: 'user' };

    mock.method(usersRepo, 'findByEmail', () => userRow);
    // Simulate user already at session cap (5 sessions)
    let sessionCount = 5;
    mock.method(sessionsRepo, 'countByUser', () => sessionCount);
    mock.method(sessionsRepo, 'deleteOldestForUser', () => {
      sessionCount--;
      return 1;
    });
    mock.method(sessionsRepo, 'create', () => 1);

    const result = authService.login('a@b.com', 'pass');

    assert.ok(result.token, 'Login should succeed');
    assert.ok(sessionsRepo.deleteOldestForUser.mock.calls.length >= 1,
      'Should have deleted at least one oldest session');
    assert.equal(sessionsRepo.create.mock.calls.length, 1,
      'Should have created a new session');
  });

  // T-18: validateSession returns user for valid token
  it('validateSession returns user object for valid session (T-18)', () => {
    const sessionRow = {
      id: 1, user_id: 42, token: 'abc', expires_at: '2099-01-01T00:00:00.000Z',
      email: 'user@test.com', display_name: 'User', role: 'user',
    };
    mock.method(sessionsRepo, 'findByToken', () => sessionRow);

    const user = authService.validateSession('abc');

    assert.equal(user.id, 42);
    assert.equal(user.email, 'user@test.com');
    assert.equal(user.role, 'user');
    assert.equal(sessionsRepo.findByToken.mock.calls[0].arguments[0], 'abc');
  });

  it('validateSession returns null for missing token', () => {
    const user = authService.validateSession(null);
    assert.equal(user, null);
  });

  it('validateSession returns null for unknown token', () => {
    mock.method(sessionsRepo, 'findByToken', () => null);

    const user = authService.validateSession('nonexistent');
    assert.equal(user, null);
  });

  // T-19: bcrypt password verification via login
  it('login throws INVALID_CREDENTIALS for wrong password (T-19)', () => {
    const passwordHash = bcrypt.hashSync('correct-password', 4);
    const userRow = { id: 1, email: 'a@b.com', password_hash: passwordHash, display_name: 'A', role: 'user' };

    mock.method(usersRepo, 'findByEmail', () => userRow);

    assert.throws(
      () => authService.login('a@b.com', 'wrong-password'),
      (err) => err.code === 'INVALID_CREDENTIALS' && err.status === 401
    );
  });

  it('login throws INVALID_CREDENTIALS for unknown email', () => {
    mock.method(usersRepo, 'findByEmail', () => null);

    assert.throws(
      () => authService.login('unknown@test.com', 'pass'),
      (err) => err.code === 'INVALID_CREDENTIALS' && err.status === 401
    );
  });

  it('logout calls sessionsRepo.deleteByToken', () => {
    mock.method(sessionsRepo, 'deleteByToken', () => 1);

    authService.logout('some-token');

    assert.equal(sessionsRepo.deleteByToken.mock.calls.length, 1);
    assert.equal(sessionsRepo.deleteByToken.mock.calls[0].arguments[0], 'some-token');
  });

  it('register creates user and session, returns token and user', () => {
    mock.method(usersRepo, 'findByEmail', () => null);
    mock.method(usersRepo, 'create', () => 99);
    mock.method(usersRepo, 'findById', () => ({
      id: 99, email: 'new@test.com', display_name: 'New', role: 'user',
    }));
    mock.method(sessionsRepo, 'create', () => 1);

    const result = authService.register('new@test.com', 'securePass', 'New');

    assert.equal(result.user.id, 99);
    assert.equal(result.user.email, 'new@test.com');
    assert.equal(result.token.length, 64);
    assert.match(result.token, /^[0-9a-f]{64}$/);
    assert.equal(usersRepo.create.mock.calls.length, 1);
    assert.equal(sessionsRepo.create.mock.calls.length, 1);
  });

  it('register throws for duplicate email', () => {
    mock.method(usersRepo, 'findByEmail', () => ({ id: 1, email: 'dup@test.com' }));

    assert.throws(
      () => authService.register('dup@test.com', 'pass', 'Dup'),
      (err) => err.code === 'EMAIL_EXISTS' && err.status === 409
    );
  });
});
