const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const usersRepo = require('../repositories/usersRepo');
const sessionsRepo = require('../repositories/sessionsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('authService');

const {
  BCRYPT_ROUNDS,
  SESSION_MAX_AGE,
  SESSION_MAX_PER_USER,
} = require('../config');

const BCRYPT_COST = BCRYPT_ROUNDS;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE;
const MAX_SESSIONS_PER_USER = SESSION_MAX_PER_USER;

/**
 * Generate a secure random session token.
 * @returns {string} 64-character hex string
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute an ISO-8601 expiry timestamp for a new session.
 * @returns {string}
 */
function sessionExpiry() {
  const d = new Date(Date.now() + SESSION_MAX_AGE_MS);
  return d.toISOString();
}

/**
 * Enforce the per-user session cap by deleting the oldest sessions.
 * @param {number} userId
 */
function enforceSessionCap(userId) {
  let count = sessionsRepo.countByUser(userId);
  while (count >= MAX_SESSIONS_PER_USER) {
    sessionsRepo.deleteOldestForUser(userId);
    count--;
  }
}

/**
 * Register a new user account.
 * @param {string} email
 * @param {string} password
 * @param {string} [displayName]
 * @returns {{ user: object, token: string }}
 */
function register(email, password, displayName) {
  // Check for existing user
  const existing = usersRepo.findByEmail(email);
  if (existing) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    err.code = 'EMAIL_EXISTS';
    throw err;
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);

  const userId = usersRepo.create({
    email,
    password_hash: passwordHash,
    display_name: displayName || null,
    role: 'user',
  });

  const token = generateToken();
  sessionsRepo.create({
    user_id: userId,
    token,
    expires_at: sessionExpiry(),
  });

  const user = usersRepo.findById(userId);
  logger.info('User registered', { userId, email });

  return {
    user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
    token,
  };
}

/**
 * Log in with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {{ user: object, token: string }}
 */
function login(email, password) {
  const user = usersRepo.findByEmail(email);
  if (!user) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  // Enforce session cap before creating a new one
  enforceSessionCap(user.id);

  const token = generateToken();
  sessionsRepo.create({
    user_id: user.id,
    token,
    expires_at: sessionExpiry(),
  });

  logger.info('User logged in', { userId: user.id, email });

  return {
    user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
    token,
  };
}

/**
 * Log out by invalidating a session token.
 * @param {string} token
 */
function logout(token) {
  if (token) {
    sessionsRepo.deleteByToken(token);
  }
}

/**
 * Validate a session token and return the associated user.
 * @param {string} token
 * @returns {object|null} User object or null if invalid/expired
 */
function validateSession(token) {
  if (!token) return null;

  const session = sessionsRepo.findByToken(token);
  if (!session) return null;

  return {
    id: session.user_id,
    email: session.email,
    display_name: session.display_name,
    role: session.role,
  };
}

module.exports = {
  register,
  login,
  logout,
  validateSession,
};
