'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// Tests for migration 007_notifications.sql (T-A.1)

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function applyMigrations(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)');

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
  files.sort();

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

    try {
      db.exec(processedSql);
    } catch (execErr) {
      if (!execErr.message.includes('already exists')) {
        throw execErr;
      }
    }
    insertMigration.run(file);
  }
}

describe('Notifications Migration (007)', () => {
  let db;
  let dbPath;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-notif-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  it('notifications table exists with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(notifications)').all();
    const names = cols.map(c => c.name);
    const required = [
      'id', 'user_id', 'job_id', 'score', 'top_matched_skills',
      'visa_match', 'frequency', 'email_sent', 'is_read',
      'read_token', 'created_at', 'updated_at',
    ];
    for (const col of required) {
      assert.ok(names.includes(col), `notifications should have column: ${col}`);
    }
  });

  it('unsubscribe_tokens table exists with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(unsubscribe_tokens)').all();
    const names = cols.map(c => c.name);
    const required = ['id', 'user_id', 'token', 'created_at'];
    for (const col of required) {
      assert.ok(names.includes(col), `unsubscribe_tokens should have column: ${col}`);
    }
  });

  it('notifications has correct indexes', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications'"
    ).all().map(r => r.name);
    assert.ok(indexes.includes('idx_notifications_user_unread'), 'should have idx_notifications_user_unread');
    assert.ok(indexes.includes('idx_notifications_pending_email'), 'should have idx_notifications_pending_email');
    assert.ok(indexes.includes('idx_notifications_user_created'), 'should have idx_notifications_user_created');
  });

  it('unsubscribe_tokens has idx_unsub_token index', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='unsubscribe_tokens'"
    ).all().map(r => r.name);
    assert.ok(indexes.includes('idx_unsub_token'), 'should have idx_unsub_token');
  });

  it('UNIQUE(user_id, job_id) constraint on notifications rejects duplicates', () => {
    // Set up: create a user and a job
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('notif-test@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'notif-test@test.com'`).get();

    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Notif Job', 'Dev', 'seek', 'notif-unique-test')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'notif-unique-test'`).get();

    db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${user.id}, ${job.id}, 80, 'immediate')`);

    assert.throws(() => {
      db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${user.id}, ${job.id}, 90, 'digest')`);
    }, /UNIQUE constraint/);
  });

  it('FK constraint rejects notification with nonexistent user_id', () => {
    assert.throws(() => {
      db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (99999, 1, 80, 'immediate')`);
    }, /FOREIGN KEY constraint/);
  });

  it('CHECK constraint on frequency rejects invalid values', () => {
    const user = db.prepare(`SELECT id FROM users LIMIT 1`).get();
    const job = db.prepare(`SELECT id FROM jobs LIMIT 1`).get();

    assert.throws(() => {
      db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${user.id}, ${job.id}, 80, 'weekly')`);
    }, /CHECK constraint/);
  });

  it('ON DELETE CASCADE removes notifications when user is deleted', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('cascade-test@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'cascade-test@test.com'`).get();

    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Cascade Job', 'Dev', 'seek', 'cascade-job-test')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'cascade-job-test'`).get();

    db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${user.id}, ${job.id}, 75, 'immediate')`);
    db.exec(`INSERT INTO unsubscribe_tokens (user_id, token) VALUES (${user.id}, 'cascade-test-token-aabbccdd')`);

    // Delete user — cascading should remove both
    db.exec(`DELETE FROM users WHERE id = ${user.id}`);

    const notifs = db.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(user.id);
    const tokens = db.prepare(`SELECT * FROM unsubscribe_tokens WHERE user_id = ?`).all(user.id);
    assert.equal(notifs.length, 0, 'notifications should be cascade-deleted');
    assert.equal(tokens.length, 0, 'unsubscribe_tokens should be cascade-deleted');
  });

  it('unsubscribe_tokens enforces UNIQUE on user_id', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('unsub-unique@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'unsub-unique@test.com'`).get();

    db.exec(`INSERT INTO unsubscribe_tokens (user_id, token) VALUES (${user.id}, 'token-aabbccdd-1')`);

    assert.throws(() => {
      db.exec(`INSERT INTO unsubscribe_tokens (user_id, token) VALUES (${user.id}, 'token-aabbccdd-2')`);
    }, /UNIQUE constraint/);
  });

  it('unsubscribe_tokens enforces UNIQUE on token', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('unsub-tok-unique1@test.com', 'hash', 'user')`);
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('unsub-tok-unique2@test.com', 'hash', 'user')`);
    const user1 = db.prepare(`SELECT id FROM users WHERE email = 'unsub-tok-unique1@test.com'`).get();
    const user2 = db.prepare(`SELECT id FROM users WHERE email = 'unsub-tok-unique2@test.com'`).get();

    db.exec(`INSERT INTO unsubscribe_tokens (user_id, token) VALUES (${user1.id}, 'shared-token-00112233')`);

    assert.throws(() => {
      db.exec(`INSERT INTO unsubscribe_tokens (user_id, token) VALUES (${user2.id}, 'shared-token-00112233')`);
    }, /UNIQUE constraint/);
  });

  it('migration runs idempotently', () => {
    assert.doesNotThrow(() => {
      applyMigrations(db);
    });
  });

  it('notifications defaults are correct', () => {
    const user = db.prepare(`SELECT id FROM users LIMIT 1`).get();
    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Default Test Job', 'Dev', 'seek', 'default-test-job')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'default-test-job'`).get();

    db.exec(`INSERT INTO notifications (user_id, job_id, score, frequency) VALUES (${user.id}, ${job.id}, 70, 'digest')`);
    const notif = db.prepare(`SELECT * FROM notifications WHERE job_id = ?`).get(job.id);

    assert.equal(notif.email_sent, 0, 'email_sent defaults to 0');
    assert.equal(notif.is_read, 0, 'is_read defaults to 0');
    assert.equal(notif.top_matched_skills, '[]', 'top_matched_skills defaults to []');
    assert.ok(notif.created_at, 'created_at should be set');
    assert.ok(notif.updated_at, 'updated_at should be set');
  });
});
