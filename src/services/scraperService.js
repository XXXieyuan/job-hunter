const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const sanitizeHtml = require('sanitize-html');
const scraperRunsRepo = require('../repositories/scraperRunsRepo');
const jobsRepo = require('../repositories/jobsRepo');
const backgroundQueue = require('./backgroundQueue');
const { getLogger } = require('../logger');

const logger = getLogger('scraperService');

// [SECURITY: Issue 8] Platform whitelist
const VALID_PLATFORMS = ['linkedin', 'seek', 'apsjobs'];

// [SECURITY: Issue 11] HTML sanitization config for job descriptions
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a',
  ],
  allowedAttributes: {
    a: ['href'],
  },
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        href: attribs.href,
        rel: 'nofollow noopener',
        target: '_blank',
      },
    }),
  },
  allowedSchemes: ['https'],
  disallowedTagsMode: 'discard',
};

function sanitizeJobDescription(html) {
  return sanitizeHtml(html || '', SANITIZE_OPTIONS);
}

// [SECURITY: Issue 12] URL validation
const ALLOWED_DOMAINS = [
  'seek.com.au', 'linkedin.com', 'apsjobs.gov.au',
  'www.seek.com.au', 'www.linkedin.com', 'www.apsjobs.gov.au',
];

function validateJobUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

// [SECURITY: Issue 8] Config value sanitization
function validateConfig(options) {
  return {
    keywords: String(options.keywords || '').replace(/[^\w\s,.\-]/g, '').slice(0, 200),
    location: String(options.location || '').replace(/[^\w\s,.\-]/g, '').slice(0, 100),
    maxPages: Math.min(Math.max(parseInt(options.maxPages, 10) || 5, 1), 50),
  };
}

const INVALID_SCRAPER_OPTIONS_CODE = 'INVALID_SCRAPER_OPTIONS';
const BATCH_SIZE = 50;

/**
 * Map a job record from the Python crawler output to the DB schema.
 */
function mapCrawlerJob(data, platform) {
  return {
    external_id: data.external_id || null,
    source: data.platform || platform,
    aps_classification: data.classification || null,
    title: data.title,
    company_name: data.company || null,
    location: data.location || null,
    work_type: data.work_type || null,
    salary: data.salary || null,
    salary_min: data.salary_min || null,
    salary_max: data.salary_max || null,
    description: sanitizeJobDescription(data.description),
    url: validateJobUrl(data.url),
    posted_at: data.posted_at || null,
    closes_at: data.closes_at || null,
    visa_eligibility: data.visa_requirement || null,
    security_clearance: null,
    aps_classification: data.classification || null,
    raw_json: data.raw_json || JSON.stringify(data),
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Run the Python crawler as a child process.
 * Returns a Promise that resolves with stats on success, rejects on failure.
 */
function runCrawler(platform, config, runId) {
  // [SECURITY: Issue 8] Validate platform against whitelist
  if (!VALID_PLATFORMS.includes(platform)) {
    return Promise.reject(
      new Error(`Invalid platform: ${platform}. Must be one of: ${VALID_PLATFORMS.join(', ')}`)
    );
  }

  // [SECURITY: Issue 18] Check for concurrent scrape of same platform
  const running = scraperRunsRepo.findRunning(platform);
  if (running) {
    return Promise.reject(
      new Error(`${platform} scraper is already running (run ID: ${running.id})`)
    );
  }

  scraperRunsRepo.markRunRunning(runId);

  const scriptPath = path.resolve(__dirname, '..', '..', 'scrapers', 'cli.py');

  const args = [
    scriptPath,
    '--platform', platform,
    '--keywords', config.keywords || 'Data,Engineer',
    '--location', config.location || '',
    '--max-pages', String(config.maxPages || 5),
  ];

  const config_ = require('../config');
  const child = spawn(config_.PYTHON_PATH || 'python', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = readline.createInterface({ input: child.stdout });

  // [SECURITY: Issue 19] Batch upserts
  let jobBatch = [];
  const stats = {
    jobs_found: 0,
    jobs_new: 0,
    jobs_updated: 0,
    pages_scraped: 0,
  };

  function flushBatch() {
    if (jobBatch.length === 0) return;
    const batch = jobBatch.splice(0);
    try {
      const result = jobsRepo.upsertManyJobs(batch);
      if (result) {
        stats.jobs_new += result.newCount || 0;
        stats.jobs_updated += result.updatedCount || 0;
      }
      logger.info('Flushed job batch', { runId, batchSize: batch.length });
    } catch (err) {
      logger.error('Failed to upsert job batch', { runId, error: err.message });
    }
  }

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'job' && msg.data) {
        const mapped = mapCrawlerJob(msg.data, platform);
        jobBatch.push(mapped);
        stats.jobs_found++;
        if (jobBatch.length >= BATCH_SIZE) {
          flushBatch();
        }
      } else if (msg.type === 'status' && msg.data) {
        if (msg.data.phase === 'complete' && typeof msg.data.jobs_found === 'number') {
          stats.jobs_found = msg.data.jobs_found;
        }
        if (typeof msg.data.pages_scraped === 'number') {
          stats.pages_scraped = msg.data.pages_scraped;
        }
        scraperRunsRepo.updateProgress(runId, stats);
      }
    } catch (e) {
      logger.warn('Non-JSON stdout from crawler', { runId, line: line.slice(0, 200) });
    }
  });

  const stderrChunks = [];
  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    stderrChunks.push(msg);
    logger.info('Crawler log', { platform, runId, message: msg });
  });

  // [SECURITY: Issue 16] Configurable subprocess timeout with kill
  const TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after 5s if SIGTERM is ignored
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // process already dead
        }
      }, 5000);
      const errMsg = `Crawler for ${platform} timed out after ${TIMEOUT_MS / 1000}s`;
      logger.error('Crawler timeout', { platform, timeoutMs: TIMEOUT_MS, runId });
      scraperRunsRepo.markRunFailure(runId, errMsg);
      reject(new Error(errMsg));
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      flushBatch(); // flush any remaining jobs
      if (timedOut) return; // already rejected

      if (code === 0) {
        scraperRunsRepo.markRunSuccess(runId, stats);
        logger.info('Crawler completed successfully', { runId, platform, stats });
        resolve(stats);
      } else {
        const stderrText = stderrChunks.join('\n').slice(-500);
        const errMsg = `Crawler exited with code ${code}${stderrText ? ': ' + stderrText : ''}`;
        scraperRunsRepo.markRunFailure(runId, errMsg);
        logger.error('Crawler failed', { runId, platform, exitCode: code, stderr: stderrText });
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      scraperRunsRepo.markRunFailure(runId, err.message || String(err));
      logger.error('Failed to spawn crawler process', { runId, platform, error: err.message });
      reject(err);
    });
  });
}

