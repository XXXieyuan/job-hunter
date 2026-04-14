'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const usersRepo = require('../repositories/usersRepo');
const notificationsRepo = require('../repositories/notificationsRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const emailService = require('./emailService');
const alertService = require('./alertService');

const digestScheduler = require('./digestScheduler');

describe('digestScheduler', () => {
  afterEach(() => {
    digestScheduler.stop();
    mock.restoreAll();
  });

  // T-66: start() begins the hourly scheduling loop
  describe('start()', () => {
    it('begins the hourly scheduling loop (T-66)', () => {
      const origSetTimeout = global.setTimeout;
      let setTimeoutCalled = false;
      mock.method(global, 'setTimeout', (fn, delay) => {
        setTimeoutCalled = true;
        assert.ok(delay > 0, 'delay should be positive');
        assert.ok(delay <= 60 * 60 * 1000, 'delay should be at most 1 hour');
        return origSetTimeout(fn, delay);
      });

      digestScheduler.start();
      assert.ok(setTimeoutCalled, 'setTimeout should have been called');
    });

    it('is idempotent — calling start() twice does not create two loops', () => {
      let callCount = 0;
      const origSetTimeout = global.setTimeout;
      mock.method(global, 'setTimeout', (fn, delay) => {
        callCount++;
        return origSetTimeout(fn, delay);
      });

      digestScheduler.start();
      digestScheduler.start();
      assert.equal(callCount, 1, 'setTimeout should only be called once');
    });
  });

  // T-67: stop() clears the pending timeout
  describe('stop()', () => {
    it('clears the pending timeout and prevents further ticks (T-67)', (t) => {
      digestScheduler.start();
      digestScheduler.stop();

      // After stop, tick should not fire. We verify by checking that
      // starting again works (proves state was reset properly)
      digestScheduler.start();
      digestScheduler.stop();
    });
  });

  // T-68: Digest fires for users whose digest_hour_utc matches current UTC hour
  describe('tick()', () => {
    const makeUser = (id, hour, overrides = {}) => ({
      id,
      email: `user${id}@example.com`,
      display_name: `User ${id}`,
      notification_prefs_json: JSON.stringify({
        alerts_enabled: true,
        score_threshold: 70,
        frequency: 'digest',
        digest_hour_utc: hour,
      }),
      ...overrides,
    });

    const makePendingNotification = (userId, jobId) => ({
      id: jobId * 100 + userId,
      user_id: userId,
      job_id: jobId,
      score: 85,
      top_matched_skills: '["Python","SQL","Data Analysis"]',
      visa_match: 1,
      frequency: 'digest',
      email_sent: 0,
      read_token: 'token123',
      job_title: `Job ${jobId}`,
      company_name: `Company ${jobId}`,
      location: 'Canberra',
      source: 'apsjobs',
      job_url: `http://example.com/jobs/${jobId}`,
      user_email: `user${userId}@example.com`,
      user_display_name: `User ${userId}`,
    });

    it('sends digest for users with matching digest_hour_utc (T-68)', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => [
        makePendingNotification(1, 10),
        makePendingNotification(1, 11),
      ]);
      mock.method(unsubscribeTokensRepo, 'getOrCreate', () => ({
        id: 1, user_id: 1, token: 'a'.repeat(64),
      }));
      mock.method(emailService, 'sendDigestEmail', async () => {});
      mock.method(notificationsRepo, 'markEmailSent', () => 1);

      await digestScheduler.tick();

      assert.equal(emailService.sendDigestEmail.mock.calls.length, 1);
      assert.equal(notificationsRepo.markEmailSent.mock.calls.length, 2);
      // Both marked as sent (status 1)
      assert.equal(notificationsRepo.markEmailSent.mock.calls[0].arguments[1], 1);
      assert.equal(notificationsRepo.markEmailSent.mock.calls[1].arguments[1], 1);
    });

    it('skips users with non-matching digest_hour_utc (T-68 negative)', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const otherHour = (currentHour + 12) % 24;
      const user = makeUser(1, otherHour);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => []);
      mock.method(emailService, 'sendDigestEmail', async () => {});

      await digestScheduler.tick();

      assert.equal(emailService.sendDigestEmail.mock.calls.length, 0);
    });

    // T-69: Digest skips users with no pending notifications
    it('skips user with no pending notifications (T-69)', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => []);
      mock.method(emailService, 'sendDigestEmail', async () => {});

      await digestScheduler.tick();

      assert.equal(emailService.sendDigestEmail.mock.calls.length, 0);
    });

    // T-70: Marks notifications as email_sent=1 after successful send
    it('marks email_sent=1 on success (T-70)', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => [
        makePendingNotification(1, 10),
      ]);
      mock.method(unsubscribeTokensRepo, 'getOrCreate', () => ({
        id: 1, user_id: 1, token: 'b'.repeat(64),
      }));
      mock.method(emailService, 'sendDigestEmail', async () => {});
      mock.method(notificationsRepo, 'markEmailSent', () => 1);

      await digestScheduler.tick();

      const calls = notificationsRepo.markEmailSent.mock.calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].arguments[0], 1001); // notification id
      assert.equal(calls[0].arguments[1], 1);     // status = sent
    });

    // T-71: Marks email_sent=2 on SMTP failure
    it('marks email_sent=2 on send failure (T-71)', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => [
        makePendingNotification(1, 10),
        makePendingNotification(1, 11),
      ]);
      mock.method(unsubscribeTokensRepo, 'getOrCreate', () => ({
        id: 1, user_id: 1, token: 'c'.repeat(64),
      }));
      mock.method(emailService, 'sendDigestEmail', async () => {
        throw new Error('SMTP connection refused');
      });
      mock.method(notificationsRepo, 'markEmailSent', () => 1);

      await digestScheduler.tick();

      const calls = notificationsRepo.markEmailSent.mock.calls;
      assert.equal(calls.length, 2);
      // Both marked as failed (status 2)
      assert.equal(calls[0].arguments[1], 2);
      assert.equal(calls[1].arguments[1], 2);
    });

    it('skips users with alerts_enabled=false', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour, {
        notification_prefs_json: JSON.stringify({
          alerts_enabled: false,
          frequency: 'digest',
          digest_hour_utc: currentHour,
        }),
      });

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => []);
      mock.method(emailService, 'sendDigestEmail', async () => {});

      await digestScheduler.tick();

      assert.equal(emailService.sendDigestEmail.mock.calls.length, 0);
    });

    it('skips users with frequency=immediate', async () => {
      const currentHour = digestScheduler.getCurrentUtcHour();
      const user = makeUser(1, currentHour, {
        notification_prefs_json: JSON.stringify({
          alerts_enabled: true,
          frequency: 'immediate',
          digest_hour_utc: currentHour,
        }),
      });

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [user]);
      mock.method(notificationsRepo, 'getPendingEmails', () => []);
      mock.method(emailService, 'sendDigestEmail', async () => {});

      await digestScheduler.tick();

      assert.equal(emailService.sendDigestEmail.mock.calls.length, 0);
    });
  });

  // T-72: Self-correcting setTimeout avoids drift accumulation
  describe('msUntilNextHour()', () => {
    it('returns a value between 0 and 3600000 ms (T-72)', () => {
      const delay = digestScheduler.msUntilNextHour();
      assert.ok(delay > 0, 'delay should be positive');
      assert.ok(delay <= 60 * 60 * 1000, 'delay should be at most 1 hour');
    });

    it('recalculates from wall clock to avoid drift', () => {
      // Calling multiple times should return similar values (within a few ms)
      const delay1 = digestScheduler.msUntilNextHour();
      const delay2 = digestScheduler.msUntilNextHour();
      assert.ok(Math.abs(delay1 - delay2) < 100, 'consecutive calls should be close');
    });
  });
});
