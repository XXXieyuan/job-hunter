'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  _normalizeSourceFilter,
  _applySourceFilter,
  _extractIdentifierCandidates,
  _buildIdentifierMatchClause,
} = require('./jobsRepo');

describe('jobsRepo source filter helpers', () => {
  it('normalizes repeated query-string values into a flat array', () => {
    const result = _normalizeSourceFilter(['apsjobs', 'actgov', 'nswgov']);
    assert.deepEqual(result, ['apsjobs', 'actgov', 'nswgov']);
  });

  it('normalizes comma-separated source filters into a flat array', () => {
    const result = _normalizeSourceFilter('apsjobs, actgov, nswgov');
    assert.deepEqual(result, ['apsjobs', 'actgov', 'nswgov']);
  });

  it('builds an IN clause for multi-source filters', () => {
    const conditions = [];
    const params = {};

    _applySourceFilter(conditions, params, ['apsjobs', 'actgov']);

    assert.deepEqual(conditions, ['j.source IN (@source_0, @source_1)']);
    assert.deepEqual(params, { source_0: 'apsjobs', source_1: 'actgov' });
  });

  it('builds an equality clause for a single source filter', () => {
    const conditions = [];
    const params = {};

    _applySourceFilter(conditions, params, 'apsjobs');

    assert.deepEqual(conditions, ['j.source = @source']);
    assert.deepEqual(params, { source: 'apsjobs' });
  });
});

describe('jobsRepo identifier search helpers', () => {
  it('extracts APS vacancy references from raw search input', () => {
    const result = _extractIdentifierCandidates('VN-0768714');
    assert.deepEqual(result, ['VN-0768714']);
  });

  it('extracts the last path segment from an official APS job URL', () => {
    const result = _extractIdentifierCandidates('https://www.apsjobs.gov.au/s/job-details/VN-0768714');
    assert.ok(result.includes('https://www.apsjobs.gov.au/s/job-details/VN-0768714'));
    assert.ok(result.includes('VN-0768714'));
  });

  it('extracts the APS jobId from canonical APS detail URLs', () => {
    const result = _extractIdentifierCandidates(
      'https://www.apsjobs.gov.au/s/job-details?title=software-applications-programmer-sap-payroll&Id=a05OY00000NyLE3YAN',
    );
    assert.ok(result.includes('a05OY00000NyLE3YAN'));
    assert.ok(!result.includes('job-details'));
  });

  it('builds a URL/external_id fallback match clause', () => {
    const params = {};
    const clause = _buildIdentifierMatchClause(params, 'VN-0768714');

    assert.match(clause, /j\.external_id/);
    assert.match(clause, /j\.url/);
    assert.match(clause, /j\.raw_json/);
    assert.equal(params.identifier_0, 'VN-0768714');
    assert.equal(params.identifier_like_0, '%VN-0768714%');
  });
});
