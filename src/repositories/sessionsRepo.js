const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function create({ user_id, token, expires_at }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES (@user_id, @token, @expires_at)`
  );
  const info = stmt.run({ user_id, token, expires_at });
  return info.lastInsertRowid;
}

function findByToken(token) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT s.*, u.email, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token);
}

function deleteByToken(token) {
  const db = getDbInstance();
  const info = db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return info.changes;
}

function deleteByUser(user_id) {
  const db = getDbInstance();
  const info = db
    .prepare('DELETE FROM sessions WHERE user_id = ?')
    .run(user_id);
  return info.changes;
}

function deleteExpired() {
  const db = getDbInstance();
  const info = db
    .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run();
  return info.changes;
}

function countByUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?')
    .get(user_id).c;
}

function deleteOldestForUser(user_id) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `DELETE FROM sessions WHERE id = (
        SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1
      )`
    )
    .run(user_id);
  return info.changes;
}

function extendExpiry(token, new_expires_at) {
  const db = getDbInstance();
  const info = db
    .prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
    .run(new_expires_at, token);
  return info.changes;
}

module.exports = {
  create,
  findByToken,
  deleteByToken,
  deleteByUser,
  deleteExpired,
  countByUser,
  deleteOldestForUser,
  extendExpiry,
};
