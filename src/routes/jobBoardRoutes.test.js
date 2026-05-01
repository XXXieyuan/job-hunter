'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('jobBoardRoutes helpers', () => {
  it('builds section filters from the create-section form body', () => {
    const router = require('./jobBoardRoutes');

    const filters = router._buildSectionFiltersFromBody({
      keyword: ' AI engineer ',
      location: ' Canberra ',
      source: ['seek', 'apsjobs', 'unknown'],
      workType: 'full-time',
      visa: 'pr_required',
      minScore: '70',
      salaryMin: '120000',
      salaryMax: '',
      roles: 'software-engineer,ai-engineer',
      sort: 'score',
    });

    assert.deepEqual(filters, {
      keyword: 'AI engineer',
      location: 'Canberra',
      source: ['seek', 'apsjobs'],
      workType: 'full-time',
      visa: 'pr_required',
      minScore: 70,
      salaryMin: 120000,
      roles: ['software-engineer', 'ai-engineer'],
      sort: 'score',
    });
  });

  it('only redirects back to safe local pages after section mutations', () => {
    const router = require('./jobBoardRoutes');

    assert.equal(router._safeRedirect('/jobs?keyword=ICT'), '/jobs?keyword=ICT');
    assert.equal(router._safeRedirect('/job-board'), '/job-board');
    assert.equal(router._safeRedirect('https://evil.example/jobs'), '/job-board');
    assert.equal(router._safeRedirect('/admin'), '/job-board');
  });
});
