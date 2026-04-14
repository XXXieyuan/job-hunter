'use strict';

const crypto = require('crypto');
const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

/**
 * Find an unsubscribe token row by its token string.
 */
function findByToken(token) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM unsubscribe_tokens WHERE token = ?').get(token) || null;
}

/**
 * Find an unsubscribe token row by user ID.
 */
function findByUserId(userId) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM unsubscribe_tokens WHERE user_id = ?').get(userId) || null;
}

/**
 * Create a new unsubscribe token for a user.
 * Generates a 256-bit (32-byte) token as a 64-char hex string.
 * Uses INSERT OR IGNORE to respect UNIQUE(user_id).
 * Returns the created row or null if user already has a token.
 */
function create(userId) {
  const db = getDbInstance();
  const token = crypto.randomBytes(32).toString('hex');

  const info = db.prepare(
    'INSERT OR IGNORE INTO unsubscribe_tokens (user_id, token) VALUES (?, ?)'
  ).run(userId, token);

  if (info.changes === 0) {
    return null;
  }

  return db.prepare('SELECT * FROM unsubscribe_tokens WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Get existing token for user, or create a new one if none exists.
 * Returns the token row.
 */
function getOrCreate(userId) {
  const existing = findByUserId(userId);
  if (existing) {
    return existing;
  }
  return create(userId);
}

module.exports = {
  findByToken,
  findByUserId,
  create,
  getOrCreate,
};
