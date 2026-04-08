const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

/**
 * Create a backup of the database file before running migrations.
 * Returns the backup path or null if no DB file exists yet.
 */
function backupDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.backup-${timestamp}`;
  fs.copyFileSync(dbPath, backupPath);
  // Also copy WAL and SHM files if they exist
  if (fs.existsSync(`${dbPath}-wal`)) {
    fs.copyFileSync(`${dbPath}-wal`, `${backupPath}-wal`);
  }
  if (fs.existsSync(`${dbPath}-shm`)) {
    fs.copyFileSync(`${dbPath}-shm`, `${backupPath}-shm`);
  }
  return backupPath;
}

function runMigrations() {
  const db = getDb();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  files.sort();

  // Simple migration tracking so ALTER TABLE migrations run only once
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)'
  );

  // Check if there are pending migrations before making a backup
  const hasMigration = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id = ?'
  );
  const pendingFiles = files.filter((f) => !hasMigration.get(f));

  if (pendingFiles.length === 0) {
    return; // Nothing to migrate
  }

  // Create backup before applying migrations
  const { DB_PATH } = require('../config');
  const backupPath = backupDatabase(DB_PATH);
  if (backupPath) {
    console.log(`[migrate] Database backed up to ${backupPath}`);
  }

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (id) VALUES (?)'
  );

  for (const file of pendingFiles) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');

    console.log(`[migrate] Applying ${file}...`);

    // Use a transaction for each migration file
    const runInTransaction = db.transaction(() => {
      // Pre-process: make ALTER TABLE ADD COLUMN idempotent
      // by removing lines for columns that already exist
      let processedSql = sql;
      const alterRegex = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+).*$/gim;
      let match;
      while ((match = alterRegex.exec(sql)) !== null) {
        const [fullLine, table, column] = match;
        try {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all();
          if (cols.some((c) => c.name === column)) {
            processedSql = processedSql.replace(fullLine, `-- SKIPPED (exists): ${fullLine}`);
          }
        } catch (_) { /* table may not exist yet, let it proceed */ }
      }

      try {
        db.exec(processedSql);
      } catch (execErr) {
        if (execErr.message.includes('already exists')) {
          // Ignore duplicate create errors
        } else {
          throw execErr;
        }
      }
      insertMigration.run(file);
    });

    try {
      runInTransaction();
      console.log(`[migrate] Applied ${file} successfully`);
    } catch (err) {
      console.error(`[migrate] Failed to apply ${file}:`, err.message);
      throw err;
    }
  }
}

module.exports = {
  runMigrations,
};
