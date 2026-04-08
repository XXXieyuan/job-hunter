'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeForComparison,
  normalizeCompany,
  normalizeLocation,
  comparePair,
  pickCanonical,
} = require('./deduplicationService');

describe('deduplicationService — normalizeForComparison', () => {
  it('lowercases and strips punctuation', () => {
    assert.equal(normalizeForComparison('Data Analyst!'), 'data analyst');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeForComparison('  Senior   Data   Engineer  '), 'senior data engineer');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeForComparison(null), '');
    assert.equal(normalizeForComparison(undefined), '');
    assert.equal(normalizeForComparison(''), '');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(normalizeForComparison(123), '');
  });
});

describe('deduplicationService — normalizeCompany', () => {
  it('strips Pty Ltd variations', () => {
    const a = normalizeCompany('Acme Pty Ltd');
    const b = normalizeCompany('Acme Pty. Ltd.');
    assert.equal(a, b);
    assert.ok(a.includes('acme'));
  });

  it('strips Inc and Corporation', () => {
    assert.equal(normalizeCompany('BigCo Inc.'), normalizeCompany('BigCo Inc'));
    assert.equal(normalizeCompany('BigCo Corporation'), normalizeCompany('BigCo Corp'));
  });

  it('strips Limited and Group', () => {
    const a = normalizeCompany('Tech Limited');
    const b = normalizeCompany('Tech Group');
    // Both should just be 'tech'
    assert.equal(a, 'tech');
    assert.equal(b, 'tech');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeCompany(null), '');
    assert.equal(normalizeCompany(undefined), '');
  });
});

describe('deduplicationService — normalizeLocation', () => {
  it('lowercases and collapses whitespace', () => {
    assert.equal(normalizeLocation('  Sydney,  NSW  '), 'sydney nsw');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeLocation(null), '');
    assert.equal(normalizeLocation(undefined), '');
  });
});

describe('deduplicationService — comparePair', () => {
  it('detects duplicates with same title and company', () => {
    const jobA = { title: 'Data Analyst', company_name: 'Acme Pty Ltd', location: 'Sydney' };
    const jobB = { title: 'Data Analyst', company_name: 'Acme Pty. Ltd.', location: 'Sydney' };
    const result = comparePair(jobA, jobB);
    assert.equal(result.isDuplicate, true);
    assert.ok(result.confidence >= 0.8);
    assert.equal(result.method, 'title_company_location');
  });

  it('returns high confidence when location also matches', () => {
    const jobA = { title: 'Engineer', company_name: 'Atlassian', location: 'Melbourne' };
    const jobB = { title: 'Engineer', company_name: 'Atlassian', location: 'Melbourne' };
    const result = comparePair(jobA, jobB);
    assert.equal(result.isDuplicate, true);
    assert.equal(result.confidence, 0.95);
  });

  it('returns lower confidence when locations differ', () => {
    const jobA = { title: 'Engineer', company_name: 'Atlassian', location: 'Melbourne' };
    const jobB = { title: 'Engineer', company_name: 'Atlassian', location: 'Sydney' };
    const result = comparePair(jobA, jobB);
    assert.equal(result.isDuplicate, true);
    assert.equal(result.confidence, 0.80);
  });

  it('not duplicate if company differs', () => {
    const jobA = { title: 'Analyst', company_name: 'Acme', location: 'Sydney' };
    const jobB = { title: 'Analyst', company_name: 'Beta Corp', location: 'Sydney' };
    const result = comparePair(jobA, jobB);
    assert.equal(result.isDuplicate, false);
  });

  it('not duplicate if title differs', () => {
    const jobA = { title: 'Data Analyst', company_name: 'Acme', location: 'Sydney' };
    const jobB = { title: 'Data Engineer', company_name: 'Acme', location: 'Sydney' };
    const result = comparePair(jobA, jobB);
    assert.equal(result.isDuplicate, false);
  });
});

describe('deduplicationService — pickCanonical', () => {
  it('prefers job with more complete data', () => {
    const jobs = [
      { id: 1, title: 'Dev', description: null, url: null, salary: null, created_at: '2026-01-01' },
      { id: 2, title: 'Dev', description: 'Desc', url: 'http://x', salary: '100k', created_at: '2026-01-02' },
    ];
    const canonical = pickCanonical(jobs);
    assert.equal(canonical.id, 2);
  });

  it('prefers earlier created_at when data completeness is equal', () => {
    const jobs = [
      { id: 1, title: 'Dev', description: 'A', url: 'http://a', salary: null, created_at: '2026-01-01' },
      { id: 2, title: 'Dev', description: 'B', url: 'http://b', salary: null, created_at: '2026-01-02' },
    ];
    const canonical = pickCanonical(jobs);
    assert.equal(canonical.id, 1);
  });

  it('returns the single job when array has one element', () => {
    const jobs = [{ id: 5, title: 'Only', description: null, url: null, salary: null, created_at: '2026-01-01' }];
    assert.equal(pickCanonical(jobs).id, 5);
  });
});
