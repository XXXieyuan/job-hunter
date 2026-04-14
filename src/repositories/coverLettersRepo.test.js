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

describe('coverLettersRepo — countForResume', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  let userId1;
  let jobId1;
  let resumeId1;
  let resumeId2;

  before(() => {
    dbPath = path.join(require('os').tmpdir(), `cover-letters-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./coverLettersRepo')];
    repo = require('./coverLettersRepo');
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM cover_letters');
    db.exec('DELETE FROM resumes');
    db.exec('DELETE FROM jobs');
    db.exec('DELETE FROM users');

    db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('user1@test.com', 'hash1', 'user')").run();
    userId1 = db.prepare("SELECT id FROM users WHERE email = 'user1@test.com'").get().id;

    db.prepare("INSERT INTO jobs (title, company_name, source, external_id, role) VALUES ('Job A', 'Co A', 'test', 'cl-a', 'Engineer')").run();
    jobId1 = db.prepare("SELECT id FROM jobs WHERE external_id = 'cl-a'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'r1.docx', 1, 'Tech')").run(userId1);
    resumeId1 = db.prepare("SELECT id FROM resumes WHERE name = 'r1.docx'").get().id;

    db.prepare("INSERT INTO resumes (user_id, name, is_confirmed, label) VALUES (?, 'r2.docx', 1, 'Mgmt')").run(userId1);
    resumeId2 = db.prepare("SELECT id FROM resumes WHERE name = 'r2.docx'").get().id;
  });

  it('returns 0 when no cover letters for resume', () => {
    assert.equal(repo.countForResume(resumeId1), 0);
  });

  it('returns correct count for resume with cover letters', () => {
    repo.upsertCoverLetter({ job_id: jobId1, resume_id: resumeId1, user_id: userId1, content: 'letter1' });
    repo.upsertCoverLetter({ job_id: jobId1, resume_id: resumeId1, user_id: userId1, language: 'zh', content: 'letter2' });

    assert.equal(repo.countForResume(resumeId1), 2);
    assert.equal(repo.countForResume(resumeId2), 0, 'other resume should have 0');
  });
});
