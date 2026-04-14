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

describe('unsubscribeTokensRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId1;
  let userId2;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-unsub-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    repo = require('./unsubscribeTokensRepo');

    // Seed test users
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('unsub-repo1@test.com', 'hash', 'user')`);
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('unsub-repo2@test.com', 'hash', 'user')`);
    userId1 = db.prepare(`SELECT id FROM users WHERE email = 'unsub-repo1@test.com'`).get().id;
    userId2 = db.prepare(`SELECT id FROM users WHERE email = 'unsub-repo2@test.com'`).get().id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    if (db) db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM unsubscribe_tokens');
  });

  describe('create()', () => {
    it('creates a token with 64-char hex string', () => {
      const row = repo.create(userId1);
      assert.ok(row, 'should return a row');
      assert.equal(row.user_id, userId1);
      assert.equal(row.token.length, 64, 'token should be 64 hex chars');
      assert.ok(/^[0-9a-f]{64}$/.test(row.token), 'token should be lowercase hex');
      assert.ok(row.created_at);
    });

    it('returns null for duplicate user_id (UNIQUE constraint)', () => {
      repo.create(userId1);
      const dup = repo.create(userId1);
      assert.equal(dup, null, 'second create for same user should return null');
    });

    it('creates unique tokens for different users', () => {
      const row1 = repo.create(userId1);
      const row2 = repo.create(userId2);
      assert.ok(row1);
      assert.ok(row2);
      assert.notEqual(row1.token, row2.token, 'tokens should be different');
    });
  });

  describe('findByToken()', () => {
    it('returns correct row by token', () => {
      const created = repo.create(userId1);
      const found = repo.findByToken(created.token);
      assert.ok(found);
      assert.equal(found.id, created.id);
      assert.equal(found.user_id, userId1);
      assert.equal(found.token, created.token);
    });

    it('returns null for non-existent token', () => {
      const found = repo.findByToken('nonexistent-token-value');
      assert.equal(found, null);
    });
  });

  describe('findByUserId()', () => {
    it('returns correct row by userId', () => {
      const created = repo.create(userId1);
      const found = repo.findByUserId(userId1);
      assert.ok(found);
      assert.equal(found.id, created.id);
      assert.equal(found.token, created.token);
    });

    it('returns null for user with no token', () => {
      const found = repo.findByUserId(userId1);
      assert.equal(found, null);
    });
  });

  describe('getOrCreate()', () => {
    it('creates token on first call', () => {
      const row = repo.getOrCreate(userId1);
      assert.ok(row);
      assert.equal(row.user_id, userId1);
      assert.equal(row.token.length, 64);
    });

    it('returns existing token on second call', () => {
      const first = repo.getOrCreate(userId1);
      const second = repo.getOrCreate(userId1);
      assert.equal(first.id, second.id, 'should return same row');
      assert.equal(first.token, second.token, 'should return same token');
    });
  });
});
