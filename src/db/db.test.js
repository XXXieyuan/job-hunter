'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

// T-01 through T-09: Database & Migration Tests

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

describe('Database & Migrations', () => {
  let db;
  let dbPath;

  before(() => {
    // Use a temp file DB so WAL mode works (WAL is not supported on :memory:)
    dbPath = path.join(os.tmpdir(), `jh-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);
  });

  after(() => {
    if (db) db.close();
    // Clean up temp files
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  // T-01: Migration runner executes idempotently on startup
  it('migrations run idempotently without errors (T-01)', () => {
    assert.doesNotThrow(() => {
      applyMigrations(db);
    });
  });

  // T-02: All 14 tables exist with correct schema
  it('all 14 tables exist after migrations (T-02)', () => {
    const expectedTables = [
      'users', 'sessions', 'jobs', 'jobs_fts', 'companies',
      'resumes', 'job_fit_scores', 'cover_letters', 'applications',
      'duplicate_groups', 'duplicate_group_members', 'scraper_runs',
      'analysis_runs', 'score_feedback',
    ];

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
    ).all().map(r => r.name);

    for (const t of expectedTables) {
      if (t === 'jobs_fts') {
        const ftsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs_fts'").get();
        assert.ok(ftsExists, 'jobs_fts virtual table should exist');
      } else {
        assert.ok(tables.includes(t), `Table ${t} should exist (found: ${tables.join(', ')})`);
      }
    }
  });

  // T-03: WAL mode enabled
  it('WAL mode is enabled on database connection (T-03)', () => {
    const result = db.pragma('journal_mode');
    assert.equal(result[0].journal_mode, 'wal');
  });

  // T-04: UNIQUE constraint on jobs.external_id
  it('enforces UNIQUE constraint on jobs.external_id (T-04)', () => {
    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Job A', 'Engineer', 'seek', 'seek-unique-001')`);

    assert.throws(() => {
      db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Job B', 'Engineer', 'seek', 'seek-unique-001')`);
    }, /UNIQUE constraint/);
  });

  // T-05: UNIQUE constraint on (job_fit_scores.job_id, resume_id)
  it('enforces UNIQUE constraint on (job_fit_scores.job_id, resume_id) (T-05)', () => {
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('score-user@test.com', 'hash123', 'user')`);
    const user = db.prepare(`SELECT id FROM users WHERE email = 'score-user@test.com'`).get();

    db.exec(`INSERT INTO jobs (title, role, source, external_id) VALUES ('Score Job', 'Dev', 'seek', 'seek-score-unique')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'seek-score-unique'`).get();

    db.exec(`INSERT INTO resumes (user_id, name) VALUES (${user.id}, 'Test Resume')`);
    const resume = db.prepare(`SELECT id FROM resumes WHERE user_id = ${user.id} LIMIT 1`).get();

    db.exec(`INSERT INTO job_fit_scores (job_id, resume_id, overall_score) VALUES (${job.id}, ${resume.id}, 75)`);

    assert.throws(() => {
      db.exec(`INSERT INTO job_fit_scores (job_id, resume_id, overall_score) VALUES (${job.id}, ${resume.id}, 80)`);
    }, /UNIQUE constraint/);
  });

  // T-06: UNIQUE constraint on (cover_letters.job_id, resume_id, language, mode)
  it('enforces UNIQUE constraint on cover_letters tuple (T-06)', () => {
    const user = db.prepare(`SELECT id FROM users LIMIT 1`).get();
    const job = db.prepare(`SELECT id FROM jobs LIMIT 1`).get();
    const resume = db.prepare(`SELECT id FROM resumes LIMIT 1`).get();

    // Use INSERT OR REPLACE to ensure the first row exists
    db.exec(`INSERT OR REPLACE INTO cover_letters (job_id, resume_id, user_id, language, mode, content)
             VALUES (${job.id}, ${resume.id}, ${user.id}, 'en', 'standard', 'test content')`);

    assert.throws(() => {
      db.exec(`INSERT INTO cover_letters (job_id, resume_id, user_id, language, mode, content)
               VALUES (${job.id}, ${resume.id}, ${user.id}, 'en', 'standard', 'different content')`);
    }, /UNIQUE constraint/);
  });

  // T-07: UNIQUE constraint on (applications.user_id, job_id)
  it('enforces UNIQUE constraint on (applications.user_id, job_id) (T-07)', () => {
    const user = db.prepare(`SELECT id FROM users LIMIT 1`).get();
    const job = db.prepare(`SELECT id FROM jobs LIMIT 1`).get();

    db.exec(`INSERT OR REPLACE INTO applications (user_id, job_id, status) VALUES (${user.id}, ${job.id}, 'saved')`);

    assert.throws(() => {
      db.exec(`INSERT INTO applications (user_id, job_id, status) VALUES (${user.id}, ${job.id}, 'applied')`);
    }, /UNIQUE constraint/);
  });

  // T-08: FTS5 virtual table populated via triggers
  it('FTS5 auto-populates via INSERT trigger on jobs (T-08)', () => {
    db.exec(`INSERT INTO jobs (title, role, source, external_id, description, company_name, location)
             VALUES ('FTS Test Engineer', 'Engineer', 'linkedin', 'ln-fts-unique', 'A great FTS job', 'FTSCorp', 'Canberra')`);

    const result = db.prepare(`SELECT * FROM jobs_fts WHERE jobs_fts MATCH 'FTS Test Engineer'`).all();
    assert.ok(result.length >= 1, 'FTS5 should contain the inserted job title');
  });

  // T-09: FTS5 trigger updates on job UPDATE
  it('FTS5 updates on job UPDATE (T-09)', () => {
    db.exec(`INSERT INTO jobs (title, role, source, external_id)
             VALUES ('Old Title XYZ', 'Dev', 'seek', 'seek-fts-update-unique')`);
    const job = db.prepare(`SELECT id FROM jobs WHERE external_id = 'seek-fts-update-unique'`).get();

    db.exec(`UPDATE jobs SET title = 'New Title ABC' WHERE id = ${job.id}`);

    const oldResults = db.prepare(`SELECT * FROM jobs_fts WHERE jobs_fts MATCH '"Old Title XYZ"'`).all();
    const newResults = db.prepare(`SELECT * FROM jobs_fts WHERE jobs_fts MATCH '"New Title ABC"'`).all();

    assert.equal(oldResults.length, 0, 'Old title should no longer match in FTS');
    assert.ok(newResults.length >= 1, 'New title should match in FTS');
  });

  // Verify schema columns for key tables
  it('users table has all required columns', () => {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    const names = cols.map(c => c.name);
    const required = ['id', 'email', 'password_hash', 'display_name', 'role', 'created_at'];
    for (const col of required) {
      assert.ok(names.includes(col), `users should have column: ${col}`);
    }
  });

  it('sessions table has all required columns', () => {
    const cols = db.prepare('PRAGMA table_info(sessions)').all();
    const names = cols.map(c => c.name);
    const required = ['id', 'user_id', 'token', 'expires_at', 'created_at'];
    for (const col of required) {
      assert.ok(names.includes(col), `sessions should have column: ${col}`);
    }
  });

  it('jobs table has all required columns per SYSTEM_DESIGN.md', () => {
    const cols = db.prepare('PRAGMA table_info(jobs)').all();
    const names = cols.map(c => c.name);
    const required = ['id', 'title', 'company_name', 'location', 'work_type', 'salary_min',
      'salary_max', 'source', 'external_id', 'posted_at', 'closes_at',
      'visa_eligibility', 'security_clearance', 'aps_classification',
      'is_active', 'embedding', 'url'];
    for (const col of required) {
      assert.ok(names.includes(col), `jobs should have column: ${col}`);
    }
  });

  it('job_fit_scores table has breakdown_json and values_international_experience columns', () => {
    const cols = db.prepare('PRAGMA table_info(job_fit_scores)').all();
    const names = cols.map(c => c.name);
    assert.ok(names.includes('breakdown_json'), 'should have breakdown_json');
    assert.ok(names.includes('values_international_experience'), 'should have values_international_experience');
  });

  it('resumes table has is_confirmed and updated_at columns', () => {
    const cols = db.prepare('PRAGMA table_info(resumes)').all();
    const names = cols.map(c => c.name);
    assert.ok(names.includes('is_confirmed'), 'should have is_confirmed');
    assert.ok(names.includes('updated_at'), 'should have updated_at');
  });

  it('duplicate_group_members table has source column', () => {
    const cols = db.prepare('PRAGMA table_info(duplicate_group_members)').all();
    const names = cols.map(c => c.name);
    assert.ok(names.includes('source'), 'should have source column');
  });
});
