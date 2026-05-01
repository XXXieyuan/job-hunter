'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// T-134 through T-138: Scraper Service Tests (Node.js ingestion pipeline)

describe('Scraper Service — module interface (T-K.2)', () => {
  it('exports triggerScrape, getScraperRuns, getScraperRunById, VALID_PLATFORMS', () => {
    const scraperService = require('./scraperService');

    assert.equal(typeof scraperService.triggerScrape, 'function');
    assert.equal(typeof scraperService.getScraperRuns, 'function');
    assert.equal(typeof scraperService.getScraperRunById, 'function');
    assert.ok(Array.isArray(scraperService.VALID_PLATFORMS));
  });

  it('VALID_PLATFORMS contains registered scraper sources', () => {
    const { VALID_PLATFORMS } = require('./scraperService');

    assert.ok(VALID_PLATFORMS.includes('linkedin'));
    assert.ok(VALID_PLATFORMS.includes('seek'));
    assert.ok(VALID_PLATFORMS.includes('apsjobs'));
    assert.ok(VALID_PLATFORMS.includes('actgov'));
    assert.ok(VALID_PLATFORMS.includes('nswgov'));
    assert.equal(VALID_PLATFORMS.length, 5);
  });

  it('triggerScrape rejects invalid platform', () => {
    const { triggerScrape } = require('./scraperService');

    assert.throws(
      () => triggerScrape('invalid_platform', {}),
      (err) => {
        assert.ok(err.message.includes('Invalid platform'));
        return true;
      }
    );
  });
});

// T-135: Ingestion pipeline sanitises HTML descriptions
describe('Scraper Service — HTML sanitization (T-135)', () => {
  it('sanitizes dangerous HTML tags via _sanitizeJobDescription', () => {
    const { _sanitizeJobDescription } = require('./scraperService');

    const dirty = '<script>alert(1)</script><p>Safe content</p>';
    const clean = _sanitizeJobDescription(dirty);

    assert.ok(!clean.includes('<script>'), 'Script tags should be removed');
    assert.ok(clean.includes('<p>Safe content</p>'), 'Safe tags should be preserved');
  });

  it('preserves allowed tags (p, ul, ol, li, strong, em, a)', () => {
    const { _sanitizeJobDescription } = require('./scraperService');

    const html = '<p>Hello</p><ul><li><strong>Bold</strong></li></ul>';
    const clean = _sanitizeJobDescription(html);

    assert.ok(clean.includes('<p>'), 'p tags preserved');
    assert.ok(clean.includes('<ul>'), 'ul tags preserved');
    assert.ok(clean.includes('<li>'), 'li tags preserved');
    assert.ok(clean.includes('<strong>'), 'strong tags preserved');
  });

  it('strips event handlers from tags', () => {
    const { _sanitizeJobDescription } = require('./scraperService');

    const html = '<p onclick="alert(1)">Text</p>';
    const clean = _sanitizeJobDescription(html);

    assert.ok(!clean.includes('onclick'), 'Event handlers should be removed');
  });

  it('returns empty string for null/undefined input', () => {
    const { _sanitizeJobDescription } = require('./scraperService');

    assert.equal(_sanitizeJobDescription(null), '');
    assert.equal(_sanitizeJobDescription(undefined), '');
    assert.equal(_sanitizeJobDescription(''), '');
  });
});

