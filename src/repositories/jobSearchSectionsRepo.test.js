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

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
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
    try { db.exec(processedSql); } catch (e) { if (!e.message.includes('already exists')) throw e; }
    insertMigration.run(file);
  }
}

describe('jobSearchSectionsRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;
  let userId;
  let otherUserId;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-job-search-sections-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;
    repo = require('./jobSearchSectionsRepo');

    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('board-user@test.com', 'hash', 'user')`);
    userId = db.prepare(`SELECT id FROM users WHERE email = 'board-user@test.com'`).get().id;
    db.exec(`INSERT INTO users (email, password_hash, role) VALUES ('board-other@test.com', 'hash', 'user')`);
    otherUserId = db.prepare(`SELECT id FROM users WHERE email = 'board-other@test.com'`).get().id;
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM job_search_sections');
  });

  it('creates a named section with serialized filters', () => {
    const section = repo.create({
      user_id: userId,
      name: 'Canberra ICT',
      filters: {
        keyword: 'ICT software engineer',
        location: 'Canberra',
        source: ['seek', 'apsjobs'],
        minScore: 70,
      },
    });

    assert.ok(section.id);
    assert.equal(section.user_id, userId);
    assert.equal(section.name, 'Canberra ICT');
    assert.deepEqual(section.filters, {
      keyword: 'ICT software engineer',
      location: 'Canberra',
      source: ['seek', 'apsjobs'],
      minScore: 70,
    });
    assert.equal(typeof section.filters_json, 'string');
  });

  it('lists sections for one user in position order', () => {
    repo.create({ user_id: userId, name: 'Second', position: 20, filters: { keyword: 'AI' } });
    repo.create({ user_id: userId, name: 'First', position: 10, filters: { keyword: 'ICT' } });
    repo.create({ user_id: otherUserId, name: 'Other', position: 0, filters: { keyword: 'hidden' } });

    const sections = repo.listByUser(userId);

    assert.deepEqual(sections.map(s => s.name), ['First', 'Second']);
    assert.deepEqual(sections.map(s => s.filters.keyword), ['ICT', 'AI']);
  });

  it('updates and deletes only sections owned by the user', () => {
    const section = repo.create({ user_id: userId, name: 'Original', filters: { keyword: 'data' } });

    const deniedUpdate = repo.update(section.id, otherUserId, {
      name: 'Wrong user',
      filters: { keyword: 'wrong' },
    });
    assert.equal(deniedUpdate, null);

    const updated = repo.update(section.id, userId, {
      name: 'Data Roles',
      filters: { keyword: 'data engineer', location: 'Sydney' },
      position: 3,
    });
    assert.equal(updated.name, 'Data Roles');
    assert.equal(updated.position, 3);
    assert.deepEqual(updated.filters, { keyword: 'data engineer', location: 'Sydney' });

    assert.equal(repo.remove(section.id, otherUserId), 0);
    assert.equal(repo.remove(section.id, userId), 1);
    assert.equal(repo.getByIdForUser(section.id, userId), null);
  });
});
