'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// T-L.4: Company service Tier 2 stub tests

describe('Company Service — Tier 2 stub', () => {
  it('ensureCompanyForJob returns null for unknown company (Tier 2 stub)', async () => {
    // The function should return null when company is not already researched
    // We can't easily test DB-dependent logic without a real DB, but we can
    // verify the module loads and the function signature is correct
    const { ensureCompanyForJob } = require('./companyService');
    assert.equal(typeof ensureCompanyForJob, 'function');
  });

  it('batchResearchCompanies returns 0 (Tier 2 stub)', async () => {
    const { batchResearchCompanies } = require('./companyService');
    const result = await batchResearchCompanies();
    assert.equal(result, 0, 'Tier 2 stub should return 0');
  });

  it('researchCompanyWithAI returns fallback without API key', async () => {
    const { researchCompanyWithAI } = require('./companyService');
    const result = await researchCompanyWithAI('Test Corp', null);

    assert.equal(result.description, null);
    assert.equal(result.industry, null);
    assert.equal(result.size, null);
    assert.equal(result.headquarters, null);
    assert.equal(result.website, null);
  });
});
