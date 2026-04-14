'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// Tests for migration 010_batch_apply.sql (T-01)

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

describe('Batch Apply Migration (010)', () => {
  let db;
  let dbPath;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-batch-apply-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  it('application_profiles table exists with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(application_profiles)').all();
    const names = cols.map(c => c.name);
    const required = [
      'id', 'user_id', 'full_name', 'email', 'phone',
      'visa_status', 'work_rights', 'expected_salary',
      'notice_period', 'created_at', 'updated_at',
    ];
    for (const col of required) {
      assert.ok(names.includes(col), `application_profiles should have column: ${col}`);
    }
  });

  it('batch_apply_sessions table exists with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(batch_apply_sessions)').all();
    const names = cols.map(c => c.name);
    const required = [
      'id', 'user_id', 'status', 'total_jobs',
      'applied_count', 'failed_count', 'skipped_count',
      'started_at', 'completed_at', 'created_at',
    ];
    for (const col of required) {
      assert.ok(names.includes(col), `batch_apply_sessions should have column: ${col}`);
    }
  });

  it('batch_apply_jobs table exists with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(batch_apply_jobs)').all();
    const names = cols.map(c => c.name);
    const required = [
      'id', 'session_id', 'job_id', 'resume_id', 'cover_letter_id',
      'status', 'error_reason', 'filled_fields', 'warnings',
      'started_at', 'applied_at', 'completed_at', 'created_at',
    ];
    for (const col of required) {
      assert.ok(names.includes(col), `batch_apply_jobs should have column: ${col}`);
    }
  });

  it('has all 6 required indexes', () => {
    const allIndexes = db.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all();

    const expected = [
      { name: 'idx_application_profiles_user', table: 'application_profiles' },
      { name: 'idx_batch_sessions_user', table: 'batch_apply_sessions' },
      { name: 'idx_batch_sessions_status', table: 'batch_apply_sessions' },
      { name: 'idx_batch_jobs_session', table: 'batch_apply_jobs' },
      { name: 'idx_batch_jobs_job', table: 'batch_apply_jobs' },
      { name: 'idx_batch_jobs_status', table: 'batch_apply_jobs' },
    ];

    for (const idx of expected) {
      const found = allIndexes.find(i => i.name === idx.name && i.tbl_name === idx.table);
      assert.ok(found, `index ${idx.name} should exist on ${idx.table}`);
    }
  });

  it('UNIQUE(user_id) on application_profiles rejects duplicates', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('ba-unique@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'ba-unique@test.com'`).get();

    db.exec(`INSERT INTO application_profiles (user_id, full_name, email, phone, visa_status, work_rights)
             VALUES (${user.id}, 'Test User', 'ba@test.com', '0412345678', 'Australian Citizen', 'Unrestricted')`);

    assert.throws(() => {
      db.exec(`INSERT INTO application_profiles (user_id, full_name, email, phone, visa_status, work_rights)
               VALUES (${user.id}, 'Test User 2', 'ba2@test.com', '0412345679', 'Permanent Resident', 'Unrestricted')`);
    }, /UNIQUE constraint/);
  });

  it('FK cascade: deleting user removes all batch data', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('ba-cascade@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'ba-cascade@test.com'`).get();

    // Create profile
    db.exec(`INSERT INTO application_profiles (user_id, full_name, email, phone, visa_status, work_rights)
             VALUES (${user.id}, 'Cascade User', 'cascade@test.com', '0400000000', 'Australian Citizen', 'Unrestricted')`);

    // Create a job for the FK reference
    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('BA Cascade Job', 'Dev', 'seek', 'ba-cascade-test')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'ba-cascade-test'`).get();

    // Create session
    db.exec(`INSERT INTO batch_apply_sessions (user_id, total_jobs) VALUES (${user.id}, 1)`);
    const session = db.prepare(`SELECT id FROM batch_apply_sessions WHERE user_id = ${user.id}`).get();

    // Create session job
    db.exec(`INSERT INTO batch_apply_jobs (session_id, job_id) VALUES (${session.id}, ${job.id})`);

    // Delete user — all batch data should cascade
    db.exec(`DELETE FROM users WHERE id = ${user.id}`);

    const profiles = db.prepare('SELECT * FROM application_profiles WHERE user_id = ?').all(user.id);
    const sessions = db.prepare('SELECT * FROM batch_apply_sessions WHERE user_id = ?').all(user.id);
    const jobs = db.prepare('SELECT * FROM batch_apply_jobs WHERE session_id = ?').all(session.id);

    assert.equal(profiles.length, 0, 'application_profiles should be cascade-deleted');
    assert.equal(sessions.length, 0, 'batch_apply_sessions should be cascade-deleted');
    assert.equal(jobs.length, 0, 'batch_apply_jobs should be cascade-deleted');
  });

  it('batch_apply_sessions defaults are correct', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('ba-defaults@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'ba-defaults@test.com'`).get();

    db.exec(`INSERT INTO batch_apply_sessions (user_id, total_jobs) VALUES (${user.id}, 5)`);
    const session = db.prepare(`SELECT * FROM batch_apply_sessions WHERE user_id = ?`).get(user.id);

    assert.equal(session.status, 'pending', 'status defaults to pending');
    assert.equal(session.applied_count, 0, 'applied_count defaults to 0');
    assert.equal(session.failed_count, 0, 'failed_count defaults to 0');
    assert.equal(session.skipped_count, 0, 'skipped_count defaults to 0');
    assert.ok(session.created_at, 'created_at should be set');
  });

  it('batch_apply_jobs defaults are correct', () => {
    const session = db.prepare('SELECT id FROM batch_apply_sessions LIMIT 1').get();
    const job = db.prepare('SELECT id FROM jobs LIMIT 1').get();

    db.exec(`INSERT INTO batch_apply_jobs (session_id, job_id) VALUES (${session.id}, ${job.id})`);
    const batchJob = db.prepare(`SELECT * FROM batch_apply_jobs WHERE session_id = ? AND job_id = ?`).get(session.id, job.id);

    assert.equal(batchJob.status, 'pending', 'status defaults to pending');
    assert.equal(batchJob.error_reason, null, 'error_reason defaults to null');
    assert.equal(batchJob.filled_fields, null, 'filled_fields defaults to null');
    assert.equal(batchJob.warnings, null, 'warnings defaults to null');
    assert.ok(batchJob.created_at, 'created_at should be set');
  });

  it('batch_apply_jobs FK cascade: deleting session removes jobs', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('ba-sess-cascade@test.com', 'hash', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'ba-sess-cascade@test.com'`).get();

    db.exec(`INSERT INTO batch_apply_sessions (user_id, total_jobs) VALUES (${user.id}, 1)`);
    const session = db.prepare(`SELECT id FROM batch_apply_sessions WHERE user_id = ${user.id}`).get();

    const job = db.prepare('SELECT id FROM jobs LIMIT 1').get();
    db.exec(`INSERT INTO batch_apply_jobs (session_id, job_id) VALUES (${session.id}, ${job.id})`);

    // Delete session — batch_apply_jobs should cascade
    db.exec(`DELETE FROM batch_apply_sessions WHERE id = ${session.id}`);
    const remaining = db.prepare('SELECT * FROM batch_apply_jobs WHERE session_id = ?').all(session.id);
    assert.equal(remaining.length, 0, 'batch_apply_jobs should be cascade-deleted with session');
  });

  it('migration runs idempotently', () => {
    assert.doesNotThrow(() => {
      applyMigrations(db);
    });
  });
});
