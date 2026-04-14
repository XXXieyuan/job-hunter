'use strict';

const { describe, it, before, after } = require('node:test');
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

describe('salaryAnalysisRepo', () => {
  let db;
  let dbPath;
  let originalGetDb;
  let repo;

  before(() => {
    dbPath = path.join(os.tmpdir(), `jh-salary-repo-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db);

    // Monkey-patch getDb to return our test database
    originalGetDb = connectionModule.getDb;
    connectionModule.getDb = () => db;

    // Require repo after patching
    repo = require('./salaryAnalysisRepo');

    // Seed test data
    const insert = db.prepare(`INSERT INTO jobs
      (title, company_name, location, source, salary_min, salary_max, is_active, role, aps_classification, scraped_at)
      VALUES (@title, @company, @location, @source, @salary_min, @salary_max, @is_active, @role, @aps_classification, @scraped_at)`);

    const seedJobs = [
      // Sydney jobs
      { title: 'Data Analyst', company: 'Corp A', location: 'Sydney', source: 'seek', salary_min: 80000, salary_max: 100000, is_active: 1, role: 'Data Analyst', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'Data Analyst Senior', company: 'Corp B', location: 'Sydney', source: 'seek', salary_min: 95000, salary_max: 120000, is_active: 1, role: 'Data Analyst', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'Data Engineer', company: 'Corp C', location: 'Sydney', source: 'linkedin', salary_min: 110000, salary_max: 140000, is_active: 1, role: 'Data Engineer', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'Software Engineer', company: 'Corp D', location: 'Sydney', source: 'seek', salary_min: 120000, salary_max: 150000, is_active: 1, role: 'Software Engineer', aps_classification: null, scraped_at: '2026-04-01' },
      // Canberra jobs
      { title: 'Policy Analyst', company: 'Dept X', location: 'Canberra', source: 'apsjobs', salary_min: 80000, salary_max: 86000, is_active: 1, role: 'Policy Analyst', aps_classification: 'APS4', scraped_at: '2026-04-01' },
      { title: 'Senior Analyst', company: 'Dept Y', location: 'Canberra', source: 'apsjobs', salary_min: 94000, salary_max: 107000, is_active: 1, role: 'Senior Analyst', aps_classification: 'APS6', scraped_at: '2026-04-01' },
      { title: 'Director', company: 'Dept Z', location: 'Canberra', source: 'apsjobs', salary_min: 132000, salary_max: 161000, is_active: 1, role: 'Director', aps_classification: 'EL2', scraped_at: '2026-04-01' },
      { title: 'Team Lead', company: 'Dept W', location: 'Canberra', source: 'apsjobs', salary_min: 115000, salary_max: 131000, is_active: 1, role: 'Team Lead', aps_classification: 'EL1', scraped_at: '2026-04-01' },
      // Melbourne job
      { title: 'Data Analyst', company: 'Corp E', location: 'Melbourne', source: 'seek', salary_min: 75000, salary_max: 90000, is_active: 1, role: 'Data Analyst', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'DevOps Engineer', company: 'Corp F', location: 'Melbourne', source: 'linkedin', salary_min: 130000, salary_max: 160000, is_active: 1, role: 'DevOps', aps_classification: null, scraped_at: '2026-04-01' },
      // Outlier jobs (should be excluded)
      { title: 'Intern', company: 'Corp G', location: 'Sydney', source: 'seek', salary_min: 5000, salary_max: 10000, is_active: 1, role: 'Intern', aps_classification: null, scraped_at: '2026-04-01' },
      { title: 'CEO', company: 'Corp H', location: 'Sydney', source: 'seek', salary_min: 600000, salary_max: 800000, is_active: 1, role: 'CEO', aps_classification: null, scraped_at: '2026-04-01' },
      // Inactive job (should be excluded)
      { title: 'Old Analyst', company: 'Corp I', location: 'Sydney', source: 'seek', salary_min: 90000, salary_max: 110000, is_active: 0, role: 'Analyst', aps_classification: null, scraped_at: '2026-03-01' },
      // Job without salary (should be excluded from distribution but count in meta)
      { title: 'Mystery Role', company: 'Corp J', location: 'Sydney', source: 'seek', salary_min: null, salary_max: null, is_active: 1, role: 'Mystery', aps_classification: null, scraped_at: '2026-04-01' },
      // Job with salary_min but no salary_max
      { title: 'Budget Analyst', company: 'Corp K', location: 'Sydney', source: 'seek', salary_min: 70000, salary_max: null, is_active: 1, role: 'Budget Analyst', aps_classification: null, scraped_at: '2026-04-01' },
    ];

    const insertMany = db.transaction((jobs) => {
      for (const j of jobs) {
        insert.run(j);
      }
    });
    insertMany(seedJobs);
  });

  after(() => {
    connectionModule.getDb = originalGetDb;
    db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  // T-A1: getDistribution with known data verifies correct median/Q1/Q3/min/max per group
  it('A1: computes correct percentile statistics per group', () => {
    const result = repo.getDistribution({});
    assert.ok(result.groups.length > 0, 'should have at least one group');
    assert.ok(result.meta.total_matching > 0);

    // Sydney should have the most jobs (5 salary-bearing active jobs)
    const sydney = result.groups.find((g) => g.label === 'Sydney');
    assert.ok(sydney, 'should have Sydney group');
    assert.equal(sydney.count, 5); // 80k, 95k, 110k, 120k, 70k
    assert.equal(sydney.min, 70000);
    assert.ok(sydney.q1 >= 70000 && sydney.q1 <= 95000);
    assert.ok(sydney.median >= 70000 && sydney.median <= 120000);
    assert.ok(sydney.q3 >= 95000 && sydney.q3 <= 120000);
    // max uses salary_max where available
    assert.equal(sydney.max, 150000);
  });

  // T-A2: keyword filter on title and role
  it('A2: keyword filter matches title and role', () => {
    const result = repo.getDistribution({ keyword: 'Data Analyst' });
    const total = result.groups.reduce((s, g) => s + g.count, 0);
    // Should match "Data Analyst", "Data Analyst Senior" (title), "Data Analyst" (role) in multiple locations
    assert.ok(total >= 3, `expected at least 3 matches, got ${total}`);
  });

  // T-A3: location partial LIKE match
  it('A3: location filter uses partial match', () => {
    const result = repo.getDistribution({ location: 'Syd' });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].label, 'Sydney');
  });

  // T-A4: source exact match
  it('A4: source filter uses exact match', () => {
    const result = repo.getDistribution({ source: 'apsjobs' });
    const total = result.groups.reduce((s, g) => s + g.count, 0);
    assert.equal(total, 4); // 4 apsjobs jobs
  });

  // T-A5: APS level specific and 'all' mode with hierarchy ordering
  it('A5: APS level filter works with specific level', () => {
    const result = repo.getDistribution({ aps_level: 'APS6', group_by: 'aps_classification' });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].label, 'APS6');
    assert.equal(result.groups[0].count, 1);
  });

  it('A5: APS level "all" returns hierarchy-ordered groups', () => {
    const result = repo.getDistribution({ aps_level: 'all', group_by: 'aps_classification' });
    assert.ok(result.groups.length >= 3); // APS4, APS6, EL1, EL2
    // Verify hierarchy ordering
    const labels = result.groups.map((g) => g.label);
    const indices = labels.map((l) => repo._APS_HIERARCHY.indexOf(l));
    for (let i = 1; i < indices.length; i++) {
      assert.ok(indices[i] > indices[i - 1], `${labels[i]} should come after ${labels[i - 1]}`);
    }
  });

  // T-A6: outlier exclusion
  it('A6: excludes outlier salaries below $20K or above $500K', () => {
    const result = repo.getDistribution({});
    const allLabels = result.groups.flatMap((g) => [g.label]);
    // The intern ($5K) and CEO ($600K) should not appear in any group counts
    const total = result.groups.reduce((s, g) => s + g.count, 0);
    // 10 valid salary-bearing active jobs + 1 Budget Analyst = 11
    assert.equal(total, 11, `expected 11 valid jobs, got ${total}`);
  });

  // T-A7: row cap and truncated flag (can't easily test 10K rows but verify flag is false for small data)
  it('A7: truncated flag is false when below row cap', () => {
    const result = repo.getDistribution({});
    assert.equal(result.meta.truncated, false);
  });

  // T-A8: top 10 groups by count descending (default sorting)
  it('A8: groups sorted by count descending (non-APS mode)', () => {
    const result = repo.getDistribution({});
    for (let i = 1; i < result.groups.length; i++) {
      assert.ok(
        result.groups[i - 1].count >= result.groups[i].count,
        'groups should be sorted by count descending'
      );
    }
  });

  // T-A9: getFilterOptions returns only valid salary-bearing values
  it('A9: getFilterOptions returns locations, sources, aps_classifications', () => {
    const options = repo.getFilterOptions();
    assert.ok(Array.isArray(options.locations));
    assert.ok(Array.isArray(options.sources));
    assert.ok(Array.isArray(options.aps_classifications));

    // Should have Canberra, Melbourne, Sydney (alphabetical)
    assert.ok(options.locations.includes('Canberra'));
    assert.ok(options.locations.includes('Sydney'));
    assert.ok(options.locations.includes('Melbourne'));

    // Should have apsjobs, linkedin, seek (alphabetical)
    assert.ok(options.sources.includes('seek'));
    assert.ok(options.sources.includes('apsjobs'));

    // APS classifications ordered by hierarchy
    const apsIdx = options.aps_classifications.map((c) => repo._APS_HIERARCHY.indexOf(c));
    for (let i = 1; i < apsIdx.length; i++) {
      assert.ok(apsIdx[i] > apsIdx[i - 1], 'APS classifications should be hierarchy-ordered');
    }
  });

  // T-A10: getMeta coverage_pct computation
  it('A10: getMeta returns correct coverage percentage', () => {
    const meta = repo.getMeta();
    assert.ok(meta.total_listings > 0);
    assert.ok(meta.listings_with_salary > 0);
    assert.ok(meta.coverage_pct > 0 && meta.coverage_pct <= 100);
    // total_listings includes active jobs (with and without salary, excluding inactive)
    // 11 active jobs with salary + 1 without salary + 2 outliers = 14 active
    assert.equal(meta.total_listings, 14);
    // All active jobs have salary_min set except "Mystery Role"
    assert.equal(meta.listings_with_salary, 13);
    const expected = Math.round((13 / 14) * 1000) / 10;
    assert.equal(meta.coverage_pct, expected);
  });

  // T-A11: salary_max fallback to salary_min for max field
  it('A11: max uses salary_max when available, falls back to salary_min', () => {
    // Budget Analyst has salary_min=70000 but no salary_max
    // Sydney group includes this job
    const result = repo.getDistribution({ location: 'Sydney' });
    const sydney = result.groups[0];
    // max should be the largest salary_max among Sydney jobs (150000 from Software Engineer)
    assert.equal(sydney.max, 150000);

    // For a single-job group with no salary_max, max should equal salary_min
    // Budget Analyst filtered alone
    const result2 = repo.getDistribution({ keyword: 'Budget Analyst' });
    assert.equal(result2.groups.length, 1);
    const group = result2.groups[0];
    assert.equal(group.min, 70000);
    // salary_max is null, so max should fallback to salary_min
    assert.equal(group.max, 70000);
  });

  // T-A11b: mixed-null salary_max — high salary_min with null salary_max should win over lower salary_max
  it('A11b: max uses salary_min fallback when it exceeds other salary_max values', () => {
    // Add a job with high salary_min but null salary_max in a group with lower salary_max
    db.prepare(`INSERT INTO jobs
      (title, company_name, location, source, salary_min, salary_max, is_active, role, aps_classification, scraped_at)
      VALUES (@title, @company, @location, @source, @salary_min, @salary_max, @is_active, @role, @aps_classification, @scraped_at)`)
      .run({
        title: 'Highly Paid Analyst', company: 'Corp Z', location: 'Perth',
        source: 'seek', salary_min: 200000, salary_max: null,
        is_active: 1, role: 'Analyst', aps_classification: null, scraped_at: '2026-04-01',
      });
    db.prepare(`INSERT INTO jobs
      (title, company_name, location, source, salary_min, salary_max, is_active, role, aps_classification, scraped_at)
      VALUES (@title, @company, @location, @source, @salary_min, @salary_max, @is_active, @role, @aps_classification, @scraped_at)`)
      .run({
        title: 'Regular Analyst', company: 'Corp Y', location: 'Perth',
        source: 'seek', salary_min: 100000, salary_max: 110000,
        is_active: 1, role: 'Analyst', aps_classification: null, scraped_at: '2026-04-01',
      });

    const result = repo.getDistribution({ location: 'Perth' });
    assert.equal(result.groups.length, 1);
    const perth = result.groups[0];
    // Max should be 200000 (salary_min fallback), not 110000 (salary_max of other job)
    assert.equal(perth.max, 200000);
  });

  // T-A12: inactive jobs excluded
  it('A12: inactive jobs are excluded from all results', () => {
    const result = repo.getDistribution({ keyword: 'Old Analyst' });
    const total = result.groups.reduce((s, g) => s + g.count, 0);
    assert.equal(total, 0, 'inactive jobs should be excluded');
  });

  // T-A13: percentile edge cases
  it('A13: percentile with single job returns identical Q1/median/Q3', () => {
    const result = repo.getDistribution({ keyword: 'Director' });
    const total = result.groups.reduce((s, g) => s + g.count, 0);
    assert.equal(total, 1);
    const group = result.groups[0];
    assert.equal(group.q1, group.median);
    assert.equal(group.median, group.q3);
    assert.equal(group.min, group.median);
  });

  it('percentile function computes linear interpolation correctly', () => {
    // Known values: [10, 20, 30, 40, 50]
    const sorted = [10, 20, 30, 40, 50];
    assert.equal(repo._percentile(sorted, 0.5), 30);     // median
    assert.equal(repo._percentile(sorted, 0.25), 20);    // Q1 at index 1
    assert.equal(repo._percentile(sorted, 0.75), 40);    // Q3 at index 3
    assert.equal(repo._percentile(sorted, 0), 10);       // min
    assert.equal(repo._percentile(sorted, 1), 50);       // max
  });

  it('percentile with two values interpolates correctly', () => {
    const sorted = [100, 200];
    assert.equal(repo._percentile(sorted, 0.25), 125);
    assert.equal(repo._percentile(sorted, 0.5), 150);
    assert.equal(repo._percentile(sorted, 0.75), 175);
  });

  // group_by validation
  it('throws on invalid group_by value', () => {
    assert.throws(() => repo.getDistribution({ group_by: 'title' }), /Invalid group_by/);
  });

  // group_by source
  it('groups by source dimension correctly', () => {
    const result = repo.getDistribution({ group_by: 'source' });
    assert.ok(result.groups.length > 0);
    const labels = result.groups.map((g) => g.label);
    assert.ok(labels.includes('seek') || labels.includes('apsjobs') || labels.includes('linkedin'));
  });
});
