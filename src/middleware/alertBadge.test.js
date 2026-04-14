'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const connectionModule = require('../db/connection');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function applyMigrations(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const insertMigration = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  for (const file of files) {
    if (hasMigration.get(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let processedSql = sql;
    const alterRegex = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+).*$/gim;
    let match;
    while ((match = alterRegex.exec(sql)) !== null) {
      const [fullLine, table, column] = match;
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (cols.some(c => c.name === column)) {
          processedSql = processedSql.replace(fullLine, `-- SKIPPED (exists): ${fullLine}`);
        }
      } catch (_) { /* table may not exist yet */ }
    }
    try { db.exec(processedSql); } catch (e) { if (!e.message.includes('already exists')) throw e; }
    insertMigration.run(file);
  }
}

describe('alertBadge middleware', () => {
  let db, dbPath, originalGetDb;
  let alertBadge;
  let userId;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-alert-badge-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);
    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    ({ alertBadge } = require('./alertBadge'));

    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('badge-test@test.com', 'hash', 'user')`);
    userId = db.prepare(`SELECT id FROM users WHERE email = 'badge-test@test.com'`).get().id;

    // Seed a job and notification
    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Badge Test Job', 'general', 'seek', 'badge-ext-1')`);
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM notifications');
  });

  it('sets unreadAlertCount to 0 for unauthenticated request', (t, done) => {
    const req = { user: null };
    const res = { locals: {} };
    alertBadge(req, res, () => {
      assert.equal(res.locals.unreadAlertCount, 0);
      done();
    });
  });

  it('sets unreadAlertCount from DB for authenticated request', (t, done) => {
    const jobId = db.prepare('SELECT id FROM jobs LIMIT 1').get().id;
    db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${userId}, ${jobId}, 80, 'immediate')`);

    const req = { user: { id: userId } };
    const res = { locals: {} };
    alertBadge(req, res, () => {
      assert.equal(res.locals.unreadAlertCount, 1);
      done();
    });
  });

  it('calls next() in both authenticated and unauthenticated cases', (t, done) => {
    let nextCalled = false;
    const req = { user: null };
    const res = { locals: {} };
    alertBadge(req, res, () => {
      nextCalled = true;
      assert.ok(nextCalled);

      let nextCalled2 = false;
      const req2 = { user: { id: userId } };
      const res2 = { locals: {} };
      alertBadge(req2, res2, () => {
        nextCalled2 = true;
        assert.ok(nextCalled2);
        done();
      });
    });
  });
});
