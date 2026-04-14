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

describe('applicationProfilesRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId;

  before(() => {
    dbPath = path.join(os.tmpdir(), `app-profiles-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    delete require.cache[require.resolve('./applicationProfilesRepo')];
    repo = require('./applicationProfilesRepo');

    // Create a test user
    db.exec("INSERT INTO users (email, password_hash, role) VALUES ('profile-test@example.com', 'hash', 'user')");
    userId = db.prepare("SELECT id FROM users WHERE email = 'profile-test@example.com'").get().id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM application_profiles');
  });

  it('getByUserId returns null when no profile exists', () => {
    const result = repo.getByUserId(userId);
    assert.equal(result, null);
  });

  it('upsert creates a new profile', () => {
    const data = {
      full_name: 'Wei Zhang',
      email: 'wei@example.com',
      phone: '0412345678',
      visa_status: 'Australian Citizen',
      work_rights: 'Unrestricted',
      expected_salary: '$120,000',
      notice_period: '2 weeks',
    };

    repo.upsert(userId, data);

    const profile = repo.getByUserId(userId);
    assert.ok(profile);
    assert.equal(profile.user_id, userId);
    assert.equal(profile.full_name, 'Wei Zhang');
    assert.equal(profile.email, 'wei@example.com');
    assert.equal(profile.phone, '0412345678');
    assert.equal(profile.visa_status, 'Australian Citizen');
    assert.equal(profile.work_rights, 'Unrestricted');
    assert.equal(profile.expected_salary, '$120,000');
    assert.equal(profile.notice_period, '2 weeks');
    assert.ok(profile.created_at);
    assert.ok(profile.updated_at);
  });

  it('getByUserId returns the inserted profile', () => {
    repo.upsert(userId, {
      full_name: 'Sarah Connor',
      email: 'sarah@example.com',
      phone: '0400000000',
      visa_status: 'Permanent Resident',
      work_rights: 'Unrestricted',
    });

    const profile = repo.getByUserId(userId);
    assert.ok(profile);
    assert.equal(profile.full_name, 'Sarah Connor');
    assert.equal(profile.email, 'sarah@example.com');
  });

  it('upsert updates an existing profile', () => {
    repo.upsert(userId, {
      full_name: 'Original Name',
      email: 'original@example.com',
      phone: '0400000000',
      visa_status: 'Australian Citizen',
      work_rights: 'Unrestricted',
    });

    const before = repo.getByUserId(userId);
    const beforeUpdated = before.updated_at;

    // Small delay to ensure timestamp difference
    repo.upsert(userId, {
      full_name: 'Updated Name',
      email: 'updated@example.com',
      phone: '0411111111',
      visa_status: 'Permanent Resident',
      work_rights: 'Restricted',
      expected_salary: '$100,000',
      notice_period: '4 weeks',
    });

    const after = repo.getByUserId(userId);
    assert.equal(after.full_name, 'Updated Name');
    assert.equal(after.email, 'updated@example.com');
    assert.equal(after.phone, '0411111111');
    assert.equal(after.visa_status, 'Permanent Resident');
    assert.equal(after.work_rights, 'Restricted');
    assert.equal(after.expected_salary, '$100,000');
    assert.equal(after.notice_period, '4 weeks');
  });

  it('upsert handles optional fields as empty strings', () => {
    repo.upsert(userId, {
      full_name: 'Test User',
      email: 'test@example.com',
      phone: '0400000000',
      visa_status: 'Australian Citizen',
      work_rights: 'Unrestricted',
      expected_salary: '',
      notice_period: '',
    });

    const profile = repo.getByUserId(userId);
    assert.ok(profile);
    // Empty strings are falsy, so they become null via || null
    assert.equal(profile.expected_salary, null);
    assert.equal(profile.notice_period, null);
  });

  it('getByUserId returns null for non-existent user', () => {
    const result = repo.getByUserId(999999);
    assert.equal(result, null);
  });
});
