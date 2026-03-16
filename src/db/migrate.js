const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

function runMigrations() {
  const db = getDb();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  files.sort();

  // Simple migration tracking so ALTER TABLE migrations run only once
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)'
  );

  db.exec('BEGIN');
  try {
    const hasMigration = db.prepare(
      'SELECT 1 FROM schema_migrations WHERE id = ?'
    );
    const insertMigration = db.prepare(
      'INSERT INTO schema_migrations (id) VALUES (?)'
    );

    for (const file of files) {
      const alreadyApplied = hasMigration.get(file);
      if (alreadyApplied) {
        // Skip migrations that have already been applied
        // eslint-disable-next-line no-continue
        continue;
      }

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

      insertMigration.run(file);
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
