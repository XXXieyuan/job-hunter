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

describe('resumesRepo — multi-resume extensions', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  let userId1;
  let userId2;

  before(() => {
    dbPath = path.join(require('os').tmpdir(), `resumes-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./resumesRepo')];
    repo = require('./resumesRepo');
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM resume_overrides');
    db.exec('DELETE FROM job_fit_scores');
    db.exec('DELETE FROM cover_letters');
    db.exec('DELETE FROM resumes');
    db.exec('DELETE FROM users');

    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user1@test.com', 'hash1', 'user')").run();
    userId1 = db.prepare("SELECT id FROM users WHERE email = 'user1@test.com'").get().id;

    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user2@test.com', 'hash2', 'user')").run();
    userId2 = db.prepare("SELECT id FROM users WHERE email = 'user2@test.com'").get().id;
  });

  describe('insertResume with label', () => {
    it('stores the label field', () => {
      const id = repo.insertResume({
        user_id: userId1,
        name: 'tech-resume.docx',
        label: 'Technical',
      });
      const resume = repo.getResumeById(id);
      assert.equal(resume.label, 'Technical', 'label should be stored');
    });

    it('stores null label when not provided', () => {
      const id = repo.insertResume({
        user_id: userId1,
        name: 'no-label.docx',
      });
      const resume = repo.getResumeById(id);
      assert.equal(resume.label, null, 'label should default to null');
    });
  });

  describe('countResumesForUser', () => {
    it('counts all resumes including unconfirmed', () => {
      repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 1, label: 'A' });
      repo.insertResume({ user_id: userId1, name: 'r2.docx', is_confirmed: 0, label: 'B' });
      repo.insertResume({ user_id: userId1, name: 'r3.docx', is_confirmed: 1, label: 'C' });

      assert.equal(repo.countResumesForUser(userId1), 3, 'should count all 3 resumes');
    });

    it('does not count other users resumes', () => {
      repo.insertResume({ user_id: userId1, name: 'r1.docx', label: 'A' });
      repo.insertResume({ user_id: userId2, name: 'r2.docx', label: 'B' });

      assert.equal(repo.countResumesForUser(userId1), 1);
      assert.equal(repo.countResumesForUser(userId2), 1);
    });
  });

  describe('countConfirmedResumesForUser', () => {
    it('counts only confirmed resumes', () => {
      repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 1, label: 'A' });
      repo.insertResume({ user_id: userId1, name: 'r2.docx', is_confirmed: 0, label: 'B' });
      repo.insertResume({ user_id: userId1, name: 'r3.docx', is_confirmed: 1, label: 'C' });

      assert.equal(repo.countConfirmedResumesForUser(userId1), 2, 'should count only confirmed');
    });
  });

  describe('getConfirmedResumesForUser', () => {
    it('returns all confirmed resumes for user', () => {
      repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 1, label: 'A' });
      repo.insertResume({ user_id: userId1, name: 'r2.docx', is_confirmed: 0, label: 'B' });
      repo.insertResume({ user_id: userId1, name: 'r3.docx', is_confirmed: 1, label: 'C' });

      const confirmed = repo.getConfirmedResumesForUser(userId1);
      assert.equal(confirmed.length, 2, 'should return 2 confirmed resumes');
      assert.ok(confirmed.every(r => r.is_confirmed === 1), 'all should be confirmed');
    });

    it('returns empty array when no confirmed resumes', () => {
      repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 0, label: 'A' });
      const confirmed = repo.getConfirmedResumesForUser(userId1);
      assert.equal(confirmed.length, 0);
    });
  });

  describe('getResumesWithCascadeCounts', () => {
    it('returns correct score_count and cover_letter_count', () => {
      const resumeId = repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 1, label: 'Tech' });

      // Seed a job
      db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job A', 'Co', 'test', 'test-cc1', 'Engineer')").run();
      const jobId = db.prepare("SELECT id FROM jobs WHERE external_id = 'test-cc1'").get().id;

      // Seed scores
      db.prepare('INSERT INTO job_fit_scores (job_id, resume_id, overall_score) VALUES (?, ?, 85)').run(jobId, resumeId);

      // Seed cover letters
      db.prepare("INSERT INTO cover_letters (job_id, resume_id, user_id, content) VALUES (?, ?, ?, 'test')").run(jobId, resumeId, userId1);
      db.prepare("INSERT INTO cover_letters (job_id, resume_id, user_id, language, content) VALUES (?, ?, ?, 'zh', 'test-zh')").run(jobId, resumeId, userId1);

      const results = repo.getResumesWithCascadeCounts(userId1);
      assert.equal(results.length, 1);
      assert.equal(results[0].file_name, 'r1.docx');
      assert.equal(results[0].label, 'Tech');
      assert.equal(results[0].score_count, 1, 'should have 1 score');
      assert.equal(results[0].cover_letter_count, 2, 'should have 2 cover letters');
    });

    it('returns 0 counts when no scores or cover letters', () => {
      repo.insertResume({ user_id: userId1, name: 'empty.docx', is_confirmed: 0, label: 'Empty' });

      const results = repo.getResumesWithCascadeCounts(userId1);
      assert.equal(results.length, 1);
      assert.equal(results[0].score_count, 0);
      assert.equal(results[0].cover_letter_count, 0);
    });
  });

  describe('updateLabel', () => {
    it('updates label for owned resume', () => {
      const id = repo.insertResume({ user_id: userId1, name: 'r1.docx', label: 'Old' });
      const changes = repo.updateLabel(id, userId1, 'New Label');
      assert.equal(changes, 1, 'should update 1 row');

      const resume = repo.getResumeById(id);
      assert.equal(resume.label, 'New Label');
    });

    it('returns 0 changes for wrong user_id', () => {
      const id = repo.insertResume({ user_id: userId1, name: 'r1.docx', label: 'Mine' });
      const changes = repo.updateLabel(id, userId2, 'Stolen');
      assert.equal(changes, 0, 'should not update resume owned by another user');

      const resume = repo.getResumeById(id);
      assert.equal(resume.label, 'Mine', 'label should remain unchanged');
    });
  });

  describe('deleteResume cascades to resume_overrides', () => {
    it('removes resume_overrides rows when resume is deleted', () => {
      const resumeId = repo.insertResume({ user_id: userId1, name: 'r1.docx', is_confirmed: 1, label: 'Tech' });

      // Seed a job and override
      db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job Del', 'Co', 'test', 'test-del', 'Manager')").run();
      const jobId = db.prepare("SELECT id FROM jobs WHERE external_id = 'test-del'").get().id;

      db.prepare('INSERT INTO resume_overrides (job_id, user_id, resume_id) VALUES (?, ?, ?)').run(jobId, userId1, resumeId);

      // Verify override exists
      const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM resume_overrides WHERE resume_id = ?').get(resumeId).c;
      assert.equal(beforeCount, 1);

      repo.deleteResume(resumeId, userId1);

      const afterCount = db.prepare('SELECT COUNT(*) AS c FROM resume_overrides WHERE resume_id = ?').get(resumeId).c;
      assert.equal(afterCount, 0, 'resume_overrides rows should be deleted');
    });
  });
});