// Register scraper task handler with the background queue
backgroundQueue.registerHandler('scraper', async (params) => {
  const { platform, config, runId } = params;
  return runCrawler(platform, config, runId);
});

/**
 * Trigger a scraper run via the background queue.
 * Validates input, creates a run record, and enqueues the task.
 *
 * @param {string} platform - One of 'linkedin', 'seek', 'apsjobs'
 * @param {object} options - { keywords, location, maxPages }
 * @returns {{ runId: number, taskId: string }}
 */
function triggerScrape(platform, options = {}) {
  const name = platform || 'apsjobs';

  // [SECURITY: Issue 8] Validate platform
  if (!VALID_PLATFORMS.includes(name)) {
    const err = new Error(
      `Invalid platform: ${name}. Must be one of: ${VALID_PLATFORMS.join(', ')}`
    );
    err.code = INVALID_SCRAPER_OPTIONS_CODE;
    throw err;
  }

  // [SECURITY: Issue 18] Check for concurrent scrape of same platform
  const running = scraperRunsRepo.findRunning(name);
  if (running) {
    const err = new Error(`${name} scraper is already running (run ID: ${running.id})`);
    err.code = 'SCRAPER_ALREADY_RUNNING';
    err.status = 409;
    throw err;
  }

  // Validate and sanitize config
  const config = validateConfig(options);

  // Create run record in DB
  const runId = scraperRunsRepo.createRun(name, config);

  logger.info('Scheduled scraper run', { runId, platform: name, config });

  // Enqueue via backgroundQueue for async execution
  const taskId = backgroundQueue.enqueue('scraper', {
    platform: name,
    config,
    runId,
  }, {
    description: `Scrape ${name} jobs`,
    platform: name,
    runId,
  });

  return { runId, taskId };
}

/**
 * Get recent scraper runs.
 * @param {number} [limit=20]
 */
function getScraperRuns(limit) {
  return scraperRunsRepo.getRecentRuns(limit || 20);
}

/**
 * Get a single scraper run by ID.
 * @param {number} id
 */
function getScraperRunById(id) {
  return scraperRunsRepo.getRunById(id);
}

module.exports = {
  triggerScrape,
  getScraperRuns,
  getScraperRunById,
  VALID_PLATFORMS,
  // Exported for testing
  _mapCrawlerJob: mapCrawlerJob,
  _sanitizeJobDescription: sanitizeJobDescription,
  _validateJobUrl: validateJobUrl,
  _validateConfig: validateConfig,
};
