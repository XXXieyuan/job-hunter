'use strict';

const crypto = require('crypto');
const notificationsRepo = require('../repositories/notificationsRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const fitScoresRepo = require('../repositories/fitScoresRepo');
const resumesRepo = require('../repositories/resumesRepo');
const usersRepo = require('../repositories/usersRepo');
const emailService = require('./emailService');
const backgroundQueue = require('./backgroundQueue');
const { getLogger } = require('../logger');

const logger = getLogger('alertService');

/**
 * Parse notification preferences from user's notification_prefs_json.
 * Returns defaults if missing or invalid.
 */
function parseNotificationPrefs(user) {
  const defaults = {
    alerts_enabled: false,
    score_threshold: 70,
    frequency: 'immediate',
    digest_hour_utc: 22,
  };

  if (!user || !user.notification_prefs_json) return defaults;

  try {
    const prefs = typeof user.notification_prefs_json === 'string'
      ? JSON.parse(user.notification_prefs_json)
      : user.notification_prefs_json;
    return {
      alerts_enabled: typeof prefs.alerts_enabled === 'boolean' ? prefs.alerts_enabled : defaults.alerts_enabled,
      score_threshold: typeof prefs.score_threshold === 'number'
        ? Math.max(50, Math.min(100, prefs.score_threshold))
        : defaults.score_threshold,
      frequency: prefs.frequency === 'digest' ? 'digest' : 'immediate',
      digest_hour_utc: typeof prefs.digest_hour_utc === 'number'
        ? Math.max(0, Math.min(23, prefs.digest_hour_utc))
        : defaults.digest_hour_utc,
    };
  } catch {
    return defaults;
  }
}

/**
 * Extract top N matched skills from a score's breakdown_json.
 */
function extractTopSkills(scoreRow, maxSkills = 3) {
  if (!scoreRow || !scoreRow.breakdown_json) return [];
  try {
    const breakdown = typeof scoreRow.breakdown_json === 'string'
      ? JSON.parse(scoreRow.breakdown_json)
      : scoreRow.breakdown_json;
    const matched = breakdown.matched_skills;
    if (!Array.isArray(matched)) return [];
    return matched.slice(0, maxSkills);
  } catch {
    return [];
  }
}

/**
 * Process newly scored jobs for a user: create notifications and enqueue emails.
 *
 * @param {number} userId
 * @param {number} resumeId
 * @param {number[]} newJobIds - IDs of jobs that were just scored
 */
async function processNewScores(userId, resumeId, newJobIds) {
  if (!newJobIds || newJobIds.length === 0) return;

  const user = usersRepo.findById(userId);
  if (!user) return;

  const prefs = parseNotificationPrefs(user);
  if (!prefs.alerts_enabled) return;

  const threshold = prefs.score_threshold;
  const frequency = prefs.frequency;

  // Get scores for these jobs that meet the threshold
  const qualifyingScores = [];
  for (const jobId of newJobIds) {
    const score = fitScoresRepo.getScoreForJobAndResume(jobId, resumeId);
    if (score && score.overall_score >= threshold) {
      qualifyingScores.push(score);
    }
  }

  // Sort by score descending, cap at 20
  qualifyingScores.sort((a, b) => b.overall_score - a.overall_score);
  const capped = qualifyingScores.slice(0, 20);

  if (capped.length === 0) return;

  // Build notification records
  const notificationRows = capped.map(score => {
    const topSkills = extractTopSkills(score, 3);
    const readToken = crypto.randomBytes(16).toString('hex');
    return {
      user_id: userId,
      job_id: score.job_id,
      score: Math.round(score.overall_score),
      top_matched_skills: JSON.stringify(topSkills),
      visa_match: score.visa_match !== undefined ? score.visa_match : null,
      frequency,
      read_token: readToken,
    };
  });

  // Batch insert (INSERT OR IGNORE handles duplicates)
  const inserted = notificationsRepo.createBatch(notificationRows);

  logger.info('Notifications created', {
    userId,
    total: inserted.length,
    frequency,
  });

  // For immediate frequency, enqueue email tasks
  if (frequency === 'immediate' && emailService.isEnabled()) {
    const unsubToken = unsubscribeTokensRepo.getOrCreate(userId);
    for (const notification of inserted) {
      backgroundQueue.enqueue('sendAlertEmail', {
        userId,
        notificationId: notification.id,
        jobId: notification.job_id,
        unsubscribeToken: unsubToken.token,
      });
    }
  }

  return inserted;
}

/**
 * Check for users with alerts enabled and confirmed resumes,
 * and enqueue scoring for new jobs since their last poll.
 */
async function checkAndScoreNewJobs() {
  const allUsers = usersRepo.findWithNotificationPrefs();

  for (const user of allUsers) {
    const prefs = parseNotificationPrefs(user);
    if (!prefs.alerts_enabled) continue;

    const resume = resumesRepo.getConfirmedResumeForUser(user.id);
    if (!resume) continue;

    const unscoredJobs = fitScoresRepo.findUnscoredJobsForResume(resume.id);

    if (unscoredJobs.length === 0) continue;

    const jobIds = unscoredJobs.map(j => j.id);

    backgroundQueue.enqueue('scoreNewJobs', {
      userId: user.id,
      resumeId: resume.id,
      jobIds,
    });

    logger.info('Enqueued scoring for alert user', {
      userId: user.id,
      resumeId: resume.id,
      jobCount: jobIds.length,
    });
  }
}

/**
 * Called when a scraper run completes. Skips if no new/updated jobs.
 *
 * @param {object} scraperResult - { jobs_new, jobs_updated, ... }
 */
async function onScraperComplete(scraperResult) {
  if (!scraperResult) return;
  if ((scraperResult.jobs_new || 0) === 0 && (scraperResult.jobs_updated || 0) === 0) {
    logger.info('No new/updated jobs from scraper, skipping alert check');
    return;
  }

  await module.exports.checkAndScoreNewJobs();
}

module.exports = {
  parseNotificationPrefs,
  extractTopSkills,
  processNewScores,
  checkAndScoreNewJobs,
  onScraperComplete,
};
