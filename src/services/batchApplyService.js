'use strict';

const { getLogger } = require('../logger');
const batchApplyRepo = require('../repositories/batchApplyRepo');
const applicationsRepo = require('../repositories/applicationsRepo');
const seekFormFiller = require('./seekFormFiller');

const logger = getLogger('batchApplyService');

/**
 * Execution guard: prevents duplicate Playwright launches for the same sessionId.
 * Map<number, boolean>
 */
const executionGuard = new Map();

/**
 * Cancellation flags: Map<number, boolean> keyed by sessionId.
 */
const cancelFlags = new Map();

/**
 * Skip signals: Map<string, boolean> keyed by "sessionId:jobId".
 */
const skipSignals = new Map();

/**
 * Default delay range between jobs (ms).
 */
const DEFAULT_DELAY_MIN = 30000;
const DEFAULT_DELAY_MAX = 60000;

/**
 * Timeout waiting for user to submit the form (ms).
 */
const SUBMIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Seek URL pattern for validation.
 */
const SEEK_JOB_URL_PATTERN = /^https:\/\/www\.seek\.com\.au\/job\//;

/**
 * Recover stale sessions that were started but never completed.
 * Called from server.js at startup.
 *
 * @param {object} [deps] - Injectable dependencies for testing
 * @param {object} [deps.repo] - batchApplyRepo override
 */
function recoverStaleSessions(deps = {}) {
  const repo = deps.repo || batchApplyRepo;
  const recovered = repo.recoverStaleSessions(30);
  if (recovered > 0) {
    logger.warn('Recovered stale batch apply sessions', { count: recovered });
  }
  return recovered;
}

/**
 * Set the cancel flag for a session. The execution loop checks this between jobs.
 * @param {number} sessionId
 */
function requestCancel(sessionId) {
  cancelFlags.set(sessionId, true);
}

/**
 * Set the skip signal for a specific job in a session.
 * @param {number} sessionId
 * @param {number} jobId
 */
function requestSkip(sessionId, jobId) {
  skipSignals.set(`${sessionId}:${jobId}`, true);
}

/**
 * Check if a session is currently executing (has Playwright running).
 * @param {number} sessionId
 * @returns {boolean}
 */
function isExecuting(sessionId) {
  return executionGuard.has(sessionId);
}

/**
 * Detect CAPTCHA presence on the page.
 * @param {object} page
 * @returns {Promise<boolean>}
 */
async function detectCaptcha(page) {
  try {
    const recaptcha = await page.locator('iframe[src*="recaptcha"]').count();
    return recaptcha > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Detect rate-limiting on the page.
 * @param {object} page
 * @returns {Promise<boolean>}
 */
async function detectRateLimit(page) {
  try {
    const status = await page.evaluate(() => {
      // Check for 429 response via page content
      return document.body && document.body.innerText &&
        (document.body.innerText.includes('429') ||
         document.body.innerText.includes('Too Many Requests') ||
         document.body.innerText.includes('rate limit'));
    });
    return !!status;
  } catch (_) {
    return false;
  }
}

/**
 * Wait for user to submit the form or for a skip/timeout signal.
 * Detects navigation to a confirmation page as submit indicator.
 *
 * @param {object} page
 * @param {number} sessionId
 * @param {number} jobId
 * @returns {Promise<'submitted'|'skipped'|'timeout'>}
 */
async function waitForSubmitOrSignal(page, sessionId, jobId) {
  const skipKey = `${sessionId}:${jobId}`;

  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
    };

    // Poll for skip signal
    const pollInterval = setInterval(() => {
      if (resolved) return;
      if (skipSignals.get(skipKey)) {
        skipSignals.delete(skipKey);
        cleanup();
        resolve('skipped');
      }
    }, 500);

    // Listen for navigation (submit confirmation)
    page.waitForNavigation({ timeout: SUBMIT_TIMEOUT_MS }).then(() => {
      if (resolved) return;
      cleanup();
      resolve('submitted');
    }).catch(() => {
      // navigation timeout or error handled by timeoutHandle
    });

    // Absolute timeout
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      cleanup();
      resolve('timeout');
    }, SUBMIT_TIMEOUT_MS);
  });
}

