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

describe('jobSearchService', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let service;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-job-search-service-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;
    service = require('./jobSearchService');
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  beforeEach(() => {
    db.exec('DELETE FROM job_fit_scores');
    db.exec('DELETE FROM jobs');
  });

  function insertJob({ title, source, location, description = '', externalId, salaryMin = null, salaryMax = null }) {
    db.prepare(
      `INSERT INTO jobs (external_id, source, role, title, company_name, location, description, salary_min, salary_max, is_active, posted_at)
       VALUES (@external_id, @source, 'general', @title, 'Example Co', @location, @description, @salary_min, @salary_max, 1, '2026-04-20')`
    ).run({ external_id: externalId, source, title, location, description, salary_min: salaryMin, salary_max: salaryMax });
  }

  it('finds jobs using keyword, location, source, and pagination filters', () => {
    insertJob({
      externalId: 'seek-ict-canberra',
      source: 'seek',
      title: 'ICT Software Engineer',
      location: 'Canberra ACT',
      description: 'Build public-sector software.',
    });
    insertJob({
      externalId: 'linkedin-ict-sydney',
      source: 'linkedin',
      title: 'ICT Software Engineer',
      location: 'Sydney NSW',
    });
    insertJob({
      externalId: 'seek-data-canberra',
      source: 'seek',
      title: 'Data Engineer',
      location: 'Canberra ACT',
    });

    const result = service.searchJobs({
      filters: {
        keyword: 'ICT software',
        location: 'Canberra',
        source: ['seek'],
      },
      sort: 'newest',
      page: 1,
      perPage: 10,
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].title, 'ICT Software Engineer');
    assert.equal(result.jobs[0].source, 'seek');
  });

  it('applies salary range filters and salary sort for board sections', () => {
    insertJob({
      externalId: 'seek-mid-canberra',
      source: 'seek',
      title: 'Software Engineer',
      location: 'Canberra ACT',
      salaryMin: 95000,
      salaryMax: 115000,
    });
    insertJob({
      externalId: 'seek-senior-canberra',
      source: 'seek',
      title: 'Senior Software Engineer',
      location: 'Canberra ACT',
      salaryMin: 135000,
      salaryMax: 155000,
    });

    const result = service.searchJobs({
      filters: {
        keyword: 'Software Engineer',
        location: 'Canberra',
        salaryMin: 120000,
      },
      sort: 'salary',
      page: 1,
      perPage: 10,
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.jobs[0].title, 'Senior Software Engineer');
    assert.equal(result.filters.salaryMin, 120000);
  });

  it('builds preview data for saved sections', () => {
    insertJob({
      externalId: 'aps-ai-canberra',
      source: 'apsjobs',
      title: 'AI Engineer',
      location: 'Canberra ACT',
      description: 'Artificial intelligence platform work.',
    });
    insertJob({
      externalId: 'seek-game-melbourne',
      source: 'seek',
      title: 'Unity Game Developer',
      location: 'Melbourne VIC',
      description: 'Unity gameplay systems.',
    });

    const previews = service.buildSectionPreviews([
      { id: 1, name: 'AI roles', filters: { keyword: 'AI engineer', location: 'Canberra' } },
      { id: 2, name: 'Game roles', filters: { keyword: 'Unity', location: 'Melbourne' } },
    ], { perSection: 5 });

    assert.equal(previews.length, 2);
    assert.equal(previews[0].totalCount, 1);
    assert.equal(previews[0].jobs[0].title, 'AI Engineer');
    assert.equal(previews[1].totalCount, 1);
    assert.equal(previews[1].jobs[0].title, 'Unity Game Developer');
  });
});
