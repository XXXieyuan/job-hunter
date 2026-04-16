'use strict';

/**
 * T-F.3 — NSW Government integration tests.
 *
 * Verifies the NSW Gov scraper feature is wired end-to-end across:
 *   1. scraperService VALID_PLATFORMS + ALLOWED_DOMAINS registration (T-D.1).
 *   2. URL validation for iworkfor.nsw.gov.au (T-D.1).
 *   3. mapCrawlerJob correctly maps a Python-adapter-shaped NSW Gov job into
 *      the DB schema (T-D.1 + T-A.1 output contract).
 *   4. CLI platform dispatch accepts 'nswgov' (T-C.1).
 *   5. Admin dashboard template renders the "NSW Gov" platform button and the
 *      source count badge (T-E.3).
 *   6. Frontend CSS carries the .tag-nswgov class (T-E.1).
 *   7. Source filter partial includes the NSW Gov checkbox (T-E.2).
 *   8. Locale files expose the NSW Gov label (T-E.4).
 *   9. Cross-source deduplication flags an NSW Gov / Seek duplicate pair (NG-17).
 *
 * The tests exercise real exported functions and on-disk artefacts — no logic
 * is reconstructed inline. Shelling out to Python is avoided so the suite
 * stays hermetic under the Node test runner.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ──────────────────────────────────────────────────────────────
// 1. scraperService — VALID_PLATFORMS registration (T-D.1)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — scraperService VALID_PLATFORMS (T-D.1, T-F.3)', () => {
  it("VALID_PLATFORMS includes 'nswgov'", () => {
    const { VALID_PLATFORMS } = require('../services/scraperService');
    assert.ok(Array.isArray(VALID_PLATFORMS));
    assert.ok(
      VALID_PLATFORMS.includes('nswgov'),
      `Expected 'nswgov' in VALID_PLATFORMS, got: ${VALID_PLATFORMS.join(', ')}`
    );
  });

  it('existing platforms remain registered (no regression)', () => {
    const { VALID_PLATFORMS } = require('../services/scraperService');
    for (const p of ['linkedin', 'seek', 'apsjobs', 'actgov']) {
      assert.ok(
        VALID_PLATFORMS.includes(p),
        `Existing platform '${p}' regressed out of VALID_PLATFORMS`
      );
    }
  });

  it("triggerScrape does NOT reject 'nswgov' as INVALID_SCRAPER_OPTIONS", () => {
    const { VALID_PLATFORMS } = require('../services/scraperService');
    // Can't actually call triggerScrape here because it would enqueue a real
    // background job. We verify the validation gate that triggerScrape uses.
    assert.ok(
      VALID_PLATFORMS.includes('nswgov'),
      'nswgov must pass the VALID_PLATFORMS gate inside triggerScrape'
    );
  });

  it('triggerScrape still rejects unknown platform with INVALID_SCRAPER_OPTIONS', () => {
    const { triggerScrape } = require('../services/scraperService');
    assert.throws(
      () => triggerScrape('not_a_real_platform', {}),
      (err) => {
        assert.equal(err.code, 'INVALID_SCRAPER_OPTIONS');
        assert.match(err.message, /Invalid platform/);
        return true;
      }
    );
  });
});

// ──────────────────────────────────────────────────────────────
// 2. scraperService — ALLOWED_DOMAINS covers iworkfor.nsw.gov.au
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — ALLOWED_DOMAINS (T-D.1, T-F.3)', () => {
  it("ALLOWED_DOMAINS includes 'iworkfor.nsw.gov.au'", () => {
    const { ALLOWED_DOMAINS } = require('../services/scraperService');
    assert.ok(Array.isArray(ALLOWED_DOMAINS));
    assert.ok(ALLOWED_DOMAINS.includes('iworkfor.nsw.gov.au'));
  });

  it("ALLOWED_DOMAINS includes 'www.iworkfor.nsw.gov.au'", () => {
    const { ALLOWED_DOMAINS } = require('../services/scraperService');
    assert.ok(ALLOWED_DOMAINS.includes('www.iworkfor.nsw.gov.au'));
  });

  it('validateJobUrl accepts NSW Gov apex domain', () => {
    const { _validateJobUrl } = require('../services/scraperService');
    const url = 'https://iworkfor.nsw.gov.au/job/NSW-12345';
    assert.equal(_validateJobUrl(url), url);
  });

  it('validateJobUrl accepts NSW Gov www subdomain', () => {
    const { _validateJobUrl } = require('../services/scraperService');
    const url = 'https://www.iworkfor.nsw.gov.au/job/NSW-12345';
    assert.equal(_validateJobUrl(url), url);
  });

  it('validateJobUrl rejects http:// (non-HTTPS) NSW Gov URL', () => {
    const { _validateJobUrl } = require('../services/scraperService');
    assert.equal(
      _validateJobUrl('http://iworkfor.nsw.gov.au/job/NSW-12345'),
      null
    );
  });

  it('validateJobUrl rejects domain-spoofing variants', () => {
    const { _validateJobUrl } = require('../services/scraperService');
    assert.equal(
      _validateJobUrl('https://iworkfor.nsw.gov.au.evil.com/job/1'),
      null
    );
  });
});

// ──────────────────────────────────────────────────────────────
// 3. mapCrawlerJob — NSW Gov payload mapping (T-D.1, T-A.1 contract)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — mapCrawlerJob (T-F.3)', () => {
  it('maps a NSW Gov job payload to the DB schema', () => {
    const { _mapCrawlerJob } = require('../services/scraperService');

    const nswgovJob = {
      external_id: 'nswgov-NSW-0042',
      platform: 'nswgov',
      title: 'Senior Policy Officer',
      company: 'Department of Premier and Cabinet',
      location: 'Sydney / Parramatta',
      work_type: 'full-time',
      salary: '$100,000 - $120,000 per annum',
      salary_min: 100000,
      salary_max: 120000,
      description: '<p>Exciting opportunity at the NSW Department of Premier and Cabinet.</p>',
      url: 'https://iworkfor.nsw.gov.au/job/NSW-0042',
      posted_at: '2026-04-01',
      closes_at: '2026-05-01',
      visa_requirement: 'citizens_only',
      classification: 'APS 6',
      raw_json: '{"source":"api","from":"nswgov"}',
    };

    const mapped = _mapCrawlerJob(nswgovJob, 'nswgov');

    assert.equal(mapped.external_id, 'nswgov-NSW-0042');
    assert.equal(mapped.source, 'nswgov');
    assert.equal(mapped.title, 'Senior Policy Officer');
    assert.equal(mapped.company_name, 'Department of Premier and Cabinet');
    assert.equal(mapped.location, 'Sydney / Parramatta');
    assert.equal(mapped.salary_min, 100000);
    assert.equal(mapped.salary_max, 120000);
    assert.equal(mapped.posted_at, '2026-04-01');
    assert.equal(mapped.closes_at, '2026-05-01');
    assert.equal(mapped.visa_eligibility, 'citizens_only');
    assert.equal(mapped.aps_classification, 'APS 6');
    assert.equal(mapped.url, 'https://iworkfor.nsw.gov.au/job/NSW-0042');
    assert.ok(mapped.scraped_at, 'scraped_at should be set');
  });

  it('maps NSW Gov unmappable classification fallback verbatim', () => {
    const { _mapCrawlerJob } = require('../services/scraperService');

    const mapped = _mapCrawlerJob(
      {
        external_id: 'nswgov-XYZ',
        platform: 'nswgov',
        title: 'Clinical Manager',
        company: 'NSW Health',
        url: 'https://iworkfor.nsw.gov.au/job/XYZ',
        classification: 'NSW Gov \u2014 Health Manager Level 2',
      },
      'nswgov'
    );

    assert.equal(mapped.source, 'nswgov');
    assert.equal(
      mapped.aps_classification,
      'NSW Gov \u2014 Health Manager Level 2',
      'Unmappable NSW classifications are passed through verbatim so the UI can style them neutrally'
    );
  });

  it('sanitises NSW Gov job description HTML', () => {
    const { _mapCrawlerJob } = require('../services/scraperService');

    const mapped = _mapCrawlerJob(
      {
        external_id: 'nswgov-1',
        platform: 'nswgov',
        title: 'Test',
        description: '<script>alert(1)</script><p>Safe</p>',
        url: 'https://iworkfor.nsw.gov.au/job/1',
      },
      'nswgov'
    );

    assert.ok(!mapped.description.includes('<script>'), 'script tags stripped');
    assert.ok(mapped.description.includes('<p>Safe</p>'), 'safe tags preserved');
  });
});

// ──────────────────────────────────────────────────────────────
// 4. CLI — platform dispatch (T-C.1)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — CLI dispatch (T-C.1, T-F.3)', () => {
  it("scrapers/cli.py VALID_PLATFORMS tuple contains 'nswgov'", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scrapers', 'cli.py'),
      'utf8'
    );
    // The tuple is declared as: VALID_PLATFORMS = ("linkedin", ..., "nswgov")
    assert.match(src, /VALID_PLATFORMS\s*=\s*\([^)]*["']nswgov["'][^)]*\)/);
  });

  it('scrapers/cli.py imports NswGovScraper in dispatch', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scrapers', 'cli.py'),
      'utf8'
    );
    assert.match(
      src,
      /elif\s+platform\s*==\s*["']nswgov["'][\s\S]*from\s+scrapers\.adapters\.nswgov\s+import\s+NswGovScraper/
    );
  });

  it("scrapers/cli.py --platform choices accept 'nswgov'", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scrapers', 'cli.py'),
      'utf8'
    );
    // argparse uses `choices=VALID_PLATFORMS`; membership of nswgov in the
    // tuple (asserted above) is sufficient. Verify wiring explicitly.
    assert.match(src, /choices\s*=\s*VALID_PLATFORMS/);
  });
});

// ──────────────────────────────────────────────────────────────
// 5. Admin dashboard template — NSW Gov button + source count (T-E.3)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — admin dashboard (T-E.3, T-F.3)', () => {
  const DASHBOARD_PATH = path.join(
    REPO_ROOT,
    'views',
    'admin',
    'dashboard.ejs'
  );

  it('renders a platform button with data-platform="nswgov"', () => {
    const tpl = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    assert.match(tpl, /data-platform=["']nswgov["']/);
  });

  it('labels the NSW Gov button', () => {
    const tpl = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    assert.match(tpl, />\s*NSW Gov\s*</);
  });

  it('shows a source count badge driven by _sourceCounts.nswgov', () => {
    const tpl = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    // EJS output tag: <%= _sourceCounts.nswgov || 0 %>
    assert.match(tpl, /_sourceCounts\.nswgov\s*\|\|\s*0/);
  });

  it('uses the canonical POST body field "name" (not "platform")', () => {
    const tpl = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    // INTERFACE_CONTRACT canonical-name note: request body must use `name`.
    assert.match(tpl, /name:\s*selectedPlatform/);
  });

  it("maxPages input is NOT suppressed when platform is 'nswgov'", () => {
    const tpl = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    // Per DESIGN.md maxPages Behaviour, only 'actgov' suppresses maxPages.
    // Assert there is no nswgov-specific suppression clause.
    assert.doesNotMatch(
      tpl,
      /selectedPlatform\s*===\s*["']nswgov["']\s*\?\s*.*maxPages/i,
      'No nswgov-specific maxPages suppression should exist'
    );
  });
});

// ──────────────────────────────────────────────────────────────
// 6. Frontend CSS — .tag-nswgov class (T-E.1)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — source badge CSS (T-E.1, T-F.3)', () => {
  const CSS_PATH = path.join(REPO_ROOT, 'public', 'css', 'main.css');

  it('.tag-nswgov class is declared in main.css', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    assert.match(css, /\.tag-nswgov\s*\{/);
  });

  it('.tag-nswgov uses the dark navy palette per DESIGN.md', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const block = /\.tag-nswgov\s*\{[^}]*\}/s.exec(css);
    assert.ok(block, '.tag-nswgov block not found');
    const body = block[0].toLowerCase();
    assert.ok(
      body.includes('#1e3a5f'),
      '.tag-nswgov should use dark navy #1e3a5f'
    );
    assert.ok(
      body.includes('#ffffff') || body.includes('#fff'),
      '.tag-nswgov text colour should be white'
    );
  });
});

// ──────────────────────────────────────────────────────────────
// 7. Filter bar — NSW Gov source checkbox (T-E.2)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — source filter checkbox (T-E.2, T-F.3)', () => {
  const FILTER_PATH = path.join(
    REPO_ROOT,
    'views',
    'partials',
    'filter-bar.ejs'
  );

  it('filter bar includes checkbox with value="nswgov"', () => {
    const tpl = fs.readFileSync(FILTER_PATH, 'utf8');
    assert.match(tpl, /name=["']source["']\s+value=["']nswgov["']/);
  });

  it('checkbox is labelled "NSW Gov"', () => {
    const tpl = fs.readFileSync(FILTER_PATH, 'utf8');
    assert.match(tpl, /value=["']nswgov["'][\s\S]{0,200}NSW Gov/);
  });
});

// ──────────────────────────────────────────────────────────────
// 8. Locales — NSW Gov label (T-E.4)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — locales (T-E.4, T-F.3)', () => {
  it('en.json exposes jobs.source.nswgov = "NSW Gov"', () => {
    const en = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'src', 'locales', 'en.json'), 'utf8')
    );
    const label = en['jobs.source.nswgov'];
    assert.equal(label, 'NSW Gov');
  });

  it('zh.json exposes jobs.source.nswgov with the same value (proper noun, not translated)', () => {
    const zh = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'src', 'locales', 'zh.json'), 'utf8')
    );
    const label = zh['jobs.source.nswgov'];
    assert.equal(label, 'NSW Gov');
  });
});

// ──────────────────────────────────────────────────────────────
// 9. Cross-source deduplication — NSW Gov + Seek pair (NG-17)
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — cross-source dedup (NG-17, T-F.3)', () => {
  it('comparePair flags NSW Gov + Seek postings for the same role', () => {
    const dedup = require('../services/deduplicationService');

    const nswgovJob = {
      id: 101,
      title: 'Senior Policy Officer',
      company_name: 'Department of Premier and Cabinet',
      location: 'Sydney',
      source: 'nswgov',
      description: 'NSW Gov posting',
      url: 'https://iworkfor.nsw.gov.au/job/NSW-0042',
      salary_min: 100000,
      created_at: '2026-04-14T00:00:00Z',
    };

    const seekJob = {
      id: 102,
      title: 'Senior Policy Officer',
      company_name: 'Department of Premier and Cabinet',
      location: 'Sydney',
      source: 'seek',
      description: 'Same role cross-posted on Seek',
      url: 'https://www.seek.com.au/job/99999',
      salary_min: 100000,
      created_at: '2026-04-15T00:00:00Z',
    };

    const result = dedup.comparePair(nswgovJob, seekJob);
    assert.ok(
      result.isDuplicate,
      'Cross-posted NSW Gov + Seek role should be flagged as duplicate'
    );
    assert.ok(
      typeof result.confidence === 'number' && result.confidence >= 0.8,
      `Expected confidence >= 0.8, got ${result.confidence}`
    );
  });

  it('comparePair does NOT flag unrelated NSW Gov + Seek jobs', () => {
    const dedup = require('../services/deduplicationService');

    const nswgovJob = {
      id: 201,
      title: 'Senior Policy Officer',
      company_name: 'NSW Health',
      location: 'Sydney',
      source: 'nswgov',
    };

    const seekJob = {
      id: 202,
      title: 'Software Engineer',
      company_name: 'Commonwealth Bank',
      location: 'Melbourne',
      source: 'seek',
    };

    const result = dedup.comparePair(nswgovJob, seekJob);
    assert.ok(
      !result.isDuplicate,
      'Unrelated jobs should not be flagged as duplicates'
    );
  });
});

// ──────────────────────────────────────────────────────────────
// 10. JSON protocol round-trip — nswgov envelope parses and maps
// ──────────────────────────────────────────────────────────────

describe('NSW Gov integration — JSON Lines envelope round-trip (T-F.3)', () => {
  it('a nswgov "job" envelope line parses and maps through mapCrawlerJob', () => {
    const { _mapCrawlerJob } = require('../services/scraperService');

    const envelopeLine =
      '{"type":"job","data":{"external_id":"nswgov-NSW-777","platform":"nswgov",' +
      '"title":"Data Analyst","company":"NSW Treasury","location":"Sydney",' +
      '"description":"<p>Data role</p>",' +
      '"url":"https://iworkfor.nsw.gov.au/job/NSW-777",' +
      '"salary":"$90,000 - $100,000","salary_min":90000,"salary_max":100000,' +
      '"work_type":"full-time","visa_requirement":"work_rights_required",' +
      '"classification":"APS 5","closes_at":"2026-05-30","posted_at":"2026-04-10",' +
      '"raw_json":"{}"}}';

    const parsed = JSON.parse(envelopeLine);
    assert.equal(parsed.type, 'job');

    const mapped = _mapCrawlerJob(parsed.data, 'nswgov');
    assert.equal(mapped.source, 'nswgov');
    assert.equal(mapped.external_id, 'nswgov-NSW-777');
    assert.equal(mapped.aps_classification, 'APS 5');
    assert.equal(mapped.salary_min, 90000);
    assert.equal(mapped.salary_max, 100000);
    assert.equal(mapped.visa_eligibility, 'work_rights_required');
  });
});
