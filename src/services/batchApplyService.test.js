'use strict';

const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const {
  executeBatch,
  recoverStaleSessions,
  requestCancel,
  requestSkip,
  isExecuting,
  getJobDelay,
} = require('./batchApplyService');

// ─── Mock helpers ──────────────────────────────────────────────

function createMockRepo() {
  return {
    getSessionJobs: mock.fn(() => []),
    updateJobStatus: mock.fn(() => 1),
    incrementSessionCounter: mock.fn(() => 1),
    updateSessionStatus: mock.fn(() => 1),
    recoverStaleSessions: mock.fn(() => 0),
  };
}

function createMockAppRepo() {
  return {
    createIdempotent: mock.fn(() => ({ id: 1, created: true })),
    updateStatus: mock.fn(() => 1),
  };
}

function makeJob(id, jobId, opts = {}) {
  return {
    id,
    job_id: jobId,
    session_id: 1,
    user_id: 1,
    resume_id: 1,
    cover_letter_id: 1,
    status: 'pending',
    title: opts.title || `Job ${jobId}`,
    company_name: opts.company_name || `Company ${jobId}`,
    url: opts.url || `https://www.seek.com.au/job/${jobId}`,
    ...opts,
  };
}

function createMockPage(opts = {}) {
  const page = {
    goto: mock.fn(async () => {}),
    getByLabel: mock.fn(() => ({
      click: mock.fn(async () => {}),
    })),
    locator: mock.fn((selector) => ({
      count: mock.fn(async () => (opts.hasApply !== false ? 1 : 0)),
      first: mock.fn(() => ({
        click: mock.fn(async () => {}),
      })),
    })),
    waitForNavigation: mock.fn(async () => {
      // Simulate immediate submit by default
    }),
    evaluate: mock.fn(async () => false),
  };
  return page;
}

function createMockBrowser(page) {
  const context = {
    route: mock.fn(async () => {}),
    newPage: mock.fn(async () => page),
  };
  return {
    newContext: mock.fn(async () => context),
    close: mock.fn(async () => {}),
  };
}

/**
 * Create a mock seekFormFiller that always succeeds.
 */
const seekFormFiller = require('./seekFormFiller');

function mockFillFormSuccess() {
  return mock.method(seekFormFiller, 'fillForm', async () => ({
    filledFields: ['firstName', 'lastName', 'email', 'phone', 'resume'],
    warnings: [],
    success: true,
  }));
}

function mockFillFormFailure(errorMsg) {
  return mock.method(seekFormFiller, 'fillForm', async () => ({
    filledFields: ['firstName'],
    warnings: [errorMsg || 'Form fill failed'],
    success: false,
  }));
}

