'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// T-131, T-132: Cover Letter Generation Service Tests

const {
  MODES,
  isApsRole,
  getRecommendedModes,
} = require('./coverLetterService');

describe('Cover Letter Service — mode configuration (T-131, T-132)', () => {
  it('MODES contains standard and aps_selection_criteria only', () => {
    const modeKeys = Object.keys(MODES);
    assert.ok(modeKeys.includes('standard'), 'Should include standard mode');
    assert.ok(modeKeys.includes('aps_selection_criteria'), 'Should include APS mode');
    assert.equal(modeKeys.length, 2, 'Should have exactly 2 modes');
  });

  it('standard mode has language "en"', () => {
    assert.equal(MODES.standard.language, 'en');
    assert.equal(MODES.standard.mode, 'standard');
  });

  it('aps_selection_criteria mode has language "en"', () => {
    assert.equal(MODES.aps_selection_criteria.language, 'en');
    assert.equal(MODES.aps_selection_criteria.mode, 'aps_selection_criteria');
  });

  it('no Chinese/zh mode exists', () => {
    assert.ok(!MODES.chinese_cover_letter, 'Chinese mode should not exist');
    const hasZh = Object.values(MODES).some((m) => m.language === 'zh');
    assert.ok(!hasZh, 'No mode should have language zh');
  });
});

describe('Cover Letter Service — isApsRole detection', () => {
  it('returns true for apsjobs source', () => {
    assert.ok(isApsRole({ source: 'apsjobs', description: '' }));
  });

  it('returns true for description with selection criteria', () => {
    assert.ok(isApsRole({
      source: 'seek',
      description: 'Please address the following selection criteria in your application.',
    }));
  });

  it('returns true for description with key capabilities', () => {
    assert.ok(isApsRole({
      source: 'seek',
      description: 'Demonstrated key capabilities in policy analysis.',
    }));
  });

  it('returns true for description mentioning APS values', () => {
    assert.ok(isApsRole({
      source: 'seek',
      description: 'Alignment with APS values is essential.',
    }));
  });

  it('returns false for regular non-APS job', () => {
    assert.ok(!isApsRole({
      source: 'seek',
      description: 'Looking for a software developer with React and Node.js skills.',
    }));
  });
});

describe('Cover Letter Service — getRecommendedModes', () => {
  it('returns ["standard"] for non-APS jobs', () => {
    const modes = getRecommendedModes({
      source: 'seek',
      description: 'Software engineer role.',
    });
    assert.deepEqual(modes, ['standard']);
  });

  it('returns ["standard", "aps_selection_criteria"] for APS jobs', () => {
    const modes = getRecommendedModes({
      source: 'apsjobs',
      description: 'APS role with selection criteria.',
    });
    assert.deepEqual(modes, ['standard', 'aps_selection_criteria']);
  });
});
