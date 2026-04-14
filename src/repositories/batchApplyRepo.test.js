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

describe('batchApplyRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId;
  let jobId1;
  let jobId2;
  let jobId3;
  let resumeId;

  before(() => {
    dbPath = path.join(os.tmpdir(), `batch-apply-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./batchApplyRepo')];
    repo = require('./batchApplyRepo');

    // Create test user
    db.exec("INSERT INTO users (email, password_hash, role) VALUES ('batch-test@example.com', 'hash', 'user')");
    userId = db.prepare("SELECT id FROM users WHERE email = 'batch-test@example.com'").get().id;

    // Create test jobs
    db.exec("INSERT INTO jobs (title, role, source, external_id, company_name) VALUES ('Job 1', 'Dev', 'seek', 'batch-test-1', 'Company A')");
    db.exec("INSERT INTO jobs (title, role, source, external_id, company_name) VALUES ('Job 2', 'Dev', 'seek', 'batch-test-2', 'Company B')");
    db.exec("INSERT INTO jobs (title, role, source, external_id, company_name) VALUES ('Job 3', 'Dev', 'seek', 'batch-test-3', 'Company C')");
    jobId1 = db.prepare("SELECT id FROM jobs WHERE external_id = 'batch-test-1'").get().id;
    jobId2 = db.prepare("SELECT id FROM jobs WHERE external_id = 'batch-test-2'").get().id;
    jobId3 = db.prepare("SELECT id FROM jobs WHERE external_id = 'batch-test-3'").get().id;

    // Create a test resume for FK references
    db.exec(`INSERT INTO resumes (user_id, name, file_type, is_confirmed) VALUES (${userId}, 'test-resume.docx', 'docx', 1)`);
    resumeId = db.prepare(`SELECT id FROM resumes WHERE user_id = ?`).get(userId).id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM batch_apply_jobs');
    db.exec('DELETE FROM batch_apply_sessions');
  });

  describe('createSession', () => {
    it('returns a session id', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      assert.ok(sessionId);
      assert.equal(typeof sessionId, 'number');
    });

    it('creates a session with correct defaults', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.user_id, userId);
      assert.equal(session.total_jobs, 3);
      assert.equal(session.status, 'pending');
      assert.equal(session.applied_count, 0);
      assert.equal(session.failed_count, 0);
      assert.equal(session.skipped_count, 0);
    });
  });

  describe('createSessionWithJobs', () => {
    it('atomically creates session and jobs in one transaction', () => {
      const sessionId = repo.createSessionWithJobs(
        { userId, totalJobs: 3 },
        [jobId1, jobId2, jobId3],
        resumeId,
        [null, null, null]
      );

      assert.ok(sessionId);
      assert.equal(typeof sessionId, 'number');

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.user_id, userId);
      assert.equal(session.total_jobs, 3);
      assert.equal(session.status, 'pending');

      const jobs = db.prepare('SELECT * FROM batch_apply_jobs WHERE session_id = ? ORDER BY id ASC').all(sessionId);
      assert.equal(jobs.length, 3);
      assert.equal(jobs[0].job_id, jobId1);
      assert.equal(jobs[0].resume_id, resumeId);
      assert.equal(jobs[0].status, 'pending');
      assert.equal(jobs[1].job_id, jobId2);
      assert.equal(jobs[2].job_id, jobId3);
    });

    it('rolls back session if job insert fails', () => {
      const countBefore = db.prepare('SELECT COUNT(*) AS c FROM batch_apply_sessions WHERE user_id = ?').get(userId).c;

      assert.throws(() => {
        // Use an invalid job_id that violates FK constraint
        repo.createSessionWithJobs(
          { userId, totalJobs: 2 },
          [jobId1, 999999999],
          resumeId,
          [null, null]
        );
      });

      const countAfter = db.prepare('SELECT COUNT(*) AS c FROM batch_apply_sessions WHERE user_id = ?').get(userId).c;
      assert.equal(countAfter, countBefore, 'No orphaned session should remain after failed job insert');
    });
  });

  describe('createSessionJobs', () => {
    it('bulk-inserts jobs with pending status', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      repo.createSessionJobs(sessionId, [jobId1, jobId2, jobId3], resumeId, [null, null, null]);

      const jobs = db.prepare('SELECT * FROM batch_apply_jobs WHERE session_id = ? ORDER BY id ASC').all(sessionId);
      assert.equal(jobs.length, 3);
      assert.equal(jobs[0].job_id, jobId1);
      assert.equal(jobs[0].resume_id, resumeId);
      assert.equal(jobs[0].cover_letter_id, null);
      assert.equal(jobs[0].status, 'pending');
      assert.equal(jobs[1].job_id, jobId2);
      assert.equal(jobs[2].job_id, jobId3);
    });
  });

  describe('getActiveSession', () => {
    it('returns session for pending status', () => {
      repo.createSession({ userId, totalJobs: 1 });
      const active = repo.getActiveSession(userId);
      assert.ok(active);
      assert.equal(active.status, 'pending');
    });

    it('returns session for in-progress status', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.updateSessionStatus(sessionId, 'in-progress', { started_at: new Date().toISOString() });
      const active = repo.getActiveSession(userId);
      assert.ok(active);
      assert.equal(active.status, 'in-progress');
    });

    it('returns null for completed sessions', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.updateSessionStatus(sessionId, 'completed', { completed_at: new Date().toISOString() });
      const active = repo.getActiveSession(userId);
      assert.equal(active, null);
    });

    it('returns null for cancelled sessions', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.updateSessionStatus(sessionId, 'cancelled', { completed_at: new Date().toISOString() });
      const active = repo.getActiveSession(userId);
      assert.equal(active, null);
    });

    it('returns null when no sessions exist', () => {
      const active = repo.getActiveSession(userId);
      assert.equal(active, null);
    });
  });

  describe('getSession', () => {
    it('returns session by id', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 2 });
      const session = repo.getSession(sessionId);
      assert.ok(session);
      assert.equal(session.id, sessionId);
      assert.equal(session.total_jobs, 2);
    });

    it('returns null for non-existent session', () => {
      const session = repo.getSession(999999);
      assert.equal(session, null);
    });
  });

  describe('getSessionJobs', () => {
    it('joins with jobs table and orders by id ASC', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      repo.createSessionJobs(sessionId, [jobId1, jobId2, jobId3], resumeId, [null, null, null]);

      const jobs = repo.getSessionJobs(sessionId);
      assert.equal(jobs.length, 3);
      assert.equal(jobs[0].title, 'Job 1');
      assert.equal(jobs[0].company_name, 'Company A');
      assert.equal(jobs[1].title, 'Job 2');
      assert.equal(jobs[1].company_name, 'Company B');
      assert.equal(jobs[2].title, 'Job 3');
      assert.equal(jobs[2].company_name, 'Company C');
      // Verify ordering
      assert.ok(jobs[0].id < jobs[1].id);
      assert.ok(jobs[1].id < jobs[2].id);
    });
  });

  describe('updateJobStatus', () => {
    it('updates job status', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.createSessionJobs(sessionId, [jobId1], resumeId, [null]);
      const batchJob = db.prepare('SELECT id FROM batch_apply_jobs WHERE session_id = ?').get(sessionId);

      repo.updateJobStatus(batchJob.id, 'in-progress', { started_at: '2026-04-12T10:00:00Z' });
      const updated = db.prepare('SELECT * FROM batch_apply_jobs WHERE id = ?').get(batchJob.id);
      assert.equal(updated.status, 'in-progress');
      assert.equal(updated.started_at, '2026-04-12T10:00:00Z');
    });

    it('updates with optional fields', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.createSessionJobs(sessionId, [jobId1], resumeId, [null]);
      const batchJob = db.prepare('SELECT id FROM batch_apply_jobs WHERE session_id = ?').get(sessionId);

      repo.updateJobStatus(batchJob.id, 'failed', {
        error_reason: 'Form field not found',
        filled_fields: JSON.stringify(['name', 'email']),
        warnings: JSON.stringify(['salary field skipped']),
        completed_at: '2026-04-12T10:05:00Z',
      });

      const updated = db.prepare('SELECT * FROM batch_apply_jobs WHERE id = ?').get(batchJob.id);
      assert.equal(updated.status, 'failed');
      assert.equal(updated.error_reason, 'Form field not found');
      assert.equal(updated.filled_fields, JSON.stringify(['name', 'email']));
      assert.equal(updated.warnings, JSON.stringify(['salary field skipped']));
      assert.equal(updated.completed_at, '2026-04-12T10:05:00Z');
    });

    it('updates applied status with applied_at', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.createSessionJobs(sessionId, [jobId1], resumeId, [null]);
      const batchJob = db.prepare('SELECT id FROM batch_apply_jobs WHERE session_id = ?').get(sessionId);

      repo.updateJobStatus(batchJob.id, 'applied', {
        applied_at: '2026-04-12T10:10:00Z',
        completed_at: '2026-04-12T10:10:00Z',
      });

      const updated = db.prepare('SELECT * FROM batch_apply_jobs WHERE id = ?').get(batchJob.id);
      assert.equal(updated.status, 'applied');
      assert.equal(updated.applied_at, '2026-04-12T10:10:00Z');
    });
  });

  describe('incrementSessionCounter', () => {
    it('atomically increments applied_count', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      repo.incrementSessionCounter(sessionId, 'applied_count');
      repo.incrementSessionCounter(sessionId, 'applied_count');

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.applied_count, 2);
    });

    it('atomically increments failed_count', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      repo.incrementSessionCounter(sessionId, 'failed_count');

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.failed_count, 1);
    });

    it('atomically increments skipped_count', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 3 });
      repo.incrementSessionCounter(sessionId, 'skipped_count');

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.skipped_count, 1);
    });

    it('rejects invalid counter names', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      assert.throws(() => {
        repo.incrementSessionCounter(sessionId, 'total_jobs');
      }, /Invalid counter name/);
    });
  });

  describe('updateSessionStatus', () => {
    it('transitions session through lifecycle', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });

      repo.updateSessionStatus(sessionId, 'in-progress', { started_at: '2026-04-12T10:00:00Z' });
      let session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.status, 'in-progress');
      assert.equal(session.started_at, '2026-04-12T10:00:00Z');

      repo.updateSessionStatus(sessionId, 'completed', { completed_at: '2026-04-12T10:30:00Z' });
      session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.status, 'completed');
      assert.equal(session.completed_at, '2026-04-12T10:30:00Z');
    });
  });

  describe('getSessionsByUser', () => {
    it('returns paginated sessions ordered by created_at DESC', () => {
      // Create 3 sessions with distinct timestamps for deterministic ordering
      const s1 = repo.createSession({ userId, totalJobs: 1 });
      const s2 = repo.createSession({ userId, totalJobs: 2 });
      const s3 = repo.createSession({ userId, totalJobs: 3 });

      // Backdate to ensure deterministic ordering
      db.prepare("UPDATE batch_apply_sessions SET created_at = '2026-04-12 10:00:00' WHERE id = ?").run(s1);
      db.prepare("UPDATE batch_apply_sessions SET created_at = '2026-04-12 11:00:00' WHERE id = ?").run(s2);
      db.prepare("UPDATE batch_apply_sessions SET created_at = '2026-04-12 12:00:00' WHERE id = ?").run(s3);

      const page1 = repo.getSessionsByUser(userId, { page: 1, limit: 2 });
      assert.equal(page1.length, 2);
      // Most recent first
      assert.equal(page1[0].total_jobs, 3);
      assert.equal(page1[1].total_jobs, 2);

      const page2 = repo.getSessionsByUser(userId, { page: 2, limit: 2 });
      assert.equal(page2.length, 1);
      assert.equal(page2[0].total_jobs, 1);
    });

    it('returns empty array for out-of-range page', () => {
      repo.createSession({ userId, totalJobs: 1 });
      const page = repo.getSessionsByUser(userId, { page: 99, limit: 10 });
      assert.equal(page.length, 0);
    });

    it('uses default pagination values', () => {
      repo.createSession({ userId, totalJobs: 1 });
      const sessions = repo.getSessionsByUser(userId);
      assert.ok(Array.isArray(sessions));
      assert.equal(sessions.length, 1);
    });
  });

  describe('countSessionsByUser', () => {
    it('returns correct total count', () => {
      repo.createSession({ userId, totalJobs: 1 });
      repo.createSession({ userId, totalJobs: 2 });
      repo.createSession({ userId, totalJobs: 3 });

      const count = repo.countSessionsByUser(userId);
      assert.equal(count, 3);
    });

    it('returns 0 when no sessions exist', () => {
      const count = repo.countSessionsByUser(userId);
      assert.equal(count, 0);
    });
  });

  describe('recoverStaleSessions', () => {
    it('marks stale sessions as cancelled and their pending jobs as skipped', () => {
      // Create a session and manually backdate it
      const sessionId = repo.createSession({ userId, totalJobs: 2 });
      repo.createSessionJobs(sessionId, [jobId1, jobId2], resumeId, [null, null]);

      // Backdate session created_at to make it stale
      db.prepare(
        "UPDATE batch_apply_sessions SET created_at = datetime('now', '-120 minutes') WHERE id = ?"
      ).run(sessionId);

      const recovered = repo.recoverStaleSessions(60);
      assert.equal(recovered, 1);

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.status, 'cancelled');
      assert.ok(session.completed_at);

      const jobs = db.prepare('SELECT * FROM batch_apply_jobs WHERE session_id = ?').all(sessionId);
      for (const job of jobs) {
        assert.equal(job.status, 'skipped');
        assert.equal(job.error_reason, 'Server restarted during batch');
        assert.ok(job.completed_at);
      }
    });

    it('does not affect non-stale sessions', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.createSessionJobs(sessionId, [jobId1], resumeId, [null]);

      const recovered = repo.recoverStaleSessions(60);
      assert.equal(recovered, 0);

      const session = db.prepare('SELECT * FROM batch_apply_sessions WHERE id = ?').get(sessionId);
      assert.equal(session.status, 'pending');
    });

    it('does not affect completed sessions', () => {
      const sessionId = repo.createSession({ userId, totalJobs: 1 });
      repo.updateSessionStatus(sessionId, 'completed', { completed_at: new Date().toISOString() });

      // Backdate it
      db.prepare(
        "UPDATE batch_apply_sessions SET created_at = datetime('now', '-120 minutes') WHERE id = ?"
      ).run(sessionId);

      const recovered = repo.recoverStaleSessions(60);
      assert.equal(recovered, 0);
    });
  });
});