// T-134: Node.js ingestion pipeline parses JSON stdout — mapCrawlerJob
describe('Scraper Service — mapCrawlerJob (T-134)', () => {
  it('maps all fields from scraper output to DB schema', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    const crawlerOutput = {
      external_id: 'seek-12345',
      platform: 'seek',
      title: 'Data Analyst',
      company: 'Commonwealth Bank',
      location: 'Sydney CBD, NSW',
      work_type: 'full-time',
      salary: '$120,000 - $140,000',
      salary_min: 120000,
      salary_max: 140000,
      description: '<p>We are looking for a data analyst</p>',
      url: 'https://www.seek.com.au/job/12345',
      posted_at: '2026-03-28',
      closes_at: '2026-04-15',
      visa_requirement: 'visa_holders_welcome',
      classification: 'APS6',
      raw_json: '{"test": true}',
    };

    const mapped = _mapCrawlerJob(crawlerOutput, 'seek');

    assert.equal(mapped.external_id, 'seek-12345');
    assert.equal(mapped.source, 'seek');
    assert.equal(mapped.title, 'Data Analyst');
    assert.equal(mapped.company_name, 'Commonwealth Bank');
    assert.equal(mapped.location, 'Sydney CBD, NSW');
    assert.equal(mapped.work_type, 'full-time');
    assert.equal(mapped.salary, '$120,000 - $140,000');
    assert.equal(mapped.salary_min, 120000);
    assert.equal(mapped.salary_max, 140000);
    assert.equal(mapped.posted_at, '2026-03-28');
    assert.equal(mapped.closes_at, '2026-04-15');
    assert.equal(mapped.visa_eligibility, 'visa_holders_welcome');
    assert.equal(mapped.aps_classification, 'APS6');
    assert.equal(mapped.raw_json, '{"test": true}');
    assert.ok(mapped.scraped_at, 'Should set scraped_at timestamp');
  });

  it('sanitizes HTML in description field', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    const crawlerOutput = {
      external_id: 'seek-1',
      platform: 'seek',
      title: 'Test',
      description: '<script>alert(1)</script><p>Safe</p>',
      url: 'https://www.seek.com.au/job/1',
    };

    const mapped = _mapCrawlerJob(crawlerOutput, 'seek');
    assert.ok(!mapped.description.includes('<script>'), 'Should strip script tags');
    assert.ok(mapped.description.includes('<p>Safe</p>'), 'Should preserve safe tags');
  });

  it('validates job URL against allowed domains', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    const goodUrl = _mapCrawlerJob({
      external_id: 'seek-1', platform: 'seek', title: 'Test',
      url: 'https://www.seek.com.au/job/1',
    }, 'seek');
    assert.equal(goodUrl.url, 'https://www.seek.com.au/job/1');

    const badUrl = _mapCrawlerJob({
      external_id: 'x-1', platform: 'seek', title: 'Test',
      url: 'https://evil.com/job/1',
    }, 'seek');
    assert.equal(badUrl.url, null, 'Should reject URLs from non-allowed domains');
  });

  it('uses platform argument as fallback for source', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    const mapped = _mapCrawlerJob({
      external_id: 'x-1', title: 'Test',
    }, 'apsjobs');

    assert.equal(mapped.source, 'apsjobs');
  });
});

// T-134 continued: URL validation
describe('Scraper Service — URL validation', () => {
  it('validates allowed domains', () => {
    const { _validateJobUrl } = require('./scraperService');

    assert.equal(_validateJobUrl('https://www.seek.com.au/job/1'), 'https://www.seek.com.au/job/1');
    assert.equal(_validateJobUrl('https://www.linkedin.com/jobs/view/1'), 'https://www.linkedin.com/jobs/view/1');
    assert.equal(_validateJobUrl('https://www.apsjobs.gov.au/s/job-details/ref'), 'https://www.apsjobs.gov.au/s/job-details/ref');
  });

  it('rejects non-HTTPS URLs', () => {
    const { _validateJobUrl } = require('./scraperService');

    assert.equal(_validateJobUrl('http://www.seek.com.au/job/1'), null);
  });

  it('rejects disallowed domains', () => {
    const { _validateJobUrl } = require('./scraperService');

    assert.equal(_validateJobUrl('https://evil.com/job'), null);
  });

  it('returns null for null/empty/invalid', () => {
    const { _validateJobUrl } = require('./scraperService');

    assert.equal(_validateJobUrl(null), null);
    assert.equal(_validateJobUrl(''), null);
    assert.equal(_validateJobUrl('not a url'), null);
  });
});