function defaultDeps(overrides = {}) {
  const page = createMockPage(overrides.pageOpts);
  const browser = createMockBrowser(page);
  const repo = createMockRepo();
  const appRepo = createMockAppRepo();

  return {
    repo,
    appRepo,
    profile: {
      full_name: 'Wei Zhang',
      email: 'wei@example.com',
      phone: '0412345678',
      visa_status: 'Permanent Resident',
      work_rights: 'Unrestricted',
    },
    resumePath: '/path/to/resume.docx',
    getCoverLetterText: mock.fn(async () => 'Dear Hiring Manager...'),
    launchBrowser: mock.fn(async () => browser),
    _page: page,
    _browser: browser,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe('recoverStaleSessions', () => {
  it('calls repo.recoverStaleSessions(30) and returns count', () => {
    const repo = createMockRepo();
    repo.recoverStaleSessions = mock.fn(() => 3);

    const result = recoverStaleSessions({ repo });

    assert.equal(result, 3);
    assert.equal(repo.recoverStaleSessions.mock.calls.length, 1);
    assert.equal(repo.recoverStaleSessions.mock.calls[0].arguments[0], 30);
  });

  it('returns 0 when no stale sessions', () => {
    const repo = createMockRepo();
    repo.recoverStaleSessions = mock.fn(() => 0);

    const result = recoverStaleSessions({ repo });
    assert.equal(result, 0);
  });
});

describe('getJobDelay', () => {
  afterEach(() => {
    delete process.env.BATCH_APPLY_DELAY_MS;
  });

  it('returns configured delay from BATCH_APPLY_DELAY_MS env var', () => {
    process.env.BATCH_APPLY_DELAY_MS = '100';
    assert.equal(getJobDelay(), 100);
  });

  it('returns random delay in range when env var not set', () => {
    delete process.env.BATCH_APPLY_DELAY_MS;
    const delay = getJobDelay();
    assert.ok(delay >= 30000 && delay <= 60000, `delay ${delay} out of range`);
  });

  it('returns 0 when BATCH_APPLY_DELAY_MS is "0"', () => {
    process.env.BATCH_APPLY_DELAY_MS = '0';
    assert.equal(getJobDelay(), 0);
  });
});

describe('executeBatch', () => {
  let fillMock;

  beforeEach(() => {
    process.env.BATCH_APPLY_DELAY_MS = '0'; // no delay in tests
    fillMock = mockFillFormSuccess();
  });

  afterEach(() => {
    delete process.env.BATCH_APPLY_DELAY_MS;
    mock.restoreAll();
  });

  it('happy path: 3 jobs all apply successfully', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    const jobs = [
      makeJob(1, 101),
      makeJob(2, 102),
      makeJob(3, 103),
    ];

    const deps = defaultDeps();
    deps.jobs = jobs;

    await executeBatch(1, emitter, deps);

    // Check SSE events
    const jobStartEvents = events.filter(e => e.event === 'job-start');
    const awaitingEvents = events.filter(e => e.event === 'awaiting-submit');
    const appliedEvents = events.filter(e => e.event === 'applied');
    const batchComplete = events.find(e => e.event === 'batch-complete');

    assert.equal(jobStartEvents.length, 3);
    assert.equal(awaitingEvents.length, 3);
    assert.equal(appliedEvents.length, 3);
    assert.ok(batchComplete);
    assert.equal(batchComplete.data.summary.applied, 3);
    assert.equal(batchComplete.data.summary.failed, 0);
    assert.equal(batchComplete.data.summary.skipped, 0);

    // Session marked as completed
    const statusCalls = deps.repo.updateSessionStatus.mock.calls;
    const completedCall = statusCalls.find(c => c.arguments[1] === 'completed');
    assert.ok(completedCall);

    // Browser closed
    assert.equal(deps._browser.close.mock.calls.length, 1);
  });

  it('per-job failure isolation: job 2 fails, job 3 still processes', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    // Make fillForm fail on second call
    mock.restoreAll();
    let callCount = 0;
    mock.method(seekFormFiller, 'fillForm', async () => {
      callCount++;
      if (callCount === 2) {
        return { filledFields: [], warnings: ['Form fill failed'], success: false };
      }
      return { filledFields: ['firstName', 'email', 'resume'], warnings: [], success: true };
    });

    const jobs = [
      makeJob(1, 101),
      makeJob(2, 102),
      makeJob(3, 103),
    ];

    const deps = defaultDeps();
    deps.jobs = jobs;

    await executeBatch(2, emitter, deps);

    const appliedEvents = events.filter(e => e.event === 'applied');
    const failedEvents = events.filter(e => e.event === 'failed');
    const batchComplete = events.find(e => e.event === 'batch-complete');

    assert.equal(appliedEvents.length, 2, 'should have 2 applied');
    assert.equal(failedEvents.length, 1, 'should have 1 failed');
    assert.ok(batchComplete);
    assert.equal(batchComplete.data.summary.applied, 2);
    assert.equal(batchComplete.data.summary.failed, 1);
  });

  it('skip signal: set skip flag for job 2, verify skipped event', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    // Mock fillForm to detect awaiting-submit, then set skip signal
    mock.restoreAll();
    let callIdx = 0;
    mock.method(seekFormFiller, 'fillForm', async () => {
      callIdx++;
      if (callIdx === 2) {
        // Set skip signal for job id=2 in session 3
        requestSkip(3, 2);
      }
      return { filledFields: ['firstName', 'email', 'resume'], warnings: [], success: true };
    });

    const jobs = [
      makeJob(1, 101),
      makeJob(2, 102),
      makeJob(3, 103),
    ];

    const deps = defaultDeps();
    deps.jobs = jobs;

    // Override page.waitForNavigation to give time for skip check
    const page = deps._page;
    page.waitForNavigation = mock.fn(async () => {
      // Slow navigation - allow skip poll to catch the signal
      await new Promise(r => setTimeout(r, 1500));
    });

    await executeBatch(3, emitter, deps);

    const skippedEvents = events.filter(e => e.event === 'skipped');
    assert.ok(skippedEvents.length >= 1, 'should have at least 1 skipped event');

    const batchComplete = events.find(e => e.event === 'batch-complete');
    assert.ok(batchComplete);
  });

  it('cancel signal: cancel after job 1, remaining jobs marked skipped', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    // Set cancel after first job processes
    mock.restoreAll();
    let callIdx = 0;
    mock.method(seekFormFiller, 'fillForm', async () => {
      callIdx++;
      if (callIdx === 1) {
        // Cancel after first job
        requestCancel(4);
      }
      return { filledFields: ['firstName', 'email', 'resume'], warnings: [], success: true };
    });

    const jobs = [
      makeJob(1, 101),
      makeJob(2, 102),
      makeJob(3, 103),
    ];

    const deps = defaultDeps();
    deps.jobs = jobs;

    await executeBatch(4, emitter, deps);

    const cancelledEvent = events.find(e => e.event === 'batch-cancelled');
    assert.ok(cancelledEvent, 'should emit batch-cancelled');
    assert.deepStrictEqual(cancelledEvent.data, {});

    // Session marked as cancelled
    const statusCalls = deps.repo.updateSessionStatus.mock.calls;
    const cancelledCall = statusCalls.find(c => c.arguments[1] === 'cancelled');
    assert.ok(cancelledCall);
  });

  it('execution guard prevents duplicate Playwright launches', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    const jobs = [makeJob(1, 101)];
    const deps = defaultDeps();
    deps.jobs = jobs;

    // Start first execution (it will complete)
    const firstExec = executeBatch(5, emitter, deps);

    // Try second execution with same sessionId immediately
    const emitter2 = new EventEmitter();
    const events2 = [];
    emitter2.on('sse', (e) => events2.push(e));
    const secondExec = executeBatch(5, emitter2, deps);

    await Promise.all([firstExec, secondExec]);

    // Second call should return without launching browser
    // launchBrowser should only be called once
    assert.equal(deps.launchBrowser.mock.calls.length, 1);
  });

  it('Playwright binary missing: emits error event with setup instructions', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    const repo = createMockRepo();
    const deps = {
      repo,
      appRepo: createMockAppRepo(),
      launchBrowser: mock.fn(async () => {
        throw new Error("Executable doesn't exist at /path/chromium");
      }),
      jobs: [makeJob(1, 101)],
      profile: {},
      resumePath: '',
    };

    await executeBatch(6, emitter, deps);

    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, 'should emit error event');
    assert.ok(errorEvent.data.message.includes('npx playwright install chromium'));

    // Session marked cancelled
    const statusCalls = repo.updateSessionStatus.mock.calls;
    const cancelledCall = statusCalls.find(c => c.arguments[1] === 'cancelled');
    assert.ok(cancelledCall);
  });

  it('pre-flight failure: unrecognised form aborts batch', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    const page = createMockPage({ hasApply: false });
    // locator().count() returns 0
    page.locator = mock.fn(() => ({
      count: mock.fn(async () => 0),
      first: mock.fn(() => ({ click: mock.fn(async () => {}) })),
    }));

    const browser = createMockBrowser(page);
    const repo = createMockRepo();

    const deps = {
      repo,
      appRepo: createMockAppRepo(),
      launchBrowser: mock.fn(async () => browser),
      jobs: [makeJob(1, 101)],
      profile: {},
      resumePath: '',
    };

    await executeBatch(7, emitter, deps);

    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, 'should emit error event for unrecognised form');
    assert.ok(errorEvent.data.message.includes('not recognized'));

    // Session cancelled
    const cancelledCall = repo.updateSessionStatus.mock.calls.find(c => c.arguments[1] === 'cancelled');
    assert.ok(cancelledCall);
  });

  it('session status transitions: pending → in-progress → completed', async () => {
    const emitter = new EventEmitter();
    const jobs = [makeJob(1, 101)];
    const deps = defaultDeps();
    deps.jobs = jobs;

    await executeBatch(8, emitter, deps);

    const statusCalls = deps.repo.updateSessionStatus.mock.calls;
    assert.equal(statusCalls[0].arguments[1], 'in-progress');
    const completedCall = statusCalls.find(c => c.arguments[1] === 'completed');
    assert.ok(completedCall);
  });

  it('application tracker updated on successful submit', async () => {
    const emitter = new EventEmitter();
    const jobs = [makeJob(1, 101)];
    const deps = defaultDeps();
    deps.jobs = jobs;

    await executeBatch(9, emitter, deps);

    assert.equal(deps.appRepo.createIdempotent.mock.calls.length, 1);
    const call = deps.appRepo.createIdempotent.mock.calls[0].arguments[0];
    assert.equal(call.job_id, 101);
    assert.equal(call.status, 'applied');
  });

  it('empty job list completes immediately with zero counts', async () => {
    const emitter = new EventEmitter();
    const events = [];
    emitter.on('sse', (e) => events.push(e));

    const deps = defaultDeps();
    deps.jobs = [];

    await executeBatch(10, emitter, deps);

    const batchComplete = events.find(e => e.event === 'batch-complete');
    assert.ok(batchComplete);
    assert.equal(batchComplete.data.summary.applied, 0);
    assert.equal(batchComplete.data.summary.failed, 0);
    assert.equal(batchComplete.data.summary.skipped, 0);
  });

  it('isExecuting returns false after batch completes', async () => {
    const emitter = new EventEmitter();
    const deps = defaultDeps();
    deps.jobs = [makeJob(1, 101)];

    await executeBatch(11, emitter, deps);

    assert.equal(isExecuting(11), false);
  });
});
