'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// T-133: Visa service extracts known patterns

const {
  extractVisaEligibility,
  extractSecurityClearance,
} = require('./visaService');

describe('Visa Service — extractVisaEligibility (T-133)', () => {
  it('detects "Australian citizen" → citizens_only', () => {
    const result = extractVisaEligibility('Must be an Australian citizen to apply.');
    assert.equal(result, 'citizens_only');
  });

  it('detects "Australian citizenship required" → citizens_only', () => {
    const result = extractVisaEligibility('Australian citizenship required.');
    assert.equal(result, 'citizens_only');
  });

  it('detects "citizens only" → citizens_only', () => {
    const result = extractVisaEligibility('Australian citizens only may apply for this role.');
    assert.equal(result, 'citizens_only');
  });

  it('detects "permanent resident required" → pr_required', () => {
    const result = extractVisaEligibility('Permanent residency required to apply for this position.');
    assert.equal(result, 'pr_required');
  });

  it('detects "visa holders welcome" → visa_holders_welcome', () => {
    const result = extractVisaEligibility('All visa types welcome to apply.');
    assert.equal(result, 'visa_holders_welcome');
  });

  it('detects "visa sponsorship available" → visa_holders_welcome', () => {
    const result = extractVisaEligibility('Visa sponsorship available for the right candidate.');
    assert.equal(result, 'visa_holders_welcome');
  });

  it('detects "right to work in australia" → visa_holders_welcome', () => {
    const result = extractVisaEligibility('Must have the right to work in Australia.');
    assert.equal(result, 'visa_holders_welcome');
  });

  it('returns null for no patterns', () => {
    const result = extractVisaEligibility('Looking for a data analyst with SQL skills.');
    assert.equal(result, null);
  });

  it('returns null for null/empty input', () => {
    assert.equal(extractVisaEligibility(null), null);
    assert.equal(extractVisaEligibility(''), null);
    assert.equal(extractVisaEligibility(undefined), null);
  });

  it('prioritises citizens_only over pr_required when both present', () => {
    const text = 'Must be an Australian citizen. Permanent residents need not apply.';
    assert.equal(extractVisaEligibility(text), 'citizens_only');
  });
});

describe('Visa Service — extractSecurityClearance', () => {
  it('detects baseline clearance', () => {
    assert.equal(
      extractSecurityClearance('Requires a baseline security clearance.'),
      'baseline'
    );
  });

  it('detects NV1 clearance', () => {
    assert.equal(
      extractSecurityClearance('NV1 clearance required.'),
      'negative_vetting_1'
    );
  });

  it('detects NV2 clearance', () => {
    assert.equal(
      extractSecurityClearance('Must hold negative vetting level 2 clearance.'),
      'negative_vetting_2'
    );
  });

  it('detects positive vetting', () => {
    assert.equal(
      extractSecurityClearance('Positive vetting clearance is mandatory.'),
      'positive_vetting'
    );
  });

  it('returns null for no clearance patterns', () => {
    assert.equal(
      extractSecurityClearance('Looking for a data analyst.'),
      null
    );
  });

  it('returns null for null/empty input', () => {
    assert.equal(extractSecurityClearance(null), null);
    assert.equal(extractSecurityClearance(''), null);
  });

  it('prioritises higher clearance levels', () => {
    // NV2 should be detected over baseline
    const text = 'Requires baseline clearance or higher. NV2 preferred.';
    const result = extractSecurityClearance(text);
    assert.ok(
      result === 'negative_vetting_2' || result === 'baseline',
      'Should detect at least baseline'
    );
  });
});
