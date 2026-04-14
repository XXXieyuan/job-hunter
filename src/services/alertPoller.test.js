'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const usersRepo = require('../repositories/usersRepo');
const scraperRunsRepo = require('../repositories/scraperRunsRepo');
const alertService = require('./alertService');

const alertPoller = require('./alertPoller');

describe('alertPoller', () => {
  afterEach(() => {
    alertPoller.stop();
    alertPoller._setWatermark(null);
    mock.restoreAll();
  });

  // T-73: start() begins 60s polling loop
  describe('start()', () => {
    it('begins polling loop using self-correcting setTimeout (T-73)', () => {
      const origSetTimeout = global.setTimeout;
      let setTimeoutCalled = false;
      mock.method(global, 'setTimeout', (fn, delay) => {
        setTimeoutCalled = true;
        assert.ok(delay >= 0, 'delay should be non-negative');
        assert.ok(delay <= 60000, 'delay should be at most 60 seconds');
        return origSetTimeout(fn, delay);
      });

      alertPoller.start();
      assert.ok(setTimeoutCalled, 'setTimeout should have been called');
    });

    it('is idempotent — calling start() twice does not create two loops', () => {
      let callCount = 0;
      const origSetTimeout = global.setTimeout;
      mock.method(global, 'setTimeout', (fn, delay) => {
        callCount++;
        return origSetTimeout(fn, delay);
      });

      alertPoller.start();
      alertPoller.start();
      assert.equal(callCount, 1);
    });
  });

  // T-74: stop() clears the pending timeout
  describe('stop()', () => {
    it('clears the pending timeout (T-74)', () => {
      alertPoller.start();
      alertPoller.stop();
      // Verify stopped state by confirming start() can be called again
      alertPoller.start();
      alertPoller.stop();
    });
  });

  // T-75: Poller detects completed scraper run via watermark
  describe('tick()', () => {
    it('calls checkAndScoreNewJobs when new scraper run exists (T-75)', async () => {
      const pastTime = '2026-04-08T10:00:00Z';
      const newTime = '2026-04-09T10:00:00Z';
      alertPoller._setWatermark(pastTime);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 5, status: 'success', completed_at: newTime },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      assert.equal(alertService.checkAndScoreNewJobs.mock.calls.length, 1);
    });

    // T-76: Poller skips when no new scraper runs since last watermark
    it('skips when no new scraper runs since last watermark (T-76)', async () => {
      const watermark = '2026-04-09T12:00:00Z';
      alertPoller._setWatermark(watermark);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 3, status: 'success', completed_at: '2026-04-09T11:00:00Z' },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      assert.equal(alertService.checkAndScoreNewJobs.mock.calls.length, 0);
    });

    // T-77: Poller skips when no alert-enabled users exist
    it('skips when no users have alerts_enabled (T-77)', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => []);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 5, status: 'success', completed_at: '2026-04-09T10:00:00Z' },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      assert.equal(alertService.checkAndScoreNewJobs.mock.calls.length, 0);
    });

    it('skips when users exist but none have alerts_enabled=true (T-77 variant)', async () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: false }),
      }]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      assert.equal(alertService.checkAndScoreNewJobs.mock.calls.length, 0);
    });

    // T-78: Poller updates watermark after successful processing
    it('updates watermark after processing (T-78)', async () => {
      const pastTime = '2026-04-08T10:00:00Z';
      const newTime = '2026-04-09T14:00:00Z';
      alertPoller._setWatermark(pastTime);

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 5, status: 'success', completed_at: newTime },
        { id: 4, status: 'success', completed_at: '2026-04-09T12:00:00Z' },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      assert.equal(alertPoller._getWatermark(), newTime);
    });

    it('on first poll, sets watermark without processing historical runs', async () => {
      // Watermark is null (first poll)
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 5, status: 'success', completed_at: '2026-04-09T10:00:00Z' },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      await alertPoller.tick();

      // Should NOT call checkAndScoreNewJobs on first poll
      assert.equal(alertService.checkAndScoreNewJobs.mock.calls.length, 0);
      // But should set watermark
      assert.equal(alertPoller._getWatermark(), '2026-04-09T10:00:00Z');
    });

    it('handles alertService error gracefully without advancing watermark', async () => {
      alertPoller._setWatermark('2026-04-08T10:00:00Z');

      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);
      mock.method(scraperRunsRepo, 'getRecentRuns', () => [
        { id: 5, status: 'success', completed_at: '2026-04-09T10:00:00Z' },
      ]);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {
        throw new Error('Scoring engine down');
      });

      // Should not throw
      await alertPoller.tick();

      // Watermark should NOT advance on error — failed runs will be retried
      assert.equal(alertPoller._getWatermark(), '2026-04-08T10:00:00Z');
    });
  });

  describe('hasAlertEnabledUsers()', () => {
    it('returns true when at least one user has alerts enabled', () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: true }),
      }]);

      assert.equal(alertPoller.hasAlertEnabledUsers(), true);
    });

    it('returns false when no users have alerts enabled', () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => [{
        id: 1,
        notification_prefs_json: JSON.stringify({ alerts_enabled: false }),
      }]);

      assert.equal(alertPoller.hasAlertEnabledUsers(), false);
    });

    it('returns false when no users have prefs set', () => {
      mock.method(usersRepo, 'findWithNotificationPrefs', () => []);

      assert.equal(alertPoller.hasAlertEnabledUsers(), false);
    });
  });

  describe('self-correcting setTimeout', () => {
    it('calculates correct delay from tick start time', async () => {
      // Mock dependencies so tick() completes quickly with no work
      mock.method(usersRepo, 'findWithNotificationPrefs', () => []);
      mock.method(alertService, 'checkAndScoreNewJobs', async () => {});

      const tickStart = await alertPoller.tick();

      // tick() returns tickStart (Date.now() captured at start of tick)
      assert.ok(typeof tickStart === 'number', 'tick should return a numeric timestamp');
      assert.ok(tickStart <= Date.now(), 'tickStart should be <= now');
      assert.ok(tickStart >= Date.now() - 5000, 'tickStart should be recent');

      // msUntilNextPoll should return POLL_INTERVAL_MS minus elapsed
      // We don't export msUntilNextPoll, so verify via scheduleNext behavior:
      // The delay passed to setTimeout should be between 0 and 60000
      const origSetTimeout = global.setTimeout;
      let capturedDelay;
      mock.method(global, 'setTimeout', (fn, delay) => {
        capturedDelay = delay;
        return origSetTimeout(fn, delay);
      });

      alertPoller.start();
      assert.ok(capturedDelay >= 0, 'delay should be non-negative');
      assert.ok(capturedDelay <= 60000, 'delay should be at most 60s');
    });
  });
});
