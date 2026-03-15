const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

function runMigrations() {
  const db = getDb();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  files.sort();

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      // Split on semicolons but keep statements simple; ignore empty
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length);
      for (const stmt of statements) {
        db.exec(stmt);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  runMigrations,
};