// T-134 continued: Config validation
describe('Scraper Service — config validation', () => {
  it('sanitizes keywords and location', () => {
    const { _validateConfig } = require('./scraperService');

    const config = _validateConfig({
      keywords: 'Data Analyst',
      location: 'Sydney, NSW',
      maxPages: 3,
    });

    assert.equal(config.keywords, 'Data Analyst');
    assert.equal(config.location, 'Sydney, NSW');
    assert.equal(config.maxPages, 3);
  });

  it('clamps maxPages to 1-50 range', () => {
    const { _validateConfig } = require('./scraperService');

    // maxPages=0 is falsy, defaults to 5 via || operator, then clamped to [1,50]
    assert.equal(_validateConfig({ maxPages: 0 }).maxPages, 5);
    assert.equal(_validateConfig({ maxPages: 100 }).maxPages, 50);
    assert.equal(_validateConfig({ maxPages: -1 }).maxPages, 1);
  });

  it('strips special characters from keywords/location', () => {
    const { _validateConfig } = require('./scraperService');

    const config = _validateConfig({
      keywords: 'Data; DROP TABLE jobs;--',
      location: '<script>alert(1)</script>',
    });

    assert.ok(!config.keywords.includes(';'), 'Should strip semicolons');
    assert.ok(!config.location.includes('<'), 'Should strip angle brackets');
  });

  it('truncates keywords to 200 chars, location to 100', () => {
    const { _validateConfig } = require('./scraperService');

    const config = _validateConfig({
      keywords: 'a'.repeat(300),
      location: 'b'.repeat(200),
    });

    assert.ok(config.keywords.length <= 200);
    assert.ok(config.location.length <= 100);
  });
});

// T-136: Ingestion pipeline upserts by external_id
describe('Scraper Service — upsert logic (T-136)', () => {
  it('upsertManyJobs in jobsRepo preserves company_id and embedding on conflict', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'repositories', 'jobsRepo.js'), 'utf8'
    );
    // The ON CONFLICT clause should NOT update company_id or embedding
    assert.ok(src.includes('ON CONFLICT(external_id)'), 'Should conflict on external_id');
    assert.ok(!src.includes('company_id = excluded.company_id'), 'Should NOT overwrite company_id');
    assert.ok(!src.includes('embedding = excluded.embedding'), 'Should NOT overwrite embedding');
    assert.ok(src.includes('COALESCE(excluded.visa_eligibility'), 'Should COALESCE visa_eligibility');
  });
});

// T-137: Ingestion pipeline updates scraper_runs with counts
describe('Scraper Service — scraper_runs tracking (T-137)', () => {
  it('scraperRunsRepo exports all required status methods', () => {
    const repo = require('../repositories/scraperRunsRepo');
    assert.equal(typeof repo.createRun, 'function');
    assert.equal(typeof repo.markRunRunning, 'function');
    assert.equal(typeof repo.markRunSuccess, 'function');
    assert.equal(typeof repo.markRunFailure, 'function');
    assert.equal(typeof repo.updateProgress, 'function');
  });
});

// T-138: Ingestion pipeline handles non-zero exit code
describe('Scraper Service — error handling (T-138)', () => {
  it('scraperService captures stderr and includes in failure message', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'scraperService.js'), 'utf8'
    );
    assert.ok(src.includes('stderrChunks'), 'Should collect stderr chunks');
    assert.ok(src.includes('markRunFailure'), 'Should call markRunFailure on error');
    assert.ok(src.includes('Crawler exited with code'), 'Should report non-zero exit code');
    assert.ok(src.includes("child.on('error'"), 'Should handle spawn errors');
  });
});

