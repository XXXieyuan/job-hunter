'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// We need to mock the db connection so the repo uses our test database
const connectionModule = require('../db/connection');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

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

describe('notificationsRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId;
  let jobIds = [];

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-notif-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    // Monkey-patch getDb to return our test database
    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    // Require the repo after patching
    repo = require('./notificationsRepo');

    // Seed test data: user and jobs
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('notif-repo@test.com', 'hash', 'user')`);
    userId = db.prepare(`SELECT id FROM users WHERE email = 'notif-repo@test.com'`).get().id;

    for (let i = 1; i <= 25; i++) {
      db.exec(`INSERT INTO jobs (title, company_name, location, role, source, external_id) VALUES ('Job ${i}', 'Company ${i}', 'Sydney', 'Dev', 'seek', 'notif-repo-job-${i}')`);
      const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'notif-repo-job-${i}'`).get();
      jobIds.push(job.id);
    }
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    if (db) db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  beforeEach(() => {
    // Clean notifications between tests
    db.exec('DELETE FROM notifications');
  });

  describe('create()', () => {
    it('creates a notification and returns the row', () => {
      const row = repo.create({
        user_id: userId,
        job_id: jobIds[0],
        score: 85,
        top_matched_skills: '["Python","SQL"]',
        visa_match: 1,
        frequency: 'immediate',
        read_token: 'abc123',
      });

      assert.ok(row, 'should return a row');
      assert.equal(row.user_id, userId);
      assert.equal(row.job_id, jobIds[0]);
      assert.equal(row.score, 85);
      assert.equal(row.top_matched_skills, '["Python","SQL"]');
      assert.equal(row.visa_match, 1);
      assert.equal(row.frequency, 'immediate');
      assert.equal(row.read_token, 'abc123');
      assert.equal(row.is_read, 0);
      assert.equal(row.email_sent, 0);
      assert.ok(row.created_at);
    });

    it('returns null for duplicate (user_id, job_id)', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const dup = repo.create({ user_id: userId, job_id: jobIds[0], score: 90, frequency: 'digest' });
      assert.equal(dup, null, 'duplicate should return null');
    });

    it('uses default values for optional fields', () => {
      const row = repo.create({ user_id: userId, job_id: jobIds[0], score: 70, frequency: 'digest' });
      assert.equal(row.top_matched_skills, '[]');
      assert.equal(row.visa_match, null);
      assert.equal(row.read_token, null);
    });
  });

  describe('createBatch()', () => {
    it('inserts all items in a batch', () => {
      const items = jobIds.slice(0, 5).map((jid, i) => ({
        user_id: userId,
        job_id: jid,
        score: 70 + i,
        frequency: 'immediate',
      }));

      const inserted = repo.createBatch(items);
      assert.equal(inserted.length, 5, 'should insert all 5');
      assert.equal(inserted[0].score, 70);
      assert.equal(inserted[4].score, 74);
    });

    it('caps at 20 items', () => {
      const items = jobIds.map((jid, i) => ({
        user_id: userId,
        job_id: jid,
        score: 60 + i,
        frequency: 'immediate',
      }));

      assert.ok(items.length > 20, 'test needs more than 20 items');
      const inserted = repo.createBatch(items);
      assert.equal(inserted.length, 20, 'should cap at 20');
    });

    it('skips duplicates within batch', () => {
      // Pre-insert one
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });

      const items = jobIds.slice(0, 3).map((jid) => ({
        user_id: userId,
        job_id: jid,
        score: 75,
        frequency: 'immediate',
      }));

      const inserted = repo.createBatch(items);
      assert.equal(inserted.length, 2, 'should skip the existing duplicate');
    });
  });

  describe('findByUser()', () => {
    it('returns paginated notifications with joined job data', () => {
      // Insert 5 notifications
      const items = jobIds.slice(0, 5).map((jid, i) => ({
        user_id: userId,
        job_id: jid,
        score: 70 + i,
        frequency: 'immediate',
      }));
      repo.createBatch(items);

      const result = repo.findByUser(userId, { page: 1, perPage: 3 });
      assert.equal(result.notifications.length, 3);
      assert.equal(result.pagination.page, 1);
      assert.equal(result.pagination.per_page, 3);
      assert.equal(result.pagination.total, 5);
      assert.equal(result.pagination.total_pages, 2);

      // Verify joined job data
      const notif = result.notifications[0];
      assert.ok(notif.job_title, 'should have job_title from JOIN');
      assert.ok(notif.company_name !== undefined, 'should have company_name from JOIN');
      assert.ok(notif.source, 'should have source from JOIN');
    });

    it('filters by is_read', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      repo.create({ user_id: userId, job_id: jobIds[1], score: 75, frequency: 'immediate' });
      // Mark one as read
      const all = db.prepare('SELECT id FROM notifications WHERE user_id = ?').all(userId);
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(all[0].id);

      const unread = repo.findByUser(userId, { isRead: 0 });
      assert.equal(unread.notifications.length, 1);
      assert.equal(unread.pagination.total, 1);

      const read = repo.findByUser(userId, { isRead: 1 });
      assert.equal(read.notifications.length, 1);
      assert.equal(read.pagination.total, 1);
    });

    it('returns empty array for out-of-range page', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const result = repo.findByUser(userId, { page: 99, perPage: 20 });
      assert.equal(result.notifications.length, 0);
      assert.equal(result.pagination.total, 1);
    });

    it('orders by created_at DESC (newest first)', () => {
      // Insert with slight time difference by setting created_at explicitly
      db.prepare(
        `INSERT INTO notifications (user_id, job_id, score, frequency, created_at, updated_at)
         VALUES (?, ?, 80, 'immediate', '2026-01-01 10:00:00', '2026-01-01 10:00:00')`
      ).run(userId, jobIds[0]);
      db.prepare(
        `INSERT INTO notifications (user_id, job_id, score, frequency, created_at, updated_at)
         VALUES (?, ?, 90, 'immediate', '2026-01-02 10:00:00', '2026-01-02 10:00:00')`
      ).run(userId, jobIds[1]);

      const result = repo.findByUser(userId);
      assert.equal(result.notifications[0].score, 90, 'newest (higher date) should come first');
      assert.equal(result.notifications[1].score, 80);
    });
  });

  describe('getUnreadCount()', () => {
    it('returns accurate unread count', () => {
      repo.createBatch([
        { user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' },
        { user_id: userId, job_id: jobIds[1], score: 75, frequency: 'immediate' },
        { user_id: userId, job_id: jobIds[2], score: 70, frequency: 'immediate' },
      ]);

      assert.equal(repo.getUnreadCount(userId), 3);

      // Mark one as read
      const first = db.prepare('SELECT id FROM notifications WHERE user_id = ? LIMIT 1').get(userId);
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(first.id);

      assert.equal(repo.getUnreadCount(userId), 2);
    });

    it('returns 0 for user with no notifications', () => {
      assert.equal(repo.getUnreadCount(userId), 0);
    });
  });

  describe('markRead()', () => {
    it('marks notification as read with ownership check', () => {
      const notif = repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const updated = repo.markRead(notif.id, userId);
      assert.ok(updated);
      assert.equal(updated.is_read, 1);
    });

    it('returns null with wrong userId (ownership check)', () => {
      const notif = repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const result = repo.markRead(notif.id, 99999);
      assert.equal(result, null, 'wrong userId should return null');
    });

    it('returns null for non-existent notification', () => {
      const result = repo.markRead(99999, userId);
      assert.equal(result, null);
    });
  });

  describe('markAllRead()', () => {
    it('marks all unread as read and returns changed count', () => {
      repo.createBatch([
        { user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' },
        { user_id: userId, job_id: jobIds[1], score: 75, frequency: 'immediate' },
        { user_id: userId, job_id: jobIds[2], score: 70, frequency: 'immediate' },
      ]);

      // Mark one as already read
      const first = db.prepare('SELECT id FROM notifications WHERE user_id = ? LIMIT 1').get(userId);
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(first.id);

      const changed = repo.markAllRead(userId);
      assert.equal(changed, 2, 'should mark 2 unread as read');

      assert.equal(repo.getUnreadCount(userId), 0);
    });

    it('returns 0 when no unread notifications', () => {
      assert.equal(repo.markAllRead(userId), 0);
    });
  });

  describe('markReadByToken()', () => {
    it('marks notification by read_token', () => {
      const token = 'read-token-test-abcdef012345';
      repo.create({
        user_id: userId,
        job_id: jobIds[0],
        score: 80,
        frequency: 'immediate',
        read_token: token,
      });

      const updated = repo.markReadByToken(token);
      assert.ok(updated);
      assert.equal(updated.is_read, 1);
      assert.equal(updated.read_token, token);
    });

    it('returns null for non-existent token', () => {
      const result = repo.markReadByToken('nonexistent-token');
      assert.equal(result, null);
    });

    it('returns null if already read (idempotent)', () => {
      const token = 'already-read-token-xyz';
      repo.create({
        user_id: userId,
        job_id: jobIds[0],
        score: 80,
        frequency: 'immediate',
        read_token: token,
      });
      repo.markReadByToken(token);
      const secondCall = repo.markReadByToken(token);
      assert.equal(secondCall, null, 'already-read should return null');
    });
  });

  describe('getPendingEmails()', () => {
    it('returns pending emails filtered by frequency', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      repo.create({ user_id: userId, job_id: jobIds[1], score: 75, frequency: 'digest' });

      const immediate = repo.getPendingEmails('immediate');
      assert.equal(immediate.length, 1);
      assert.equal(immediate[0].frequency, 'immediate');
      assert.ok(immediate[0].job_title, 'should have joined job_title');
      assert.ok(immediate[0].user_email, 'should have joined user_email');

      const digest = repo.getPendingEmails('digest');
      assert.equal(digest.length, 1);
      assert.equal(digest[0].frequency, 'digest');
    });

    it('excludes already-sent emails', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const notif = db.prepare('SELECT id FROM notifications WHERE user_id = ? LIMIT 1').get(userId);
      db.prepare('UPDATE notifications SET email_sent = 1 WHERE id = ?').run(notif.id);

      const pending = repo.getPendingEmails('immediate');
      assert.equal(pending.length, 0);
    });
  });

  describe('markEmailSent()', () => {
    it('marks email as sent (status 1)', () => {
      const notif = repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const changes = repo.markEmailSent(notif.id, 1);
      assert.equal(changes, 1);

      const row = db.prepare('SELECT email_sent FROM notifications WHERE id = ?').get(notif.id);
      assert.equal(row.email_sent, 1);
    });

    it('marks email as failed (status 2)', () => {
      const notif = repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const changes = repo.markEmailSent(notif.id, 2);
      assert.equal(changes, 1);

      const row = db.prepare('SELECT email_sent FROM notifications WHERE id = ?').get(notif.id);
      assert.equal(row.email_sent, 2);
    });
  });

  describe('deleteOlderThan()', () => {
    it('deletes notifications older than N days', () => {
      // Insert an old notification
      db.prepare(
        `INSERT INTO notifications (user_id, job_id, score, frequency, created_at, updated_at)
         VALUES (?, ?, 80, 'immediate', datetime('now', '-100 days'), datetime('now', '-100 days'))`
      ).run(userId, jobIds[0]);

      // Insert a recent notification
      repo.create({ user_id: userId, job_id: jobIds[1], score: 75, frequency: 'immediate' });

      const deleted = repo.deleteOlderThan(90);
      assert.equal(deleted, 1, 'should delete 1 old notification');

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(userId).c;
      assert.equal(remaining, 1, 'recent one should remain');
    });

    it('returns 0 when no old notifications exist', () => {
      repo.create({ user_id: userId, job_id: jobIds[0], score: 80, frequency: 'immediate' });
      const deleted = repo.deleteOlderThan(90);
      assert.equal(deleted, 0);
    });
  });
});
