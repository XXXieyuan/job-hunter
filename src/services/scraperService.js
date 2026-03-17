const path = require('path');
const { spawn } = require('child_process');
const {
  createRun,
  markRunRunning,
  markRunSuccess,
  markRunFailure,
  updateRunProgress,
  getRunById,
  getRecentRuns,
} = require('../repositories/scraperRunsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('scraperService');

const INVALID_SCRAPER_OPTIONS_CODE = 'INVALID_SCRAPER_OPTIONS';

function validateAndNormalizeScraperOptions(rawOptions) {
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

function normalizeProgress(rawProgress, fallbackTotal) {
  if (!rawProgress || typeof rawProgress !== 'object') {
    return null;
  }

  const total =
    Number.isFinite(rawProgress.total) && rawProgress.total >= 0
      ? rawProgress.total
      : Number.isFinite(fallbackTotal) && fallbackTotal > 0
        ? fallbackTotal
        : 0;

  const current =
    Number.isFinite(rawProgress.current) && rawProgress.current >= 0
      ? rawProgress.current
      : 0;

  const message =
    typeof rawProgress.message === 'string' ? rawProgress.message : '';

  return { total, current, message };
}

function runScraper(runId, scraperName, options) {
  try {
    markRunRunning(runId);

    const scriptFile = scraperName === 'seek' ? 'seekScraper.js' : 'apsjobsScraper.js';
    const scriptPath = path.resolve(__dirname, '..', 'scrapers', scriptFile);

    const normalizedOptions = validateAndNormalizeScraperOptions(options || {});

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

    // Estimate total progress steps as pages per keyword; used as a fallback
    const keywordList = String(keywords)
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const estimatedTotalSteps = keywordList.length * Number(maxPages || 0);

    if (estimatedTotalSteps > 0) {
      updateRunProgress(runId, {
        total: estimatedTotalSteps,
        current: 0,
        message: 'Starting APSJobs scraper…',
      });
    }

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
      const lines = text.split(/\r?\n/);

      lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        // Progress messages from scraper: `[PROGRESS] {"total":..., "current":..., "message":"..."}`
        if (line.startsWith('[PROGRESS]')) {
          const jsonPart = line.slice('[PROGRESS]'.length).trim();
          try {
            const parsed = JSON.parse(jsonPart);
            const normalizedProgress = normalizeProgress(
              parsed,
              estimatedTotalSteps
            );
            if (normalizedProgress) {
              updateRunProgress(runId, normalizedProgress);
            }
          } catch (e) {
            logger.warn('Failed to parse scraper progress payload', {
              runId,
              raw: jsonPart,
            });
          }
          return;
        }

        // Attempt to infer job count from scraper logs based on JSON-ish meta.
        // Winston console format ends with a JSON object containing metadata.
        // Examples:
        //  - {"totalUniqueJobs": 42}
        //  - {"jobsCount": 42, "mode":"db"}
        const jobsCountMatch = line.match(/"jobsCount"\s*:\s*(\d+)/);
        const totalUniqueMatch = line.match(/"totalUniqueJobs"\s*:\s*(\d+)/);
        const match = jobsCountMatch || totalUniqueMatch;
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (!Number.isNaN(parsed)) {
            jobsAdded = parsed;
          }
        }

        logger.info('Scraper stdout', { runId, output: line });
      });
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

  if (scraperName !== 'apsjobs' && scraperName !== 'seek') {
    logger.warn('Attempted to trigger unsupported scraper', { scraperName });
    throw new Error(`Unsupported scraper: ${scraperName}`);
  }

  // Validate and normalize user-provided options early so that HTTP
  // handlers can surface clear 400 errors for invalid input.
  const normalizedOptions = validateAndNormalizeScraperOptions(options || {});

  const runId = createRun(scraperName);

  logger.info('Scheduled scraper run', {
    runId,
    scraperName,
    options: normalizedOptions,
  });

  // Run in background, non-blocking for HTTP request
  setImmediate(() => {
    runScraper(runId, scraperName, normalizedOptions);
  });

  return runId;
}

function getScraperRuns(limit) {
  return getRecentRuns(limit || 20);
}

module.exports = {
  triggerScrape,
  getScraperRuns,
  getRunById,
};