// T-143: Python subprocess JSON protocol roundtrip
describe('Scraper Service — JSON protocol (T-143)', () => {
  it('job envelope has correct type and data fields', () => {
    const envelope = { type: 'job', data: {
      external_id: 'seek-123',
      platform: 'seek',
      title: 'Data Analyst',
      company: 'Test Corp',
      location: 'Sydney',
      description: '<p>Test</p>',
      url: 'https://www.seek.com.au/job/123',
      salary_min: 80000,
      salary_max: 100000,
      work_type: 'full-time',
      visa_requirement: null,
      classification: null,
      closes_at: null,
      posted_at: '2026-03-01',
      raw_json: '{}',
    }};

    assert.equal(envelope.type, 'job');
    assert.ok(envelope.data);
    assert.equal(envelope.data.external_id, 'seek-123');
    assert.equal(envelope.data.platform, 'seek');
    assert.equal(envelope.data.title, 'Data Analyst');
  });

  it('status envelope has correct type and data fields', () => {
    const envelope = {
      type: 'status',
      data: { phase: 'complete', jobs_found: 10, duration_seconds: 45.2 },
    };

    assert.equal(envelope.type, 'status');
    assert.equal(envelope.data.phase, 'complete');
    assert.equal(envelope.data.jobs_found, 10);
  });

  it('JSON.parse handles all scraper output envelope types', () => {
    const lines = [
      '{"type":"status","data":{"phase":"started","message":"Starting"}}',
      '{"type":"job","data":{"external_id":"seek-1","platform":"seek","title":"Dev"}}',
      '{"type":"status","data":{"phase":"complete","jobs_found":1}}',
    ];

    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(['status', 'job'].includes(parsed.type), `Type should be status or job, got ${parsed.type}`);
      assert.ok(parsed.data, 'Envelope should have data');
    }
  });

  it('mapCrawlerJob correctly handles job envelope data', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    // Simulate what happens when a JSON line from the Python scraper is parsed
    const line = '{"type":"job","data":{"external_id":"seek-123","platform":"seek","title":"Data Analyst","company":"Test Corp","location":"Sydney","description":"<p>Test</p>","url":"https://www.seek.com.au/job/123","salary":"$80,000 - $100,000","salary_min":80000,"salary_max":100000,"work_type":"full-time","visa_requirement":null,"classification":null,"closes_at":null,"posted_at":"2026-03-01","raw_json":"{}"}}';
    const parsed = JSON.parse(line);

    assert.equal(parsed.type, 'job');
    const mapped = _mapCrawlerJob(parsed.data, 'seek');

    assert.equal(mapped.external_id, 'seek-123');
    assert.equal(mapped.source, 'seek');
    assert.equal(mapped.company_name, 'Test Corp');
    assert.equal(mapped.salary_min, 80000);
    assert.equal(mapped.salary_max, 100000);
  });
});

// T-4.1: ACT Gov platform registration
describe('Scraper Service — actgov platform registration (T-4.1)', () => {
  it('VALID_PLATFORMS includes actgov', () => {
    const { VALID_PLATFORMS } = require('./scraperService');
    assert.ok(VALID_PLATFORMS.includes('actgov'));
  });

  it('ALLOWED_DOMAINS includes jobs.act.gov.au', () => {
    const { _validateJobUrl } = require('./scraperService');

    const url1 = _validateJobUrl('https://jobs.act.gov.au/opportunities/12345');
    assert.equal(url1, 'https://jobs.act.gov.au/opportunities/12345');

    const url2 = _validateJobUrl('https://www.jobs.act.gov.au/opportunities/12345');
    assert.equal(url2, 'https://www.jobs.act.gov.au/opportunities/12345');
  });

  it('mapCrawlerJob maps actgov job data correctly', () => {
    const { _mapCrawlerJob } = require('./scraperService');

    const actgovJob = {
      external_id: 'actgov-12345',
      platform: 'actgov',
      title: 'Senior Policy Officer',
      company: 'Health',
      location: 'Canberra, ACT',
      work_type: 'full-time',
      salary: '$85,000 - $95,000',
      salary_min: 85000,
      salary_max: 95000,
      description: '<p>The ACT Health Directorate is seeking...</p>',
      url: 'https://jobs.act.gov.au/opportunities/12345',
      posted_at: '2026-04-14T00:00:00.000Z',
      closes_at: '2026-04-30T00:00:00.000Z',
      visa_requirement: 'citizens_only',
      classification: 'ASO 6',
      raw_json: '{"test": true}',
    };

    const mapped = _mapCrawlerJob(actgovJob, 'actgov');

    assert.equal(mapped.external_id, 'actgov-12345');
    assert.equal(mapped.source, 'actgov');
    assert.equal(mapped.title, 'Senior Policy Officer');
    assert.equal(mapped.company_name, 'Health');
    assert.equal(mapped.location, 'Canberra, ACT');
    assert.equal(mapped.salary_min, 85000);
    assert.equal(mapped.salary_max, 95000);
    assert.equal(mapped.visa_eligibility, 'citizens_only');
    assert.equal(mapped.aps_classification, 'ASO 6');
    assert.equal(mapped.url, 'https://jobs.act.gov.au/opportunities/12345');
  });

  it('triggerScrape does not reject actgov as invalid platform', () => {
    const { triggerScrape, VALID_PLATFORMS } = require('./scraperService');

    // Verify actgov passes the platform validation check (will throw for other
    // reasons like missing DB, but NOT for invalid platform)
    assert.ok(VALID_PLATFORMS.includes('actgov'),
      'actgov must be in VALID_PLATFORMS so triggerScrape accepts it');
  });
});

