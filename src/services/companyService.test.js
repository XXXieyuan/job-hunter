'use strict';

const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const companiesRepo = require('../repositories/companiesRepo');
const openAIClient = require('./openAIClient');

const { extractJSON, validateWebsiteUrl, researchCompanyWithAI, ensureCompanyForJob, batchResearchCompanies } = require('./companyService');

// T-B.1: Harden researchCompanyWithAI prompt and JSON extraction

describe('extractJSON', () => {
  it('parses clean JSON', () => {
    const input = '{"description":"A tech company.","industry":"Technology","size":"1000+","headquarters":"Sydney, Australia","website":"https://example.com"}';
    const result = extractJSON(input);
    assert.equal(result.description, 'A tech company.');
    assert.equal(result.industry, 'Technology');
    assert.equal(result.size, '1000+');
    assert.equal(result.headquarters, 'Sydney, Australia');
    assert.equal(result.website, 'https://example.com');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"description":"Cloud provider.","industry":"Technology","size":"10000+","headquarters":"Seattle, USA","website":"https://cloud.example.com"}\n```';
    const result = extractJSON(input);
    assert.equal(result.description, 'Cloud provider.');
    assert.equal(result.industry, 'Technology');
    assert.equal(result.size, '10000+');
    assert.equal(result.headquarters, 'Seattle, USA');
    assert.equal(result.website, 'https://cloud.example.com');
  });

  it('parses JSON wrapped in plain markdown fences (no json tag)', () => {
    const input = '```\n{"description":"A bank.","industry":"Finance","size":"5000+","headquarters":"London, UK","website":null}\n```';
    const result = extractJSON(input);
    assert.equal(result.description, 'A bank.');
    assert.equal(result.industry, 'Finance');
  });

  it('parses JSON with leading text', () => {
    const input = 'Here is the company information:\n{"description":"Retail chain.","industry":"Retail","size":"500-1000","headquarters":"Melbourne, Australia","website":"https://retail.example.com"}';
    const result = extractJSON(input);
    assert.equal(result.description, 'Retail chain.');
    assert.equal(result.industry, 'Retail');
    assert.equal(result.headquarters, 'Melbourne, Australia');
  });

  it('parses JSON with trailing text', () => {
    const input = '{"description":"Consulting firm.","industry":"Consulting","size":"50-200","headquarters":"Canberra, Australia","website":null}\n\nLet me know if you need more details.';
    const result = extractJSON(input);
    assert.equal(result.description, 'Consulting firm.');
    assert.equal(result.industry, 'Consulting');
  });

  it('parses JSON with both leading and trailing text', () => {
    const input = 'Based on my research:\n{"description":"A gov agency.","industry":"Government","size":"1000-5000","headquarters":"Canberra, Australia","website":"https://gov.example.au"}\nHope this helps!';
    const result = extractJSON(input);
    assert.equal(result.description, 'A gov agency.');
    assert.equal(result.industry, 'Government');
    assert.equal(result.headquarters, 'Canberra, Australia');
  });

  it('returns null for complete gibberish', () => {
    const result = extractJSON('I cannot find any information about this company. Sorry!');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    assert.equal(extractJSON(''), null);
  });

  it('returns null for null input', () => {
    assert.equal(extractJSON(null), null);
  });

  it('all 5 fields present in a successful parse', () => {
    const input = '{"description":"Tech co.","industry":"Technology","size":"100-500","headquarters":"SF, USA","website":"https://techco.com"}';
    const result = extractJSON(input);
    assert.ok('description' in result);
    assert.ok('industry' in result);
    assert.ok('size' in result);
    assert.ok('headquarters' in result);
    assert.ok('website' in result);
  });
});

describe('validateWebsiteUrl', () => {
  it('accepts https:// URLs', () => {
    assert.equal(validateWebsiteUrl('https://example.com'), 'https://example.com');
  });

  it('accepts http:// URLs', () => {
    assert.equal(validateWebsiteUrl('http://example.com'), 'http://example.com');
  });

  it('accepts HTTPS:// (case-insensitive)', () => {
    assert.equal(validateWebsiteUrl('HTTPS://Example.Com'), 'HTTPS://Example.Com');
  });

  it('rejects javascript: URLs', () => {
    assert.equal(validateWebsiteUrl('javascript:alert(1)'), null);
  });

  it('rejects data: URLs', () => {
    assert.equal(validateWebsiteUrl('data:text/html,<h1>hi</h1>'), null);
  });

  it('rejects ftp: URLs', () => {
    assert.equal(validateWebsiteUrl('ftp://files.example.com'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(validateWebsiteUrl(''), null);
  });

  it('returns null for null', () => {
    assert.equal(validateWebsiteUrl(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(validateWebsiteUrl(undefined), null);
  });

  it('returns null for non-string values', () => {
    assert.equal(validateWebsiteUrl(42), null);
  });

  it('trims whitespace from valid URLs', () => {
    assert.equal(validateWebsiteUrl('  https://example.com  '), 'https://example.com');
  });
});

describe('researchCompanyWithAI — integration with extractJSON and validateWebsiteUrl', () => {
  it('returns an object with all 5 expected fields', async () => {
    // With a real API key, the function makes an actual call.
    // Without one, it returns the fallback. Either way, all 5 fields must be present.
    const result = await researchCompanyWithAI('Test Corp', null);
    assert.ok('description' in result, 'must have description');
    assert.ok('industry' in result, 'must have industry');
    assert.ok('size' in result, 'must have size');
    assert.ok('headquarters' in result, 'must have headquarters');
    assert.ok('website' in result, 'must have website');
    // website must be null or a valid http(s) URL
    if (result.website !== null) {
      assert.ok(/^https?:\/\//i.test(result.website), 'website must be http(s) URL or null');
    }
  });
});

// ──────────────────────────────────────────────────────────────
// T-C.1: ensureCompanyForJob — cache hit, cache miss, forceResearch, fallback
// ──────────────────────────────────────────────────────────────

describe('ensureCompanyForJob', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns null immediately for null company_name', async () => {
    const result = await ensureCompanyForJob({ company_name: null });
    assert.equal(result, null);
  });

  it('returns null immediately for empty company_name', async () => {
    const result = await ensureCompanyForJob({ company_name: '' });
    assert.equal(result, null);
  });

  it('cache HIT: returns existing company with description, no AI call', async () => {
    const cached = { id: 1, name: 'Acme Corp', description: 'A tech company.', industry: 'Technology' };
    mock.method(companiesRepo, 'getCompanyByName', () => cached);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () => { throw new Error('should not be called'); });

    const result = await ensureCompanyForJob({ company_name: 'Acme Corp' });
    assert.deepEqual(result, cached);
    assert.equal(companiesRepo.getCompanyByName.mock.calls.length, 1);
  });

  it('cache MISS + forceResearch=false: returns null without AI call', async () => {
    mock.method(companiesRepo, 'getCompanyByName', () => null);

    const result = await ensureCompanyForJob({ company_name: 'Unknown Corp' });
    assert.equal(result, null);
  });

  it('cache MISS + forceResearch=false with existing but unresearched: returns null', async () => {
    mock.method(companiesRepo, 'getCompanyByName', () => ({ id: 1, name: 'X Corp', description: null }));

    const result = await ensureCompanyForJob({ company_name: 'X Corp' });
    assert.equal(result, null);
  });

  it('cache MISS + forceResearch=true: AI called, result upserted with researched_at', async () => {
    const aiResult = { description: 'Tech firm.', industry: 'Technology', size: '100-500', headquarters: 'Sydney, AU', website: null };
    const upserted = { id: 5, name: 'NewCo', ...aiResult, researched_at: '2026-01-01' };

    let getCallCount = 0;
    mock.method(companiesRepo, 'getCompanyByName', () => {
      getCallCount++;
      // First call: cache miss, second call: after upsert
      return getCallCount === 1 ? null : upserted;
    });
    mock.method(companiesRepo, 'upsertCompany', () => 5);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () =>
      JSON.stringify(aiResult)
    );

    const result = await ensureCompanyForJob({ company_name: 'NewCo' }, { forceResearch: true });
    assert.deepEqual(result, upserted);
    assert.equal(companiesRepo.upsertCompany.mock.calls.length, 1);

    // Verify upsert was called with raw_json
    const upsertArg = companiesRepo.upsertCompany.mock.calls[0].arguments[0];
    assert.equal(upsertArg.name, 'NewCo');
    assert.ok(upsertArg.raw_json, 'must include raw_json');
  });

  it('complete AI failure (all nulls): no DB write, returns null', async () => {
    mock.method(companiesRepo, 'getCompanyByName', () => null);
    mock.method(companiesRepo, 'upsertCompany', () => { throw new Error('should not be called'); });
    mock.method(openAIClient, 'hasOpenAIKey', () => false); // triggers all-null fallback

    const result = await ensureCompanyForJob({ company_name: 'Ghost Inc' }, { forceResearch: true });
    assert.equal(result, null);
  });

  it('partial AI success: upsert writes populated fields', async () => {
    const partialResult = { description: 'Partial info.', industry: null, size: null, headquarters: null, website: null };
    const upserted = { id: 6, name: 'Partial Co', description: 'Partial info.', researched_at: '2026-01-01' };

    let getCallCount = 0;
    mock.method(companiesRepo, 'getCompanyByName', () => {
      getCallCount++;
      return getCallCount === 1 ? null : upserted;
    });
    mock.method(companiesRepo, 'upsertCompany', () => 6);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () =>
      JSON.stringify(partialResult)
    );

    const result = await ensureCompanyForJob({ company_name: 'Partial Co' }, { forceResearch: true });
    assert.equal(result.description, 'Partial info.');
    assert.equal(companiesRepo.upsertCompany.mock.calls.length, 1);
  });

  it('AI exception: catches error, returns null', async () => {
    mock.method(companiesRepo, 'getCompanyByName', () => null);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () => { throw new Error('API timeout'); });

    const result = await ensureCompanyForJob({ company_name: 'Error Co' }, { forceResearch: true });
    assert.equal(result, null);
  });
});

// ──────────────────────────────────────────────────────────────
// T-D.1: batchResearchCompanies — chunked execution, progress, failures
// ──────────────────────────────────────────────────────────────

describe('batchResearchCompanies', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('empty candidate list returns 0', async () => {
    mock.method(companiesRepo, 'getAll', () => []);

    const result = await batchResearchCompanies();
    assert.equal(result, 0);
  });

  it('skips already-researched companies', async () => {
    mock.method(companiesRepo, 'getAll', () => [
      { id: 1, name: 'Done Corp', description: 'Already researched.' },
      { id: 2, name: 'Also Done', description: 'Has info.' },
    ]);

    const result = await batchResearchCompanies();
    assert.equal(result, 0);
  });

  it('processes 3 unresearched companies, returns count', async () => {
    mock.method(companiesRepo, 'getAll', () => [
      { id: 1, name: 'A', description: null },
      { id: 2, name: 'B', description: null },
      { id: 3, name: 'C', description: null },
    ]);
    mock.method(companiesRepo, 'upsertCompany', () => 1);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', (msgs) => {
      return JSON.stringify({ description: 'Info.', industry: 'Tech', size: '100', headquarters: 'Sydney', website: null });
    });

    const progressCalls = [];
    const result = await batchResearchCompanies({
      onProgress: (processed, total) => progressCalls.push({ processed, total }),
    });

    assert.equal(result, 3);
    assert.equal(progressCalls.length, 3);
    assert.deepEqual(progressCalls[0], { processed: 1, total: 3 });
    assert.deepEqual(progressCalls[2], { processed: 3, total: 3 });
  });

  it('AI failure for one company does not halt batch', async () => {
    let callCount = 0;
    mock.method(companiesRepo, 'getAll', () => [
      { id: 1, name: 'Good', description: null },
      { id: 2, name: 'Bad', description: null },
      { id: 3, name: 'Good2', description: null },
    ]);
    mock.method(companiesRepo, 'upsertCompany', () => 1);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return JSON.stringify({ description: 'Info.', industry: 'Tech', size: '100', headquarters: null, website: null });
    });

    const result = await batchResearchCompanies();
    assert.equal(result, 2, 'should succeed for 2 out of 3');
  });

  it('onProgress called after each company with cumulative counts', async () => {
    mock.method(companiesRepo, 'getAll', () => [
      { id: 1, name: 'X', description: null },
      { id: 2, name: 'Y', description: '' },
    ]);
    mock.method(companiesRepo, 'upsertCompany', () => 1);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () =>
      JSON.stringify({ description: 'Desc.', industry: null, size: null, headquarters: null, website: null })
    );

    const progressCalls = [];
    await batchResearchCompanies({
      onProgress: (p, t) => progressCalls.push({ p, t }),
    });

    assert.equal(progressCalls.length, 2);
    assert.equal(progressCalls[0].p, 1);
    assert.equal(progressCalls[0].t, 2);
    assert.equal(progressCalls[1].p, 2);
    assert.equal(progressCalls[1].t, 2);
  });

  it('15 companies processed in 2 chunks (10+5) via re-enqueue', async () => {
    const companies = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1, name: `Company${i + 1}`, description: null,
    }));
    mock.method(companiesRepo, 'getAll', () => companies);
    mock.method(companiesRepo, 'upsertCompany', () => 1);
    mock.method(openAIClient, 'hasOpenAIKey', () => true);
    mock.method(openAIClient, 'chatCompletion', () =>
      JSON.stringify({ description: 'Info.', industry: 'Tech', size: '100', headquarters: null, website: null })
    );

    const mockQueue = { enqueue: mock.fn(() => 'mock-task-id') };

    const result = await batchResearchCompanies({ _backgroundQueue: mockQueue });

    // First chunk: 10 companies processed and researched
    assert.equal(result, 10);
    assert.equal(openAIClient.chatCompletion.mock.calls.length, 10);
    assert.equal(companiesRepo.upsertCompany.mock.calls.length, 10);

    // Remaining 5 re-enqueued as a new backgroundQueue task
    assert.equal(mockQueue.enqueue.mock.calls.length, 1);
    const enqueueArgs = mockQueue.enqueue.mock.calls[0].arguments;
    assert.equal(enqueueArgs[0], 'company_research_chunk');
    assert.equal(enqueueArgs[1].candidates.length, 5);
    // Verify the correct 5 companies were re-enqueued
    assert.equal(enqueueArgs[1].candidates[0].name, 'Company11');
    assert.equal(enqueueArgs[1].candidates[4].name, 'Company15');
  });

  it('all-null AI result does not upsert', async () => {
    mock.method(companiesRepo, 'getAll', () => [
      { id: 1, name: 'Unknown', description: null },
    ]);
    mock.method(companiesRepo, 'upsertCompany', () => { throw new Error('should not be called'); });
    mock.method(openAIClient, 'hasOpenAIKey', () => false); // triggers all-null fallback

    const result = await batchResearchCompanies();
    assert.equal(result, 0);
  });
});
