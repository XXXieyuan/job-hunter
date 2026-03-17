const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
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
const scraperRunEvents = new EventEmitter();
scraperRunEvents.setMaxListeners(0);

const INVALID_SCRAPER_OPTIONS_CODE = 'INVALID_SCRAPER_OPTIONS';
const SCRAPER_CONFIGS = {
  apsjobs: {
    label: 'APSJobs',
    runtime: 'node',
    scriptDir: 'scrapers',
    scriptFile: 'apsjobsScraper.js',
    envPrefix: 'APSJOBS',
  },
  seek: {
    label: 'Seek',
    runtime: 'python',
    scriptDir: 'root',
    scriptFile: 'scrape_seek.py',
    envPrefix: 'SEEK',
  },
  linkedin: {
    label: 'LinkedIn',
    runtime: 'node',
    scriptDir: 'scrapers',
    scriptFile: 'linkedinScraper.js',
    envPrefix: 'LINKEDIN',
  },
};

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

  if (Object.prototype.hasOwnProperty.call(options, 'mode')) {
    if (options.mode != null && typeof options.mode !== 'string') {
      const err = new Error('mode must be a string if provided.');
      err.code = INVALID_SCRAPER_OPTIONS_CODE;
      throw err;
    }

    if (typeof options.mode === 'string') {
      const trimmed = options.mode.trim().toLowerCase();
      if (trimmed) {
        normalized.mode = trimmed;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'output')) {
    if (options.output != null && typeof options.output !== 'string') {
      const err = new Error('output must be a string if provided.');
      err.code = INVALID_SCRAPER_OPTIONS_CODE;
      throw err;
    }

    if (typeof options.output === 'string') {
      const trimmed = options.output.trim();
      if (trimmed) {
        normalized.output = trimmed;
      }
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

function parseStoredProgress(progressJson) {
  if (!progressJson || typeof progressJson !== 'string') {
    return undefined;
  }

  try {
    return normalizeProgress(JSON.parse(progressJson));
  } catch {
    return undefined;
  }
}

function normalizeRunStatus(status) {
  if (!status) return 'queued';
  if (status === 'success') return 'completed';
  if (status === 'failure') return 'failed';
  return status;
}

function serializeRun(row) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    scraper_name: row.scraper_name || null,
    status: normalizeRunStatus(row.status),
    progress: parseStoredProgress(row.progress_json),
    jobs_added:
      typeof row.jobs_added === 'number' ? row.jobs_added : undefined,
    error_message: row.error_message || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
  };
}

function getScraperRunSnapshot(runId) {
  return serializeRun(getRunById(runId));
}

function emitRunUpdate(runId) {
  const snapshot = getScraperRunSnapshot(runId);
  if (!snapshot) {
    return;
  }

  scraperRunEvents.emit(String(runId), snapshot);
}

function subscribeToScraperProgress(runId, listener) {
  const eventName = String(runId);
  scraperRunEvents.on(eventName, listener);

  return () => {
    scraperRunEvents.off(eventName, listener);
  };
}

function resolveScriptPath(scraperConfig) {
  if (scraperConfig.scriptDir === 'root') {
    return path.resolve(__dirname, '..', '..', scraperConfig.scriptFile);
  }

  return path.resolve(__dirname, '..', 'scrapers', scraperConfig.scriptFile);
}

function buildSpawnConfig(scraperConfig, scriptPath, cliArgs) {
  if (scraperConfig.runtime === 'python') {
    return {
      command: process.env.PYTHON_BIN || 'python3',
      args: ['-u', scriptPath, ...cliArgs],
    };
  }

  return {
    command: process.execPath,
    args: [scriptPath, ...cliArgs],
  };
}

function createLineBuffer(onLine) {
  let buffer = '';

  return {
    append(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (!buffer.trim()) {
        buffer = '';
        return;
      }

      onLine(buffer);
      buffer = '';
    },
  };
}

function runScraper(runId, scraperName, options) {
  try {
    markRunRunning(runId);
    emitRunUpdate(runId);

    const scraperConfig = SCRAPER_CONFIGS[scraperName];

    if (!scraperConfig) {
      throw new Error(`Unsupported scraper: ${scraperName}`);
    }

    const scriptPath = resolveScriptPath(scraperConfig);

    const normalizedOptions = validateAndNormalizeScraperOptions(options || {});
    const envKeywords = process.env[`${scraperConfig.envPrefix}_KEYWORDS`];
    const envLocation = process.env[`${scraperConfig.envPrefix}_LOCATION`];
    const envMaxPages = Number(process.env[`${scraperConfig.envPrefix}_MAX_PAGES`]);

    const keywords =
      normalizedOptions.keywords ||
      envKeywords ||
      'Data,Engineer';
    const location =
      Object.prototype.hasOwnProperty.call(normalizedOptions, 'location')
        ? normalizedOptions.location
        : envLocation || '';
    const maxPages =
      Object.prototype.hasOwnProperty.call(normalizedOptions, 'maxPages')
        ? normalizedOptions.maxPages
        : envMaxPages || 3;
    const mode = normalizedOptions.mode || 'db';

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
        message: `Starting ${scraperConfig.label} scraper…`,
      });
    }

    const cliArgs = [
      '--mode',
      mode,
      '--keywords',
      String(keywords),
      '--location',
      String(location),
      '--max-pages',
      String(maxPages),
    ];

    if (normalizedOptions.output) {
      cliArgs.push('--output', normalizedOptions.output);
    }

    const childEnv = { ...process.env };
    if (scraperConfig.runtime === 'python') {
      childEnv.PYTHONUNBUFFERED = '1';
    }

    const spawnConfig = buildSpawnConfig(scraperConfig, scriptPath, cliArgs);
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });

    let jobsAdded = 0;
    const stdoutLines = createLineBuffer((rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) return;

      if (line.startsWith('[PROGRESS]')) {
        const jsonPart = line.slice('[PROGRESS]'.length).trim();
        try {
          const parsed = JSON.parse(jsonPart);
          const normalizedProgress = normalizeProgress(
            parsed,
            estimatedTotalSteps,
          );
          if (normalizedProgress) {
            updateRunProgress(runId, normalizedProgress);
            emitRunUpdate(runId);
          }
        } catch (e) {
          logger.warn('Failed to parse scraper progress payload', {
            runId,
            raw: jsonPart,
          });
        }
        return;
      }

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

    const stderrLines = createLineBuffer((rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) return;
      logger.error('Scraper stderr', { runId, output: line });
    });

    child.stdout.on('data', (data) => {
      stdoutLines.append(data);
    });

    child.stderr.on('data', (data) => {
      stderrLines.append(data);
    });

    child.on('close', (code) => {
      stdoutLines.flush();
      stderrLines.flush();

      if (code === 0) {
        updateRunProgress(
          runId,
          normalizeProgress(
            {
              total: estimatedTotalSteps,
              current: estimatedTotalSteps,
              message: `${scraperConfig.label} scraper completed.`,
            },
            estimatedTotalSteps,
          ),
        );
        logger.info('Scraper completed successfully', { runId, jobsAdded, exitCode: code });
        markRunSuccess(runId, jobsAdded);
        emitRunUpdate(runId);
      } else {
        logger.error('Scraper exited with non-zero code', { runId, exitCode: code });
        updateRunProgress(
          runId,
          normalizeProgress(
            {
              total:
                getScraperRunSnapshot(runId)?.progress?.total ||
                estimatedTotalSteps,
              current: getScraperRunSnapshot(runId)?.progress?.current || 0,
              message: `${scraperConfig.label} scraper failed.`,
            },
            estimatedTotalSteps,
          ),
        );
        markRunFailure(runId, `Scraper exited with code ${code}`);
        emitRunUpdate(runId);
      }
    });

    child.on('error', (err) => {
      logger.error('Failed to spawn scraper child process', { runId, err });
      updateRunProgress(
        runId,
        normalizeProgress(
          {
            total:
              getScraperRunSnapshot(runId)?.progress?.total ||
              estimatedTotalSteps,
            current: getScraperRunSnapshot(runId)?.progress?.current || 0,
            message: `${scraperConfig.label} scraper failed to start.`,
          },
          estimatedTotalSteps,
        ),
      );
      markRunFailure(runId, err.message || String(err));
      emitRunUpdate(runId);
    });
  } catch (err) {
    logger.error('Unexpected error while running scraper', { runId, err });
    markRunFailure(runId, err.message || String(err));
    emitRunUpdate(runId);
  }
}

function triggerScrape(name, options = {}) {
  const scraperName = name || options.source || 'apsjobs';

  if (!SCRAPER_CONFIGS[scraperName]) {
    logger.warn('Attempted to trigger unsupported scraper', { scraperName });
    throw new Error(`Unsupported scraper: ${scraperName}`);
  }

  // Validate and normalize user-provided options early so that HTTP
  // handlers can surface clear 400 errors for invalid input.
  const normalizedOptions = validateAndNormalizeScraperOptions(options || {});

  const runId = createRun(scraperName);
  emitRunUpdate(runId);

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
  getScraperRunSnapshot,
  subscribeToScraperProgress,
};