/**
 * Get randomised delay between jobs.
 * Configurable via BATCH_APPLY_DELAY_MS env var (single value = fixed delay).
 * @returns {number} Delay in milliseconds
 */
function getJobDelay() {
  const envDelay = process.env.BATCH_APPLY_DELAY_MS;
  if (envDelay) {
    const parsed = parseInt(envDelay, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_DELAY_MIN + Math.floor(Math.random() * (DEFAULT_DELAY_MAX - DEFAULT_DELAY_MIN));
}

/**
 * Process a single job in the batch.
 *
 * @param {object} page - Playwright page
 * @param {object} job - batch_apply_jobs row (with title, company_name)
 * @param {object} profile - Application profile
 * @param {string} resumePath - Path to resume file
 * @param {string|null} coverLetterText - Cover letter text
 * @param {number} sessionId
 * @param {object} emitter - EventEmitter for SSE
 * @param {object} repo - batchApplyRepo
 * @param {object} appRepo - applicationsRepo functions
 * @returns {Promise<'applied'|'failed'|'skipped'>}
 */
async function processJob(page, job, profile, resumePath, coverLetterText, sessionId, emitter, repo, appRepo) {
  const now = new Date().toISOString();

  // Update job status to in-progress
  repo.updateJobStatus(job.id, 'in-progress', { started_at: now });

  // Emit job-start
  emitter.emit('sse', {
    event: 'job-start',
    data: { jobId: job.job_id, title: job.title, company: job.company_name },
  });

  // Validate job URL
  if (!job.url || !SEEK_JOB_URL_PATTERN.test(job.url)) {
    repo.updateJobStatus(job.id, 'failed', {
      error_reason: 'Invalid Seek job URL',
      completed_at: new Date().toISOString(),
    });
    repo.incrementSessionCounter(sessionId, 'failed_count');
    emitter.emit('sse', {
      event: 'failed',
      data: { jobId: job.job_id, errorReason: 'Invalid Seek job URL' },
    });
    return 'failed';
  }

  try {
    // Navigate to the job page
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check for rate limiting
    if (await detectRateLimit(page)) {
      emitter.emit('sse', {
        event: 'rate-limited',
        data: {},
      });
      repo.updateJobStatus(job.id, 'failed', {
        error_reason: 'Rate limited by Seek',
        completed_at: new Date().toISOString(),
      });
      repo.incrementSessionCounter(sessionId, 'failed_count');
      emitter.emit('sse', {
        event: 'failed',
        data: { jobId: job.job_id, errorReason: 'Rate limited by Seek' },
      });
      return 'failed';
    }

    // Check for CAPTCHA
    if (await detectCaptcha(page)) {
      emitter.emit('sse', {
        event: 'captcha-detected',
        data: { jobId: job.job_id },
      });
    }

    // Find and click Apply button
    try {
      const applyBtn = page.getByLabel('Apply');
      await applyBtn.click({ timeout: 10000 });
    } catch (_) {
      // Fallback: try text-based selector
      try {
        const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply for this job")');
        await applyBtn.first().click({ timeout: 10000 });
      } catch (applyErr) {
        throw new Error('Could not find Apply button on page');
      }
    }

    // Fill the form
    const fillResult = await seekFormFiller.fillForm(page, profile, resumePath, coverLetterText);

    // Update filled fields and warnings
    repo.updateJobStatus(job.id, 'awaiting-submit', {
      filled_fields: JSON.stringify(fillResult.filledFields),
      warnings: fillResult.warnings.length > 0 ? JSON.stringify(fillResult.warnings) : null,
    });

    if (!fillResult.success) {
      repo.updateJobStatus(job.id, 'failed', {
        error_reason: 'Form fill failed: ' + (fillResult.warnings.join('; ')),
        completed_at: new Date().toISOString(),
      });
      repo.incrementSessionCounter(sessionId, 'failed_count');
      emitter.emit('sse', {
        event: 'failed',
        data: { jobId: job.job_id, errorReason: 'Form fill failed: ' + fillResult.warnings.join('; ') },
      });
      return 'failed';
    }

    // Emit awaiting-submit
    emitter.emit('sse', {
      event: 'awaiting-submit',
      data: { jobId: job.job_id, filledFields: fillResult.filledFields, warnings: fillResult.warnings },
    });

    // Wait for user submit, skip signal, or timeout
    const outcome = await waitForSubmitOrSignal(page, sessionId, job.id);

    if (outcome === 'submitted') {
      const appliedAt = new Date().toISOString();
      repo.updateJobStatus(job.id, 'applied', {
        applied_at: appliedAt,
        completed_at: appliedAt,
      });
      repo.incrementSessionCounter(sessionId, 'applied_count');

      // Update application tracker
      try {
        appRepo.createIdempotent({
          user_id: job.user_id,
          job_id: job.job_id,
          status: 'applied',
        });
      } catch (err) {
        logger.warn('Failed to update application tracker', { jobId: job.job_id, error: err.message });
      }

      emitter.emit('sse', {
        event: 'applied',
        data: { jobId: job.job_id, appliedAt },
      });
      return 'applied';
    }

    if (outcome === 'skipped') {
      repo.updateJobStatus(job.id, 'skipped', {
        error_reason: 'Skipped by user',
        completed_at: new Date().toISOString(),
      });
      repo.incrementSessionCounter(sessionId, 'skipped_count');
      emitter.emit('sse', {
        event: 'skipped',
        data: { jobId: job.job_id, reason: 'Skipped by user' },
      });
      return 'skipped';
    }

    // timeout
    repo.updateJobStatus(job.id, 'skipped', {
      error_reason: 'Submit timeout (5 minutes)',
      completed_at: new Date().toISOString(),
    });
    repo.incrementSessionCounter(sessionId, 'skipped_count');
    emitter.emit('sse', {
      event: 'skipped',
      data: { jobId: job.job_id, reason: 'Submit timeout (5 minutes)' },
    });
    return 'skipped';

  } catch (err) {
    logger.error('Job processing error', { jobId: job.job_id, error: err.message });
    repo.updateJobStatus(job.id, 'failed', {
      error_reason: err.message,
      completed_at: new Date().toISOString(),
    });
    repo.incrementSessionCounter(sessionId, 'failed_count');
    emitter.emit('sse', {
      event: 'failed',
      data: { jobId: job.job_id, errorReason: err.message },
    });
    return 'failed';
  }
}

/**
 * Main batch apply orchestration.
 * Launches Playwright in headful mode, processes jobs sequentially.
 *
 * @param {number} sessionId
 * @param {object} emitter - EventEmitter for SSE events
 * @param {object} [deps] - Injectable dependencies for testing
 * @param {object} [deps.repo] - batchApplyRepo override
 * @param {object} [deps.appRepo] - applicationsRepo override
 * @param {object} [deps.profile] - Application profile
 * @param {string} [deps.resumePath] - Path to resume file
 * @param {function} [deps.getCoverLetterText] - Function(jobId) returning cover letter text
 * @param {function} [deps.launchBrowser] - Override for playwright.chromium.launch
 * @param {object[]} [deps.jobs] - Override session jobs
 */
async function executeBatch(sessionId, emitter, deps = {}) {
  // Execution guard: prevent duplicate launches
  if (executionGuard.has(sessionId)) {
    logger.warn('executeBatch called for already-executing session', { sessionId });
    return;
  }
  executionGuard.set(sessionId, true);

  const repo = deps.repo || batchApplyRepo;
  const appRepo = deps.appRepo || { createIdempotent: applicationsRepo.createIdempotent, updateStatus: applicationsRepo.updateStatus };
  let browser = null;

  try {
    // Mark session as in-progress
    repo.updateSessionStatus(sessionId, 'in-progress', {
      started_at: new Date().toISOString(),
    });

    // Launch Playwright browser
    try {
      if (deps.launchBrowser) {
        browser = await deps.launchBrowser();
      } else {
        const { chromium } = require('playwright');
        browser = await chromium.launch({ headless: false });
      }
    } catch (launchErr) {
      const isNotInstalled = launchErr.message &&
        (launchErr.message.includes('Executable doesn\'t exist') ||
         launchErr.message.includes('browserType.launch'));

      emitter.emit('sse', {
        event: 'error',
        data: {
          message: isNotInstalled
            ? 'Playwright browser not installed. Run: npx playwright install chromium'
            : 'Failed to launch browser: ' + launchErr.message,
        },
      });

      repo.updateSessionStatus(sessionId, 'cancelled', {
        completed_at: new Date().toISOString(),
      });
      return;
    }

    // Get session jobs
    const jobs = deps.jobs || repo.getSessionJobs(sessionId);

    if (jobs.length === 0) {
      emitter.emit('sse', {
        event: 'batch-complete',
        data: { summary: { applied: 0, failed: 0, skipped: 0 } },
      });
      repo.updateSessionStatus(sessionId, 'completed', {
        completed_at: new Date().toISOString(),
      });
      return;
    }

    // Create browser context with domain blocking
    const context = await browser.newContext();

    // Block non-seek.com.au navigation
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('seek.com.au') || url.startsWith('data:') || url.startsWith('blob:')) {
        route.continue();
      } else {
        route.abort();
      }
    });

    const page = await context.newPage();

    // Pre-flight validation on first job
    const firstJob = jobs[0];
    if (firstJob.url && SEEK_JOB_URL_PATTERN.test(firstJob.url)) {
      try {
        await page.goto(firstJob.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Check if the page has recognizable structure
        const hasApply = await page.locator('button:has-text("Apply"), a:has-text("Apply")').count();
        if (hasApply === 0) {
          emitter.emit('sse', {
            event: 'error',
            data: { message: 'Seek apply form not recognized. Page structure may have changed.' },
          });
          repo.updateSessionStatus(sessionId, 'cancelled', {
            completed_at: new Date().toISOString(),
          });
          await browser.close();
          return;
        }
      } catch (preflightErr) {
        emitter.emit('sse', {
          event: 'error',
          data: { message: 'Pre-flight check failed: ' + preflightErr.message },
        });
        repo.updateSessionStatus(sessionId, 'cancelled', {
          completed_at: new Date().toISOString(),
        });
        await browser.close();
        return;
      }
    }

    // Process jobs sequentially
    let applied = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];

      // Check cancel flag
      if (cancelFlags.get(sessionId)) {
        // Mark remaining jobs as skipped
        for (let j = i; j < jobs.length; j++) {
          repo.updateJobStatus(jobs[j].id, 'skipped', {
            error_reason: 'Batch cancelled by user',
            completed_at: new Date().toISOString(),
          });
          repo.incrementSessionCounter(sessionId, 'skipped_count');
        }
        skipped += jobs.length - i;
        cancelFlags.delete(sessionId);

        emitter.emit('sse', {
          event: 'batch-cancelled',
          data: {},
        });

        repo.updateSessionStatus(sessionId, 'cancelled', {
          completed_at: new Date().toISOString(),
        });
        await browser.close();
        executionGuard.delete(sessionId);
        return;
      }

      // Get cover letter text for this job
      let coverLetterText = null;
      if (deps.getCoverLetterText) {
        coverLetterText = await deps.getCoverLetterText(job.job_id);
      }

      const profile = deps.profile || {};
      const resumePath = deps.resumePath || '';

      const result = await processJob(
        page, job, profile, resumePath, coverLetterText,
        sessionId, emitter, repo, appRepo
      );

      if (result === 'applied') applied++;
      else if (result === 'failed') failed++;
      else if (result === 'skipped') skipped++;

      // Delay between jobs (except after last job)
      if (i < jobs.length - 1) {
        const delay = getJobDelay();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Batch complete
    emitter.emit('sse', {
      event: 'batch-complete',
      data: { summary: { applied, failed, skipped } },
    });

    repo.updateSessionStatus(sessionId, 'completed', {
      completed_at: new Date().toISOString(),
    });

    await browser.close();
  } catch (err) {
    logger.error('Batch execution error', { sessionId, error: err.message });
    emitter.emit('sse', {
      event: 'error',
      data: { message: 'Batch execution error: ' + err.message },
    });
    repo.updateSessionStatus(sessionId, 'cancelled', {
      completed_at: new Date().toISOString(),
    });
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
  } finally {
    executionGuard.delete(sessionId);
    cancelFlags.delete(sessionId);
  }
}

module.exports = {
  executeBatch,
  recoverStaleSessions,
  requestCancel,
  requestSkip,
  isExecuting,
  // Exported for testing
  getJobDelay,
};
