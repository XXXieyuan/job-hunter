'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const connectionModule = require('../db/connection');
const { _store: rateLimitStore } = require('../middleware/rateLimiter');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function applyMigrations(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)');

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
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
        if (cols.some((c) => c.name === column)) {
          processedSql = processedSql.replace(fullLine, `-- SKIPPED (exists): ${fullLine}`);
        }
      } catch (_) {
        /* table may not exist yet */
      }
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

/**
 * Minimal HTTP request simulator for Express router testing.
 * Calls route handlers directly without starting a server.
 */
function createMockReqRes(method, path, query = {}) {
  const req = {
    method,
    path,
    url: path + (Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''),
    query,
    params: {},
    headers: {},
    ip: '127.0.0.1',
    get: (header) => req.headers[header.toLowerCase()] || '',
    cookies: {},
    user: null,
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    rendered: null,
    locals: {
      t: (key, fallback) => fallback || key,
      localeData: require('../locales/en.json'),
      locale: 'en',
      currentPath: path,
      user: null,
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.headers['content-type'] = 'application/json';
      return this;
    },
    set(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    render(template, data) {
      this.rendered = { template, data };
      return this;
    },
  };

  return { req, res };
}

describe('salaryRoutes', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let salaryRoutes;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-salary-routes-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    // Seed test data
    const insert = db.prepare(`INSERT INTO jobs
      (title, company_name, location, source, salary_min, salary_max, is_active, role, aps_classification, scraped_at)
      VALUES (@title, @company, @location, @source, @salary_min, @salary_max, @is_active, @role, @aps_classification, @scraped_at)`);

    const seedJobs = [
      { title: 'Data Analyst', company: 'Corp A', location: 'Sydney', source: 'seek', salary_min: 80000, salary_max: 100000, is_active: 1, role: 'Data Analyst', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'Policy Officer', company: 'Dept X', location: 'Canberra', source: 'apsjobs', salary_min: 80000, salary_max: 86000, is_active: 1, role: 'Policy Officer', aps_classification: 'APS4', scraped_at: '2026-04-01' },
      { title: 'Software Dev', company: 'Corp B', location: 'Melbourne', source: 'linkedin', salary_min: 110000, salary_max: 140000, is_active: 1, role: 'Software Developer', aps_classification: null, scraped_at: '2026-04-01' },
    ];

    const insertMany = db.transaction((jobs) => {
      for (const j of jobs) insert.run(j);
    });
    insertMany(seedJobs);

    salaryRoutes = require('./salaryRoutes');
  });

  beforeEach(() => {
    // Clear rate limiter store between tests
    rateLimitStore.clear();
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  // Helper to find a matching route handler in the Express router
  function findHandler(method, routePath) {
    for (const layer of salaryRoutes.stack) {
      if (
        layer.route &&
        layer.route.path === routePath &&
        layer.route.methods[method.toLowerCase()]
      ) {
        // Return the last handler (skip middleware like rate limiter)
        const handlers = layer.route.stack;
        return handlers;
      }
    }
    return null;
  }

  async function callRoute(method, routePath, query = {}) {
    const handlers = findHandler(method, routePath);
    if (!handlers) throw new Error(`No handler found for ${method} ${routePath}`);

    const { req, res } = createMockReqRes(method, routePath, query);
    const next = (err) => {
      if (err) {
        res.statusCode = err.statusCode || 500;
        res.body = { error: err.message };
      }
    };

    for (const layer of handlers) {
      await new Promise((resolve, reject) => {
        try {
          const result = layer.handle(req, res, (err) => {
            if (err) {
              next(err);
            }
            resolve();
          });
          if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
          } else {
            // Sync handler - check if response was sent
            if (res.body !== null || res.rendered !== null) {
              resolve();
            }
          }
        } catch (e) {
          reject(e);
        }
      });
      // Stop if response was already sent
      if (res.body !== null || res.rendered !== null) break;
    }

    return res;
  }

  // B1: GET /salary-insights returns 200 HTML
  it('B1: GET /salary-insights renders page template', async () => {
    const res = await callRoute('GET', '/salary-insights');
    assert.equal(res.rendered.template, 'pages/salary-insights');
    assert.ok(res.rendered.data.initialData);
  });

  // B2: page embeds window.__salaryData
  it('B2: page data contains initialData with correct structure', async () => {
    const res = await callRoute('GET', '/salary-insights');
    const { initialData } = res.rendered.data;
    assert.ok(Array.isArray(initialData.groups));
    assert.ok(initialData.meta);
    assert.ok(typeof initialData.meta.total_listings === 'number');
    assert.ok(typeof initialData.meta.listings_with_salary === 'number');
    assert.ok(typeof initialData.meta.coverage_pct === 'number');
    assert.ok(typeof initialData.meta.truncated === 'boolean');
    assert.ok(initialData.filterOptions);
  });

  // B3: page embeds window.__salaryLocale
  it('B3: page data contains salaryLocale with salary.* keys', async () => {
    const res = await callRoute('GET', '/salary-insights');
    const { salaryLocale } = res.rendered.data;
    assert.ok(salaryLocale['salary.title']);
    assert.ok(salaryLocale['salary.subtitle']);
    assert.ok(salaryLocale['salary.filter.keyword']);
  });

  // B4: GET /api/salary-insights returns correct JSON schema
  it('B4: GET /api/salary-insights returns groups, meta, filters_applied', async () => {
    const res = await callRoute('GET', '/api/salary-insights');
    assert.equal(res.headers['content-type'], 'application/json');
    assert.ok(Array.isArray(res.body.groups));
    assert.ok(res.body.meta);
    assert.ok(typeof res.body.meta.total_matching === 'number');
    assert.ok(typeof res.body.meta.truncated === 'boolean');
    assert.ok(res.body.filters_applied);
  });

  // B5: invalid source returns 400
  it('B5: invalid source returns 400', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { source: 'indeed' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('source'));
  });

  // B6: invalid aps_level returns 400
  it('B6: invalid aps_level returns 400', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { aps_level: 'EL3' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('APS'));
  });

  // B7: keyword > 100 chars returns 400
  it('B7: keyword exceeding 100 chars returns 400', async () => {
    const longKeyword = 'a'.repeat(101);
    const res = await callRoute('GET', '/api/salary-insights', { keyword: longKeyword });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('100'));
  });

  // B8: invalid group_by returns 400
  it('B8: invalid group_by returns 400', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { group_by: 'title' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('group_by'));
  });

  // B9: zero results return 200 empty groups
  it('B9: zero results return 200 with empty groups array', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { keyword: 'nonexistentxyz123' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.groups, []);
    assert.equal(res.body.meta.total_matching, 0);
  });

  // B11: filters_applied always has all 4 keys
  it('B11: filters_applied always contains all 4 keys with null for unset', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { keyword: 'Data' });
    const fa = res.body.filters_applied;
    assert.ok('keyword' in fa);
    assert.ok('location' in fa);
    assert.ok('source' in fa);
    assert.ok('aps_level' in fa);
    assert.equal(fa.keyword, 'Data');
    assert.equal(fa.location, null);
    assert.equal(fa.source, null);
    assert.equal(fa.aps_level, null);
  });

  // B10: rate limit returns 429 on 31st request
  it('B10: rate limit returns 429 on 31st request', async () => {
    // Clear store to ensure clean state
    rateLimitStore.clear();

    // Send 30 requests (all should succeed)
    for (let i = 0; i < 30; i++) {
      const res = await callRoute('GET', '/api/salary-insights');
      assert.equal(res.statusCode, 200, `request ${i + 1} should succeed`);
    }

    // 31st request should be rate limited
    const res = await callRoute('GET', '/api/salary-insights');
    assert.equal(res.statusCode, 429);
    assert.equal(typeof res.body.error, 'string', 'error should be a flat string per contract');
    assert.equal(res.body.error, 'Too many requests — try again shortly');
  });

  // Valid filter combinations
  it('source filter works correctly', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { source: 'seek' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.filters_applied.source, 'seek');
  });

  it('group_by source works correctly', async () => {
    const res = await callRoute('GET', '/api/salary-insights', { group_by: 'source' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.groups));
  });
});
