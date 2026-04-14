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

describe('fitScoresRepo — multi-resume extensions', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  let userId1;
  let userId2;
  let jobId1;
  let jobId2;
  let jobId3;
  let resumeId1;
  let resumeId2;
  let resumeId3;

  before(() => {
    dbPath = path.join(require('os').tmpdir(), `fit-scores-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./fitScoresRepo')];
    repo = require('./fitScoresRepo');
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
    db.exec('DELETE FROM jobs');
    db.exec('DELETE FROM users');

    // Seed users
    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user1@test.com', 'hash1', 'user')").run();
    userId1 = db.prepare("SELECT id FROM users WHERE email = 'user1@test.com'").get().id;

    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user2@test.com', 'hash2', 'user')").run();
    userId2 = db.prepare("SELECT id FROM users WHERE email = 'user2@test.com'").get().id;

    // Seed jobs
    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job A', 'Co A', 'test', 'fs-a', 'Engineer')").run();
    jobId1 = db.prepare("SELECT id FROM jobs WHERE external_id = 'fs-a'").get().id;

    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job B', 'Co B', 'test', 'fs-b', 'Analyst')").run();
    jobId2 = db.prepare("SELECT id FROM jobs WHERE external_id = 'fs-b'").get().id;

    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job C', 'Co C', 'test', 'fs-c', 'Manager')").run();
    jobId3 = db.prepare("SELECT id FROM jobs WHERE external_id = 'fs-c'").get().id;

    // Seed resumes
    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'tech.docx', 1, 'Technical')").run(userId1);
    resumeId1 = db.prepare("SELECT id FROM resumes WHERE name = 'tech.docx'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'mgmt.docx', 1, 'Management')").run(userId1);
    resumeId2 = db.prepare("SELECT id FROM resumes WHERE name = 'mgmt.docx'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'user2.docx', 1, 'General')").run(userId2);
    resumeId3 = db.prepare("SELECT id FROM resumes WHERE name = 'user2.docx'").get().id;
  });

  describe('getScoresForJobByUser', () => {
    it('returns all scores for a job by user, sorted DESC', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 75 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 90 });

      const scores = repo.getScoresForJobByUser(jobId1, userId1);
      assert.equal(scores.length, 2);
      assert.equal(scores[0].overall_score, 90, 'highest score first');
      assert.equal(scores[0].resume_label, 'Management');
      assert.equal(scores[1].overall_score, 75);
      assert.equal(scores[1].resume_label, 'Technical');
    });

    it('does not return scores from other users', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 75 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId3, overall_score: 80 });

      const user1Scores = repo.getScoresForJobByUser(jobId1, userId1);
      assert.equal(user1Scores.length, 1);
      assert.equal(user1Scores[0].resume_id, resumeId1);
    });

    it('returns empty array when no scores exist', () => {
      const scores = repo.getScoresForJobByUser(jobId1, userId1);
      assert.equal(scores.length, 0);
    });
  });

  describe('getBestScorePerJobForUser', () => {
    it('returns best score per job with label', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 75 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 90 });
      repo.upsertFitScore({ job_id: jobId2, resume_id: resumeId1, overall_score: 80 });

      const results = repo.getBestScorePerJobForUser(userId1);
      assert.equal(results.length, 2, 'should return one result per job');

      const job1Result = results.find(r => r.job_id === jobId1);
      assert.equal(job1Result.display_score, 90);
      assert.equal(job1Result.display_label, 'Management');

      const job2Result = results.find(r => r.job_id === jobId2);
      assert.equal(job2Result.display_score, 80);
      assert.equal(job2Result.display_label, 'Technical');
    });

    it('uses MIN(resume_id) as tiebreaker when scores are equal', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 85 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 85 });

      const results = repo.getBestScorePerJobForUser(userId1);
      assert.equal(results.length, 1);
      assert.equal(results[0].display_resume_id, resumeId1, 'should pick lower resume_id on tie');
    });
  });

  describe('getBestScorePerJobForUserWithOverrides', () => {
    it('returns override score when override exists', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 90 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 70 });

      // Override to lower-scoring resume
      db.prepare('INSERT INTO resume_overrides (job_id, user_id, resume_id) VALUES (?, ?, ?)').run(jobId1, userId1, resumeId2);

      const results = repo.getBestScorePerJobForUserWithOverrides(userId1);
      const job1 = results.find(r => r.job_id === jobId1);
      assert.equal(job1.display_score, 70, 'should use override resume score');
      assert.equal(job1.display_label, 'Management');
      assert.equal(job1.display_resume_id, resumeId2);
    });

    it('falls back to best score when no override', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 90 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 70 });

      const results = repo.getBestScorePerJobForUserWithOverrides(userId1);
      const job1 = results.find(r => r.job_id === jobId1);
      assert.equal(job1.display_score, 90);
      assert.equal(job1.display_label, 'Technical');
    });
  });

  describe('deleteScoresForResume', () => {
    it('deletes all scores for the given resume', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 80 });
      repo.upsertFitScore({ job_id: jobId2, resume_id: resumeId1, overall_score: 85 });
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId2, overall_score: 75 });

      const deleted = repo.deleteScoresForResume(resumeId1);
      assert.equal(deleted, 2, 'should delete 2 scores');

      // Other resume scores unaffected
      const remaining = repo.countScoresForResume(resumeId2);
      assert.equal(remaining, 1);
    });
  });

  describe('countScoresForResume', () => {
    it('returns correct count', () => {
      repo.upsertFitScore({ job_id: jobId1, resume_id: resumeId1, overall_score: 80 });
      repo.upsertFitScore({ job_id: jobId2, resume_id: resumeId1, overall_score: 85 });

      assert.equal(repo.countScoresForResume(resumeId1), 2);
      assert.equal(repo.countScoresForResume(resumeId2), 0);
    });
  });
});
