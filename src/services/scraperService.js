const path = require('path');
const { spawn } = require('child_process');
const {
  createRun,
  markRunRunning,
  markRunSuccess,
  markRunFailure,
  getRecentRuns,
} = require('../repositories/scraperRunsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('scraperService');

const INVALID_SCRAPER_OPTIONS_CODE = 'INVALID_SCRAPER_OPTIONS';

function validateAndNormalizeApsjobsOptions(rawOptions) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const normalized = {};

  if (Object.prototype.hasOwnProperty.call(options, 'keywords')) {
    if (
      options.keywords != null &&
      typeof options.keywords !== 'string'
    ) {
      const err = new Error('keywords must be a string if provided.');
      err.code = INVALID_SCRAPER_OPTIONS_CODE;
      throw err;
    }
    if (typeof options.keywords === 'string') {
      const trimmed = options.keywords.trim();
      if (trimmed) {
        normalized.keywords = trimmed;
      }
    }
  }

  // Accept either region (preferred) or location as the region string.
  if (Object.prototype.hasOwnProperty.call(options, 'region')) {
    if (
      options.region != null &&
      typeof options.region !== 'string'
    ) {
      const err = new Error('region must be a string if provided.');
      err.code = INVALID_SCRAPER_OPTIONS_CODE;
      throw err;
    }
    if (typeof options.region === 'string') {
      const trimmed = options.region.trim();
      if (trimmed) {
        normalized.location = trimmed;
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(options, 'location')) {
    if (
      options.location != null &&
      typeof options.location !== 'string'
    ) {
      const err = new Error('location must be a string if provided.');
      err.code = INVALID_SCRAPER_OPTIONS_CODE;
      throw err;
    }
    if (typeof options.location === 'string') {
      const trimmed = options.location.trim();
      if (trimmed) {
        normalized.location = trimmed;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'maxPages')) {
    if (options.maxPages != null && options.maxPages !== '') {
      const num = Number(options.maxPages);
      const isInteger =
        Number.isInteger(num) && Number.isFinite(num) && num > 0;
      if (!isInteger) {
        const err = new Error('maxPages must be a positive integer if provided.');
        err.code = INVALID_SCRAPER_OPTIONS_CODE;
        throw err;
      }
      normalized.maxPages = num;
    }
  }

  return normalized;
}

function runApsjobsScraper(runId, options) {
  const scraperName = 'apsjobs';

  try {
    markRunRunning(runId);

    const scriptPath = path.resolve(__dirname, '..', 'scrapers', 'apsjobsScraper.js');

    const normalizedOptions = validateAndNormalizeApsjobsOptions(options || {});

    const keywords =
      normalizedOptions.keywords ||
      process.env.APSJOBS_KEYWORDS ||
      'Data,Engineer';
    const location =
      Object.prototype.hasOwnProperty.call(normalizedOptions, 'location')
        ? normalizedOptions.location
        : process.env.APSJOBS_LOCATION || '';
    const maxPages =
      Object.prototype.hasOwnProperty.call(normalizedOptions, 'maxPages')
        ? normalizedOptions.maxPages
        : Number(process.env.APSJOBS_MAX_PAGES) || 3;
    const mode = options.mode || 'db';

    const args = [
      scriptPath,
      '--mode',
      mode,
      '--keywords',
      String(keywords),
      '--location',
      String(location),
      '--max-pages',
      String(maxPages),
    ];

    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let jobsAdded = 0;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      // Attempt to infer job count from scraper logs
      const upsertMatch = text.match(/Upserted\s+(\d+)\s+jobs/i);
      const totalMatch = text.match(/Total unique jobs collected:\s+(\d+)/i);
      const match = upsertMatch || totalMatch;
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (!Number.isNaN(parsed)) {
          jobsAdded = parsed;
        }
      }

      logger.info('Scraper stdout', { runId, output: text.trimEnd() });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      logger.error('Scraper stderr', { runId, output: text.trimEnd() });
    });

    child.on('close', (code) => {
      if (code === 0) {
        logger.info('Scraper completed successfully', { runId, jobsAdded, exitCode: code });
        markRunSuccess(runId, jobsAdded);
      } else {
        logger.error('Scraper exited with non-zero code', { runId, exitCode: code });
        markRunFailure(runId, `Scraper exited with code ${code}`);
      }
    });

    child.on('error', (err) => {
      logger.error('Failed to spawn scraper child process', { runId, err });
      markRunFailure(runId, err.message || String(err));
    });
  } catch (err) {
    logger.error('Unexpected error while running scraper', { runId, err });
    markRunFailure(runId, err.message || String(err));
  }
}

function triggerScrape(name, options = {}) {
  const scraperName = name || 'apsjobs';

  if (scraperName !== 'apsjobs') {
    logger.warn('Attempted to trigger unsupported scraper', { scraperName });
    throw new Error(`Unsupported scraper: ${scraperName}`);
  }

  // Validate and normalize user-provided options early so that HTTP
  // handlers can surface clear 400 errors for invalid input.
  const normalizedOptions = validateAndNormalizeApsjobsOptions(options || {});

  const runId = createRun(scraperName);

  logger.info('Scheduled scraper run', {
    runId,
    scraperName,
    options: normalizedOptions,
  });

  // Run in background, non-blocking for HTTP request
  setImmediate(() => {
    runApsjobsScraper(runId, normalizedOptions);
  });

  return runId;
}

function getScraperRuns(limit) {
  return getRecentRuns(limit || 20);
}

module.exports = {
  triggerScrape,
  getScraperRuns,
};
