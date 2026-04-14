'use strict';

const usersRepo = require('../repositories/usersRepo');
const scraperRunsRepo = require('../repositories/scraperRunsRepo');
const alertService = require('./alertService');
const { getLogger } = require('../logger');

const logger = getLogger('alertPoller');

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

let timerId = null;
let running = false;
let lastPollWatermark = null; // ISO timestamp of last processed scraper run

/**
 * Calculate ms until the next poll, self-correcting from wall clock.
 * Ensures consistent 60s intervals without drift accumulation.
 *
 * @param {number} tickStartMs - Date.now() when the current tick started
 */
function msUntilNextPoll(tickStartMs) {
  const elapsed = Date.now() - tickStartMs;
  const remaining = POLL_INTERVAL_MS - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Check if any user has alerts enabled.
 */
function hasAlertEnabledUsers() {
  const users = usersRepo.findWithNotificationPrefs();
  for (const user of users) {
    const prefs = alertService.parseNotificationPrefs(user);
    if (prefs.alerts_enabled) return true;
  }
  return false;
}

/**
 * Find scraper runs completed after the watermark.
 */
function findNewCompletedRuns() {
  const runs = scraperRunsRepo.getRecentRuns(50);
  const completed = runs.filter(r => r.status === 'success' && r.completed_at);

  if (!lastPollWatermark) {
    // On first poll, set watermark to now — don't process historical runs
    if (completed.length > 0) {
      lastPollWatermark = completed[0].completed_at;
    }
    return [];
  }

  return completed.filter(r => r.completed_at > lastPollWatermark);
}

/**
 * Poll for new completed scraper runs and trigger alert processing.
 */
async function tick() {
  const tickStart = Date.now();

  // Skip if no users have alerts enabled
  if (!hasAlertEnabledUsers()) {
    logger.debug('No alert-enabled users, skipping poll');
    return tickStart;
  }

  const newRuns = findNewCompletedRuns();

  if (newRuns.length === 0) {
    logger.debug('No new scraper runs since last poll');
    return tickStart;
  }

  logger.info('New scraper runs detected', { count: newRuns.length });

  // Delegate to alertService for scoring and notification creation
  try {
    await alertService.checkAndScoreNewJobs();

    // Update watermark only after successful processing
    const latest = newRuns.reduce((a, b) =>
      a.completed_at > b.completed_at ? a : b
    );
    lastPollWatermark = latest.completed_at;

    logger.info('Poll watermark updated', { watermark: lastPollWatermark });
  } catch (err) {
    logger.error('Alert processing failed', { error: err.message });
  }

  return tickStart;
}

/**
 * Schedule the next poll using self-correcting setTimeout.
 */
function scheduleNext(tickStartMs) {
  if (!running) return;
  const delay = msUntilNextPoll(tickStartMs || Date.now());
  timerId = setTimeout(async () => {
    let tickStart;
    try {
      tickStart = await tick();
    } catch (err) {
      tickStart = Date.now();
      logger.error('Alert poller tick error', { error: err.message });
    }
    scheduleNext(tickStart);
  }, delay);
}

/**
 * Start the alert poller. Begins the 60s self-correcting polling loop.
 */
function start() {
  if (running) return;
  running = true;
  lastPollWatermark = null;
  logger.info('Alert poller started');
  scheduleNext(Date.now());
}

/**
 * Stop the alert poller. Clears the pending timeout.
 */
function stop() {
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  logger.info('Alert poller stopped');
}

module.exports = {
  start,
  stop,
  tick,
  hasAlertEnabledUsers,
  findNewCompletedRuns,
  // Exposed for testing
  _setWatermark(wm) { lastPollWatermark = wm; },
  _getWatermark() { return lastPollWatermark; },
};
