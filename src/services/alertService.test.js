'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const usersRepo = require('../repositories/usersRepo');
const fitScoresRepo = require('../repositories/fitScoresRepo');
const resumesRepo = require('../repositories/resumesRepo');
const notificationsRepo = require('../repositories/notificationsRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const emailService = require('./emailService');
const backgroundQueue = require('./backgroundQueue');

const alertService = require('./alertService');

describe('alertService', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('parseNotificationPrefs', () => {
    it('returns defaults for null user', () => {
      const prefs = alertService.parseNotificationPrefs(null);
      assert.equal(prefs.alerts_enabled, false);
      assert.equal(prefs.score_threshold, 70);
      assert.equal(prefs.frequency, 'immediate');
    });

    it('returns defaults for missing prefs JSON', () => {
      const prefs = alertService.parseNotificationPrefs({ id: 1 });
      assert.equal(prefs.alerts_enabled, false);
      assert.equal(prefs.score_threshold, 70);
    });

    it('parses valid JSON prefs', () => {
      const user = {
        id: 1,
        notification_prefs_json: JSON.stringify({
          alerts_enabled: true,
          score_threshold: 80,
          frequency: 'digest',
          digest_hour_utc: 10,
        }),
      };
      const prefs = alertService.parseNotificationPrefs(user);
      assert.equal(prefs.alerts_enabled, true);
      assert.equal(prefs.score_threshold, 80);
      assert.equal(prefs.frequency, 'digest');
      assert.equal(prefs.digest_hour_utc, 10);
    });

    it('clamps threshold to 50-100 range', () => {
      const user = {
        id: 1,
        notification_prefs_json: JSON.stringify({ score_threshold: 30 }),
      };
      const prefs = alertService.parseNotificationPrefs(user);
      assert.equal(prefs.score_threshold, 50);
    });
  });

  describe('extractTopSkills', () => {
    it('extracts top 3 skills from breakdown_json', () => {
      const scoreRow = {
        breakdown_json: JSON.stringify({
          matched_skills: ['Python', 'SQL', 'Data Analysis', 'Excel'],
        }),
      };
      const skills = alertService.extractTopSkills(scoreRow, 3);
      assert.deepEqual(skills, ['Python', 'SQL', 'Data Analysis']);
    });

    it('returns empty array for missing breakdown', () => {
      assert.deepEqual(alertService.extractTopSkills(null), []);
      assert.deepEqual(alertService.extractTopSkills({}), []);
    });
  });

  describe('processNewScores', () => {
    const makeUser = (overrides = {}) => ({
      id: 1,
      email: 'wei@example.com',
      display_name: 'Wei',
      notification_prefs_json: JSON.stringify({
        alerts_enabled: true,
        score_threshold: 70,
        frequency: 'immediate',
      }),
      ...overrides,
    });

    const makeScore = (jobId, overallScore) => ({
      job_id: jobId,
      resume_id: 10,
      overall_score: overallScore,
      visa_match: 1,
      breakdown_json: JSON.stringify({
        matched_skills: ['Python', 'SQL', 'Data Analysis', 'Excel'],
      }),
    });

    beforeEach(() => {
      mock.method(usersRepo, 'findById', () => makeUser());
      mock.method(notificationsRepo, 'createBatch', (items) =>
        items.map((item, i) => ({ id: i + 1, ...item }))
      );
      mock.method(emailService, 'isEnabled', () => true);
      mock.method(unsubscribeTokensRepo, 'getOrCreate', () => ({
        id: 1,
        user_id: 1,
        token: 'a'.repeat(64),
      }));
      mock.method(backgroundQueue, 'enqueue', () => 'task-id');
    });

    // T-55: processNewScores with 25 jobs creates exactly 20 notifications (cap)
    it('caps notifications at 20 by score desc (T-55)', async () => {
      const jobIds = Array.from({ length: 25 }, (_, i) => i + 1);
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 70 + jobId)
      );

      await alertService.processNewScores(1, 10, jobIds);

      const createBatchCalls = notificationsRepo.createBatch.mock.calls;
      assert.equal(createBatchCalls.length, 1);
      const batch = createBatchCalls[0].arguments[0];
      assert.equal(batch.length, 20);
      // Should be sorted by score desc — highest job_id (25) has highest score (95)
      assert.equal(batch[0].job_id, 25);
      assert.equal(batch[0].score, 95);
    });

    // T-56: notifications ordered by score desc; top_matched_skills contains max 3
    it('denormalizes top 3 skills into notification (T-56)', async () => {
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);

      const batch = notificationsRepo.createBatch.mock.calls[0].arguments[0];
      const skills = JSON.parse(batch[0].top_matched_skills);
      assert.ok(skills.length <= 3);
      assert.deepEqual(skills, ['Python', 'SQL', 'Data Analysis']);
    });

    // T-57: denormalizes visa_match
    it('denormalizes visa_match into notification (T-57)', async () => {
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);

      const batch = notificationsRepo.createBatch.mock.calls[0].arguments[0];
      assert.equal(batch[0].visa_match, 1);
    });

    // T-58: read_token is 32-char hex
    it('generates 32-char hex read_token per notification (T-58)', async () => {
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);

      const batch = notificationsRepo.createBatch.mock.calls[0].arguments[0];
      assert.match(batch[0].read_token, /^[a-f0-9]{32}$/);
    });

    // T-59: immediate-frequency user gets email tasks enqueued
    it('enqueues sendAlertEmail for immediate-frequency users (T-59)', async () => {
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);

      const enqueueCalls = backgroundQueue.enqueue.mock.calls;
      assert.ok(enqueueCalls.length > 0);
      assert.equal(enqueueCalls[0].arguments[0], 'sendAlertEmail');
      assert.equal(enqueueCalls[0].arguments[1].notificationId, 1);
    });

    // T-60: digest-frequency user does not get email enqueued
    it('does not enqueue email for digest-frequency users (T-60)', async () => {
      mock.method(usersRepo, 'findById', () =>
        makeUser({
          notification_prefs_json: JSON.stringify({
            alerts_enabled: true,
            score_threshold: 70,
            frequency: 'digest',
          }),
        })
      );
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);

      // createBatch should be called (notification created)
      assert.equal(notificationsRepo.createBatch.mock.calls.length, 1);
      // but enqueue should NOT be called for email
      assert.equal(backgroundQueue.enqueue.mock.calls.length, 0);
    });

    // T-61: respects user's score_threshold
    it('respects user score_threshold (T-61)', async () => {
      mock.method(usersRepo, 'findById', () =>
        makeUser({
          notification_prefs_json: JSON.stringify({
            alerts_enabled: true,
            score_threshold: 90,
            frequency: 'immediate',
          }),
        })
      );
      // Job 1 scores 80 (below threshold), Job 2 scores 95 (above)
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, jobId === 1 ? 80 : 95)
      );

      await alertService.processNewScores(1, 10, [1, 2]);

      const batch = notificationsRepo.createBatch.mock.calls[0].arguments[0];
      assert.equal(batch.length, 1);
      assert.equal(batch[0].job_id, 2);
    });

    // T-159: Large scrape batch (500+ jobs) caps at 20 notifications per user
    it('caps at 20 with 500 qualifying jobs (T-159)', async () => {
      const jobIds = Array.from({ length: 500 }, (_, i) => i + 1);
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 70 + (jobId % 30))
      );

      await alertService.processNewScores(1, 10, jobIds);

      const batch = notificationsRepo.createBatch.mock.calls[0].arguments[0];
      assert.equal(batch.length, 20);
    });

    it('handles user not found gracefully', async () => {
      mock.method(usersRepo, 'findById', () => null);
      // Should not throw
      await alertService.processNewScores(999, 10, [1]);
      assert.equal(notificationsRepo.createBatch.mock.calls.length, 0);
    });

    it('handles empty job IDs', async () => {
      await alertService.processNewScores(1, 10, []);
      assert.equal(notificationsRepo.createBatch.mock.calls.length, 0);
    });

    it('skips when alerts disabled', async () => {
      mock.method(usersRepo, 'findById', () =>
        makeUser({
          notification_prefs_json: JSON.stringify({ alerts_enabled: false }),
        })
      );
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );

      await alertService.processNewScores(1, 10, [42]);
      assert.equal(notificationsRepo.createBatch.mock.calls.length, 0);
    });

    // T-F.1 Verify: duplicate job_id for same user is ignored
    it('handles createBatch returning fewer items than passed (duplicate IGNORE)', async () => {
      mock.method(fitScoresRepo, 'getScoreForJobAndResume', (jobId) =>
        makeScore(jobId, 85)
      );
      // Simulate INSERT OR IGNORE deduplication: 3 notifications submitted, only 2 inserted
      mock.method(notificationsRepo, 'createBatch', (items) => {
        // Return only first 2 items, simulating that third was a duplicate
        return items.slice(0, 2).map((item, i) => ({ id: i + 1, ...item }));
      });

      const result = await alertService.processNewScores(1, 10, [42, 43, 44]);

      // Should return only the 2 inserted (non-duplicate) notifications
      assert.equal(result.length, 2);
      // Email enqueue should only happen for the 2 inserted notifications
      const enqueueCalls = backgroundQueue.enqueue.mock.calls;
      assert.equal(enqueueCalls.length, 2);
    });
  });

  describe('checkAndScoreNewJobs', () => {
    beforeEach(() => {
      mock.method(backgroundQueue, 'enqueue', () => 'task-id');
    });

    it('enqueues scoring for users with alerts enabled and confirmed resumes', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [
        {
          id: 1,
          email: 'wei@example.com',
          notification_prefs_json: JSON.stringify({
            alerts_enabled: true,
            score_threshold: 70,
            frequency: 'immediate',
          }),
        },
      ]);
      mock.method(resumesRepo, 'getConfirmedResumeForUser', () => ({
        id: 10,
        user_id: 1,
      }));
      mock.method(fitScoresRepo, 'findUnscoredJobsForResume', () => [
        { id: 101 },
        { id: 102 },
      ]);

      await alertService.checkAndScoreNewJobs();

      const enqueueCalls = backgroundQueue.enqueue.mock.calls;
      assert.equal(enqueueCalls.length, 1);
      assert.equal(enqueueCalls[0].arguments[0], 'scoreNewJobs');
      assert.deepEqual(enqueueCalls[0].arguments[1].jobIds, [101, 102]);
      assert.equal(enqueueCalls[0].arguments[1].userId, 1);
      assert.equal(enqueueCalls[0].arguments[1].resumeId, 10);
    });

    it('skips users with alerts disabled', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [
        {
          id: 1,
          notification_prefs_json: JSON.stringify({ alerts_enabled: false }),
        },
      ]);
      mock.method(resumesRepo, 'getConfirmedResumeForUser', () => ({
        id: 10,
      }));
      mock.method(fitScoresRepo, 'findUnscoredJobsForResume', () => [
        { id: 101 },
      ]);

      await alertService.checkAndScoreNewJobs();

      assert.equal(backgroundQueue.enqueue.mock.calls.length, 0);
    });

    it('skips users without confirmed resume', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [
        {
          id: 1,
          notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
        },
      ]);
      mock.method(resumesRepo, 'getConfirmedResumeForUser', () => null);

      await alertService.checkAndScoreNewJobs();

      assert.equal(backgroundQueue.enqueue.mock.calls.length, 0);
    });

    it('skips users with no unscored jobs', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [
        {
          id: 1,
          notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
        },
      ]);
      mock.method(resumesRepo, 'getConfirmedResumeForUser', () => ({
        id: 10,
      }));
      mock.method(fitScoresRepo, 'findUnscoredJobsForResume', () => []);

      await alertService.checkAndScoreNewJobs();

      assert.equal(backgroundQueue.enqueue.mock.calls.length, 0);
    });
  });

  // T-64: onScraperComplete with zero new jobs does not trigger scoring
  describe('onScraperComplete', () => {
    it('skips when no new/updated jobs (T-64)', async () => {
      const checkSpy = mock.method(alertService, 'checkAndScoreNewJobs', async () => {});
      await alertService.onScraperComplete({ jobs_new: 0, jobs_updated: 0 });
      assert.equal(checkSpy.mock.calls.length, 0);
    });

    it('delegates to checkAndScoreNewJobs when new jobs exist (T-65)', async () => {
      const checkSpy = mock.method(alertService, 'checkAndScoreNewJobs', async () => {});
      await alertService.onScraperComplete({ jobs_new: 5, jobs_updated: 0 });
      assert.equal(checkSpy.mock.calls.length, 1);
    });

    it('delegates when updated jobs exist', async () => {
      const checkSpy = mock.method(alertService, 'checkAndScoreNewJobs', async () => {});
      await alertService.onScraperComplete({ jobs_new: 0, jobs_updated: 3 });
      assert.equal(checkSpy.mock.calls.length, 1);
    });

    it('handles null scraperResult', async () => {
      const checkSpy = mock.method(alertService, 'checkAndScoreNewJobs', async () => {});
      await alertService.onScraperComplete(null);
      assert.equal(checkSpy.mock.calls.length, 0);
    });
  });
});
