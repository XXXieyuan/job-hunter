'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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

describe('resumeOverridesRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  // Test data IDs
  let userId1;
  let userId2;
  let jobId1;
  let jobId2;
  let resumeId1; // confirmed
  let resumeId2; // confirmed
  let resumeId3; // unconfirmed

  before(() => {
    dbPath = path.join(require('os').tmpdir(), `resume-overrides-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./resumeOverridesRepo')];
    repo = require('./resumeOverridesRepo');
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
  });

  beforeEach(() => {
    // Clear test tables in correct FK order
    db.exec('DELETE FROM resume_overrides');
    db.exec('DELETE FROM job_fit_scores');
    db.exec('DELETE FROM cover_letters');
    db.exec('DELETE FROM resumes');
    db.exec('DELETE FROM jobs');
    db.exec('DELETE FROM users');

    // Seed test users
    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user1@test.com', 'hash1', 'user')").run();
    userId1 = db.prepare("SELECT id FROM users WHERE email = 'user1@test.com'").get().id;

    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user2@test.com', 'hash2', 'user')").run();
    userId2 = db.prepare("SELECT id FROM users WHERE email = 'user2@test.com'").get().id;

    // Seed test jobs
    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job A', 'Co A', 'test', 'test-a', 'Engineer')").run();
    jobId1 = db.prepare("SELECT id FROM jobs WHERE external_id = 'test-a'").get().id;

    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job B', 'Co B', 'test', 'test-b', 'Analyst')").run();
    jobId2 = db.prepare("SELECT id FROM jobs WHERE external_id = 'test-b'").get().id;

    // Seed test resumes
    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'resume1.docx', 1, 'Technical')").run(userId1);
    resumeId1 = db.prepare("SELECT id FROM resumes WHERE name = 'resume1.docx'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'resume2.docx', 1, 'Management')").run(userId1);
    resumeId2 = db.prepare("SELECT id FROM resumes WHERE name = 'resume2.docx'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'resume3.docx', 0, 'Draft')").run(userId1);
    resumeId3 = db.prepare("SELECT id FROM resumes WHERE name = 'resume3.docx'").get().id;
  });

  describe('upsertOverride', () => {
    it('creates a new override row', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);

      const row = db.prepare('SELECT * FROM resume_overrides WHERE job_id = ? AND user_id = ?').get(jobId1, userId1);
      assert.ok(row, 'override row should exist');
      assert.equal(row.resume_id, resumeId1, 'resume_id should match');
      assert.equal(row.user_id, userId1, 'user_id should match');
    });

    it('updates existing override with different resume_id (no duplicate)', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);
      repo.upsertOverride(jobId1, userId1, resumeId2);

      const rows = db.prepare('SELECT * FROM resume_overrides WHERE job_id = ? AND user_id = ?').all(jobId1, userId1);
      assert.equal(rows.length, 1, 'should have exactly one row (upsert, not insert)');
      assert.equal(rows[0].resume_id, resumeId2, 'resume_id should be updated to second resume');
    });
  });

  describe('getOverride', () => {
    it('returns override when resume is confirmed', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);

      const result = repo.getOverride(jobId1, userId1);
      assert.ok(result, 'should return override');
      assert.equal(result.resume_id, resumeId1);
      assert.equal(result.job_id, jobId1);
      assert.equal(result.user_id, userId1);
    });

    it('returns null/undefined for unconfirmed resume override', () => {
      repo.upsertOverride(jobId1, userId1, resumeId3);

      const result = repo.getOverride(jobId1, userId1);
      assert.equal(result, undefined, 'should return undefined for unconfirmed resume');
    });

    it('returns undefined when no override exists', () => {
      const result = repo.getOverride(jobId1, userId1);
      assert.equal(result, undefined, 'should return undefined when no override');
    });
  });

  describe('deleteOverride', () => {
    it('removes an existing override', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);
      const changes = repo.deleteOverride(jobId1, userId1);

      assert.equal(changes, 1, 'should delete one row');
      const row = db.prepare('SELECT * FROM resume_overrides WHERE job_id = ? AND user_id = ?').get(jobId1, userId1);
      assert.equal(row, undefined, 'override should be gone');
    });

    it('is idempotent — deleting non-existent override returns 0', () => {
      const changes = repo.deleteOverride(jobId1, userId1);
      assert.equal(changes, 0, 'should return 0 when nothing to delete');
    });
  });

  describe('hasOverrides', () => {
    it('returns false when user has no overrides', () => {
      assert.equal(repo.hasOverrides(userId1), false);
    });

    it('returns true after upsert', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);
      assert.equal(repo.hasOverrides(userId1), true);
    });

    it('returns false after all overrides deleted', () => {
      repo.upsertOverride(jobId1, userId1, resumeId1);
      repo.deleteOverride(jobId1, userId1);
      assert.equal(repo.hasOverrides(userId1), false);
    });
  });

  describe('cross-user isolation', () => {
    it('overrides for one user do not affect another', () => {
      // Seed a resume for user2
      db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'resume4.docx', 1, 'User2 Resume')").run(userId2);
      const resumeIdUser2 = db.prepare("SELECT MAX(id) AS id FROM resumes WHERE name = 'resume4.docx'").get().id;

      repo.upsertOverride(jobId1, userId1, resumeId1);
      repo.upsertOverride(jobId1, userId2, resumeIdUser2);

      assert.equal(repo.hasOverrides(userId1), true);
      assert.equal(repo.hasOverrides(userId2), true);

      // Deleting user1's override does not affect user2
      repo.deleteOverride(jobId1, userId1);
      assert.equal(repo.hasOverrides(userId1), false);
      assert.equal(repo.hasOverrides(userId2), true);

      const user2Override = repo.getOverride(jobId1, userId2);
      assert.ok(user2Override, 'user2 override should still exist');
      assert.equal(user2Override.resume_id, resumeIdUser2);
    });
  });
});
