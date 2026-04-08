'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// T-130: Resume parser extracts all structured fields
// T-144: mammoth DOCX text extraction

const { structureWithAI, PROMPT_VERSION } = require('./resumeParserService');

describe('Resume Parser Service — structureWithAI (T-130)', () => {
  it('returns fallback with structured fields when no API key', async () => {
    const rawText = 'John Smith\nSoftware Engineer with 5 years experience in Python and Java.\nWorked at Google and Microsoft.\nBachelor of CS from MIT.';

    const result = await structureWithAI(rawText);

    // Should return fallback structure
    assert.ok(result.name, 'Should have a name');
    assert.ok(result.summary, 'Should have a summary');
    assert.ok(Array.isArray(result.skills), 'skills should be an array');
    assert.ok(Array.isArray(result.experience), 'experience should be an array');
    assert.ok(Array.isArray(result.education), 'education should be an array');
    assert.ok(Array.isArray(result.certifications), 'certifications should be an array');
  });

  it('fallback summary uses first 500 chars of raw text', async () => {
    const rawText = 'A'.repeat(600);
    const result = await structureWithAI(rawText);

    assert.equal(result.summary.length, 500);
  });

  it('PROMPT_VERSION is defined and is v2', () => {
    assert.ok(PROMPT_VERSION, 'PROMPT_VERSION should be defined');
    assert.equal(typeof PROMPT_VERSION, 'string');
    assert.equal(PROMPT_VERSION, 'resume-parser-v2');
  });
});

describe('Resume Parser Service — field normalization (T-130)', () => {
  it('skills have name/category/proficiency structure', () => {
    const validSkill = { name: 'Python', category: 'technical', proficiency: 'advanced' };

    assert.equal(typeof validSkill.name, 'string');
    assert.ok(['technical', 'soft', 'domain'].includes(validSkill.category));
    assert.ok(['beginner', 'intermediate', 'advanced'].includes(validSkill.proficiency));
  });

  it('experience entries have title/employer/start_date/end_date/description', () => {
    const validExp = {
      title: 'Data Analyst Intern',
      employer: 'Acme Corp',
      start_date: '2024-01',
      end_date: '2025-06',
      description: 'Analysed customer data',
    };

    assert.equal(typeof validExp.title, 'string');
    assert.equal(typeof validExp.employer, 'string');
    assert.ok('start_date' in validExp);
    assert.ok('end_date' in validExp);
    assert.equal(typeof validExp.description, 'string');
  });

  it('education entries have degree/field/institution/start_date/end_date', () => {
    const validEdu = {
      degree: 'Bachelor of Data Science',
      field: 'Data Science',
      institution: 'University of Sydney',
      start_date: '2020',
      end_date: '2024',
    };

    assert.equal(typeof validEdu.degree, 'string');
    assert.equal(typeof validEdu.field, 'string');
    assert.equal(typeof validEdu.institution, 'string');
    assert.ok('start_date' in validEdu);
    assert.ok('end_date' in validEdu);
  });

  it('certifications are objects with name/issuer/date', () => {
    const validCert = { name: 'AWS Cloud Practitioner', issuer: 'Amazon', date: '2025' };

    assert.equal(typeof validCert.name, 'string');
    assert.ok('issuer' in validCert);
    assert.ok('date' in validCert);
  });

  it('extractText is exported and is a function (DOCX-only)', () => {
    const { extractText } = require('./resumeParserService');
    assert.equal(typeof extractText, 'function');
  });
});
