'use strict';

const notificationsRepo = require('../repositories/notificationsRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const usersRepo = require('../repositories/usersRepo');
const emailService = require('./emailService');
const alertService = require('./alertService');
const { getLogger } = require('../logger');

const logger = getLogger('digestScheduler');

const ONE_HOUR_MS = 60 * 60 * 1000;

let timerId = null;
let running = false;

/**
 * Get the current UTC hour (0–23).
 */
function getCurrentUtcHour() {
  return new Date().getUTCHours();
}

/**
 * Calculate ms until the next hour boundary, with a small buffer.
 * Self-correcting: always recalculates from wall clock to avoid drift.
 */
function msUntilNextHour() {
  const now = Date.now();
  const nextHour = Math.ceil(now / ONE_HOUR_MS) * ONE_HOUR_MS;
  const delay = nextHour - now;
  // If we're exactly on the hour boundary, schedule for next hour
  return delay <= 0 ? ONE_HOUR_MS : delay;
}

/**
 * Process digest emails for all users whose digest_hour_utc matches the current UTC hour.
 */
async function tick() {
  const currentHour = getCurrentUtcHour();
  logger.info('Digest scheduler tick', { currentHour });

  const allUsers = usersRepo.findWithNotificationPrefs();

  // Fetch all pending digest notifications once, then group by user_id
  const allPending = notificationsRepo.getPendingEmails('digest');
  const pendingByUser = new Map();
  for (const n of allPending) {
    if (!pendingByUser.has(n.user_id)) pendingByUser.set(n.user_id, []);
    pendingByUser.get(n.user_id).push(n);
  }

  for (const user of allUsers) {
    const prefs = alertService.parseNotificationPrefs(user);

    if (!prefs.alerts_enabled) continue;
    if (prefs.frequency !== 'digest') continue;
    if (prefs.digest_hour_utc !== currentHour) continue;

    const userAllPending = pendingByUser.get(user.id) || [];

    if (userAllPending.length === 0) {
      logger.debug('No pending digest notifications for user', { userId: user.id });
      continue;
    }

    // Top 10 notifications ordered by score descending (WBS T-G.1 Step 6)
    const userPending = userAllPending
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10);

    // Build jobs array from the notification rows (they have job fields from JOIN)
    const jobs = userPending.map(n => ({
      id: n.job_id,
      title: n.job_title,
      company_name: n.company_name,
      location: n.location,
      source: n.source,
      url: n.job_url,
    }));

    const unsubToken = unsubscribeTokensRepo.getOrCreate(user.id);

    try {
      await emailService.sendDigestEmail(
        { id: user.id, email: user.email || userPending[0].user_email, display_name: user.display_name || userPending[0].user_display_name },
        userPending,
        jobs,
        unsubToken.token
      );

      // Mark only the included notifications as sent
      for (const n of userPending) {
        notificationsRepo.markEmailSent(n.id, 1);
      }

      logger.info('Digest email sent', {
        userId: user.id,
        notificationCount: userPending.length,
      });
    } catch (err) {
      // Mark only the included notifications as failed
      for (const n of userPending) {
        notificationsRepo.markEmailSent(n.id, 2);
      }

      logger.error('Failed to send digest email', {
        userId: user.id,
        error: err.message,
      });
    }
  }
}

/**
 * Schedule the next tick using self-correcting setTimeout.
 */
function scheduleNext() {
  if (!running) return;
  const delay = msUntilNextHour();
  logger.debug('Next digest tick scheduled', { delayMs: delay });
  timerId = setTimeout(async () => {
    try {
      await tick();
    } catch (err) {
      logger.error('Digest scheduler tick error', { error: err.message });
    }
    scheduleNext();
  }, delay);
}

/**
 * Start the digest scheduler. Begins the hourly self-correcting loop.
 */
function start() {
  if (running) return;
  running = true;
  logger.info('Digest scheduler started');
  scheduleNext();
}

/**
 * Stop the digest scheduler. Clears the pending timeout.
 */
function stop() {
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  logger.info('Digest scheduler stopped');
}

module.exports = {
  start,
  stop,
  tick,
  getCurrentUtcHour,
  msUntilNextHour,
};