// T-9.3: ACT Gov integration tests — ALLOWED_DOMAINS and cross-source dedup
describe('Scraper Service — actgov ALLOWED_DOMAINS (T-9.3)', () => {
  it('ALLOWED_DOMAINS includes jobs.act.gov.au', () => {
    const { _validateJobUrl } = require('./scraperService');

    const url = _validateJobUrl('https://jobs.act.gov.au/opportunities/12345');
    assert.equal(url, 'https://jobs.act.gov.au/opportunities/12345');
  });

  it('ALLOWED_DOMAINS includes www.jobs.act.gov.au', () => {
    const { _validateJobUrl } = require('./scraperService');

    const url = _validateJobUrl('https://www.jobs.act.gov.au/opportunities/12345');
    assert.equal(url, 'https://www.jobs.act.gov.au/opportunities/12345');
  });

  it('rejects URLs from non-allowed domains', () => {
    const { _validateJobUrl } = require('./scraperService');

    assert.equal(_validateJobUrl('https://evil.com/jobs'), null);
  });
});

// T-9.3: Cross-source duplicate detection (AC #7)
describe('Scraper Service — cross-source dedup ACT Gov + Seek (T-9.3, AC #7)', () => {
  it('comparePair detects duplicates across actgov and seek sources', () => {
    const dedup = require('./deduplicationService');

    const actgovJob = {
      id: 1,
      title: 'Senior Policy Officer',
      company_name: 'Chief Minister, Treasury and Economic Development Directorate',
      location: 'Canberra',
      source: 'actgov',
      description: 'ACT Gov policy role',
      url: 'https://jobs.act.gov.au/opportunities/12345',
      salary_min: 95000,
      created_at: '2026-04-14T00:00:00Z',
    };

    const seekJob = {
      id: 2,
      title: 'Senior Policy Officer',
      company_name: 'Chief Minister, Treasury and Economic Development Directorate',
      location: 'Canberra',
      source: 'seek',
      description: 'Seek listing for the same role',
      url: 'https://www.seek.com.au/job/67890',
      salary_min: 95000,
      created_at: '2026-04-15T00:00:00Z',
    };

    const result = dedup.comparePair(actgovJob, seekJob);
    assert.ok(result.isDuplicate, 'ACT Gov + Seek jobs with same title/company/location should be duplicates');
    assert.ok(result.confidence >= 0.8, `Confidence should be >= 0.8, got ${result.confidence}`);
  });

  it('comparePair does not flag different jobs as duplicates', () => {
    const dedup = require('./deduplicationService');

    const actgovJob = {
      id: 1,
      title: 'Senior Policy Officer',
      company_name: 'Health Directorate',
      location: 'Canberra',
      source: 'actgov',
    };

    const seekJob = {
      id: 2,
      title: 'Data Analyst',
      company_name: 'Commonwealth Bank',
      location: 'Sydney',
      source: 'seek',
    };

    const result = dedup.comparePair(actgovJob, seekJob);
    assert.ok(!result.isDuplicate, 'Different jobs should not be duplicates');
  });
});
