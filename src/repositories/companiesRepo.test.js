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

describe('companiesRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  before(() => {
    dbPath = path.join(require('os').tmpdir(), `companies-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    // Re-require repo so it picks up the mocked getDb
    delete require.cache[require.resolve('./companiesRepo')];
    repo = require('./companiesRepo');
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch (_) {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM companies');
  });

  describe('upsertCompany COALESCE logic', () => {
    it('preserves existing non-null fields when incoming value is null', () => {
      // Insert a company with website and description set
      repo.upsertCompany({
        name: 'TestCo',
        website: 'https://example.com',
        description: 'Original',
        industry: 'Tech',
        size: '100-500',
        headquarters: 'Sydney, Australia',
        logo_url: 'https://logo.png',
        raw_json: '{"old":true}',
      });

      // Upsert with null website — should preserve the original
      repo.upsertCompany({
        name: 'TestCo',
        website: null,
        description: 'Updated',
        industry: null,
        size: null,
        headquarters: null,
        logo_url: null,
        raw_json: '{"new":true}',
      });

      const company = repo.getCompanyByName('TestCo');
      assert.equal(company.website, 'https://example.com', 'website should be preserved via COALESCE');
      assert.equal(company.description, 'Updated', 'description should be updated');
      assert.equal(company.industry, 'Tech', 'industry should be preserved via COALESCE');
      assert.equal(company.size, '100-500', 'size should be preserved via COALESCE');
      assert.equal(company.headquarters, 'Sydney, Australia', 'headquarters should be preserved via COALESCE');
      assert.equal(company.logo_url, 'https://logo.png', 'logo_url should be preserved via COALESCE');
    });

    it('always overwrites raw_json and researched_at', () => {
      repo.upsertCompany({
        name: 'TestCo2',
        website: 'https://example.com',
        description: 'Original',
        raw_json: '{"old":true}',
      });

      const before = repo.getCompanyByName('TestCo2');
      const oldResearchedAt = before.researched_at;

      repo.upsertCompany({
        name: 'TestCo2',
        description: 'Updated',
        raw_json: '{"new":true}',
      });

      const after = repo.getCompanyByName('TestCo2');
      assert.equal(after.raw_json, '{"new":true}', 'raw_json should always overwrite');
      // researched_at is set to CURRENT_TIMESTAMP on upsert, so it should be non-null
      assert.ok(after.researched_at, 'researched_at should be set');
    });

    it('INSERT path — COALESCE has no effect on new companies', () => {
      repo.upsertCompany({
        name: 'BrandNewCo',
        website: null,
        description: 'Brand New',
        industry: null,
        size: null,
        headquarters: null,
        raw_json: '{"fresh":true}',
      });

      const company = repo.getCompanyByName('BrandNewCo');
      assert.ok(company, 'company should exist');
      assert.equal(company.website, null, 'website should be null for new insert');
      assert.equal(company.description, 'Brand New', 'description should be set');
      assert.equal(company.industry, null, 'industry should be null for new insert');
      assert.ok(company.researched_at, 'researched_at should be set on insert');
    });

    it('updates non-null field with new non-null value', () => {
      repo.upsertCompany({
        name: 'UpdateCo',
        website: 'https://old.com',
        description: 'Old desc',
      });

      repo.upsertCompany({
        name: 'UpdateCo',
        website: 'https://new.com',
        description: 'New desc',
      });

      const company = repo.getCompanyByName('UpdateCo');
      assert.equal(company.website, 'https://new.com', 'non-null website should overwrite');
      assert.equal(company.description, 'New desc', 'non-null description should overwrite');
    });
  });

  describe('getAll', () => {
    it('returns all companies ordered by name', () => {
      repo.upsertCompany({ name: 'Zebra Corp', description: 'Z' });
      repo.upsertCompany({ name: 'Alpha Inc', description: 'A' });
      repo.upsertCompany({ name: 'Middle LLC', description: 'M' });

      const all = repo.getAll();
      assert.equal(all.length, 3);
      assert.equal(all[0].name, 'Alpha Inc');
      assert.equal(all[1].name, 'Middle LLC');
      assert.equal(all[2].name, 'Zebra Corp');
    });
  });

  describe('getCompanyByName', () => {
    it('returns null for non-existent company', () => {
      const result = repo.getCompanyByName('NonExistent');
      assert.equal(result, undefined);
    });

    it('returns company by exact name match', () => {
      repo.upsertCompany({ name: 'Exact Match Co', description: 'Found' });
      const result = repo.getCompanyByName('Exact Match Co');
      assert.ok(result);
      assert.equal(result.name, 'Exact Match Co');
      assert.equal(result.description, 'Found');
    });
  });
});
