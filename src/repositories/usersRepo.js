const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function create({ email, password_hash, display_name, role }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES (@email, @password_hash, @display_name, @role)`
  );
  const info = stmt.run({
    email,
    password_hash,
    display_name: display_name || null,
    role: role || 'user',
  });
  return info.lastInsertRowid;
}

function findByEmail(email) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function updatePassword(id, password_hash) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .run(password_hash, id);
  return info.changes;
}

function updateProfile(id, { display_name }) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .run(display_name, id);
  return info.changes;
}

function deleteUser(id) {
  const db = getDbInstance();
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes;
}

function getCount() {
  const db = getDbInstance();
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

module.exports = {
  create,
  findByEmail,
  findById,
  updatePassword,
  updateProfile,
  deleteUser,
  getCount,
};
