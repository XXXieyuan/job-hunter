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

describe('optimizationSuggestionsRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId;
  let otherUserId;
  let jobId;
  let jobId2;
  let resumeId;

  const sampleSuggestions = JSON.stringify([
    {
      rank: 1,
      category: 'add_keyword',
      what: 'Add "Agile/Scrum" to Skills section',
      where: 'Skills',
      addresses: 'Agile project management (requirement #5)',
      predicted_delta: 4,
    },
  ]);

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-opt-sug-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    repo = require('./optimizationSuggestionsRepo');

    // Seed test data
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('opt-repo@test.com', 'hash', 'user')`);
    userId = db.prepare(`SELECT id FROM users WHERE email = 'opt-repo@test.com'`).get().id;

    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('opt-repo-other@test.com', 'hash', 'user')`);
    otherUserId = db.prepare(`SELECT id FROM users WHERE email = 'opt-repo-other@test.com'`).get().id;

    db.exec(`INSERT INTO jobs (title, company_name, location, role, source, external_id) VALUES ('Test Job 1', 'TestCo', 'Sydney', 'Dev', 'seek', 'opt-repo-job-1')`);
    jobId = db.prepare(`SELECT id FROM jobs WHERE external_id = 'opt-repo-job-1'`).get().id;

    db.exec(`INSERT INTO jobs (title, company_name, location, role, source, external_id) VALUES ('Test Job 2', 'TestCo2', 'Melbourne', 'Dev', 'seek', 'opt-repo-job-2')`);
    jobId2 = db.prepare(`SELECT id FROM jobs WHERE external_id = 'opt-repo-job-2'`).get().id;

    db.exec(`INSERT INTO resumes (user_id, name, is_confirmed) VALUES (${userId}, 'Test Resume', 1)`);
    resumeId = db.prepare(`SELECT id FROM resumes WHERE user_id = ?`).get(userId).id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    if (db) db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM optimization_suggestions');
  });

  describe('upsert()', () => {
    it('inserts a new suggestion row and getByJobAndResume retrieves it', () => {
      const id = repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      assert.ok(id, 'should return a row id');

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.ok(row, 'should retrieve the inserted row');
      assert.equal(row.job_id, jobId);
      assert.equal(row.resume_id, resumeId);
      assert.equal(row.user_id, userId);
      assert.equal(row.current_score, 68.2);
      assert.equal(row.predicted_score, 83.5);
      assert.equal(row.suggestions_json, sampleSuggestions);
      assert.equal(row.partial, 0);
      assert.ok(row.created_at);
    });

    it('replaces existing row for same job+resume — only 1 row with second values', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 60.0,
        predictedScore: 75.0,
        suggestionsJson: '[]',
        partial: 0,
      });

      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 1,
      });

      const count = db.prepare(
        'SELECT COUNT(*) AS c FROM optimization_suggestions WHERE job_id = ? AND resume_id = ?'
      ).get(jobId, resumeId).c;
      assert.equal(count, 1, 'should have only 1 row');

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.equal(row.current_score, 68.2, 'should have second upsert values');
      assert.equal(row.predicted_score, 83.5);
      assert.equal(row.partial, 1);
    });

    it('preserves other rows when replacing', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 60.0,
        predictedScore: 75.0,
        suggestionsJson: '[]',
        partial: 0,
      });

      repo.upsert({
        jobId: jobId2,
        resumeId,
        userId,
        currentScore: 70.0,
        predictedScore: 85.0,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const count = db.prepare('SELECT COUNT(*) AS c FROM optimization_suggestions').get().c;
      assert.equal(count, 2, 'both rows should exist independently');

      const row1 = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.equal(row1.current_score, 60.0);

      const row2 = repo.getByJobAndResume(jobId2, resumeId, userId);
      assert.equal(row2.current_score, 70.0);
    });
  });

  describe('getByJobAndResume()', () => {
    it('returns row when created < 24 hours ago', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.ok(row, 'should return non-null for recent row');
      assert.equal(row.current_score, 68.2);
      assert.equal(row.predicted_score, 83.5);
      assert.equal(row.suggestions_json, sampleSuggestions);
    });

    it('returns null when row is > 24 hours old', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      // Backdate to 25 hours ago
      db.prepare(
        `UPDATE optimization_suggestions SET created_at = datetime('now', '-25 hours')
         WHERE job_id = ? AND resume_id = ?`
      ).run(jobId, resumeId);

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.equal(row, null, 'expired row should return null');
    });

    it('computes stale: true when resume updated after suggestions', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      // Backdate suggestion to 2 hours ago, update resume to 1 hour ago
      db.prepare(
        `UPDATE optimization_suggestions SET created_at = datetime('now', '-2 hours')
         WHERE job_id = ? AND resume_id = ?`
      ).run(jobId, resumeId);
      db.prepare(
        `UPDATE resumes SET updated_at = datetime('now', '-1 hour') WHERE id = ?`
      ).run(resumeId);

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.ok(row, 'should return the row');
      assert.equal(row.stale, true, 'should be stale when resume updated after suggestions');
    });

    it('computes stale: false when resume unchanged', () => {
      // Set resume updated_at to 3 hours ago
      db.prepare(
        `UPDATE resumes SET updated_at = datetime('now', '-3 hours') WHERE id = ?`
      ).run(resumeId);

      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      assert.ok(row, 'should return the row');
      assert.equal(row.stale, false, 'should not be stale when resume not updated after suggestions');
    });

    it('returns null for different userId (IDOR prevention)', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const row = repo.getByJobAndResume(jobId, resumeId, otherUserId);
      assert.equal(row, null, 'should return null for wrong userId');
    });

    it('returns suggestions_json as parseable JSON string', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const row = repo.getByJobAndResume(jobId, resumeId, userId);
      const parsed = JSON.parse(row.suggestions_json);
      assert.ok(Array.isArray(parsed), 'should parse as array');
      assert.equal(parsed[0].rank, 1);
      assert.equal(parsed[0].category, 'add_keyword');
    });
  });

  describe('deleteOlderThan()', () => {
    it('removes old rows and preserves recent ones', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      // Backdate to 31 days ago
      db.prepare(
        `UPDATE optimization_suggestions SET created_at = datetime('now', '-31 days')
         WHERE job_id = ? AND resume_id = ?`
      ).run(jobId, resumeId);

      // Insert a recent one
      repo.upsert({
        jobId: jobId2,
        resumeId,
        userId,
        currentScore: 70.0,
        predictedScore: 85.0,
        suggestionsJson: '[]',
        partial: 0,
      });

      const deleted = repo.deleteOlderThan(30);
      assert.equal(deleted, 1, 'should delete 1 old row');

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM optimization_suggestions').get().c;
      assert.equal(remaining, 1, 'recent row should remain');
    });

    it('returns 0 when no old rows exist', () => {
      repo.upsert({
        jobId,
        resumeId,
        userId,
        currentScore: 68.2,
        predictedScore: 83.5,
        suggestionsJson: sampleSuggestions,
        partial: 0,
      });

      const deleted = repo.deleteOlderThan(30);
      assert.equal(deleted, 0);

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM optimization_suggestions').get().c;
      assert.equal(remaining, 1, 'all rows should be preserved');
    });
  });
});
