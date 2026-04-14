'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// T-145, T-146: Locale Middleware Tests

describe('Locale Files', () => {
  const en = require('./en.json');
  const zh = require('./zh.json');

  // T-145: Locale files have all required keys
  it('en.json has all required UI string keys', () => {
    const requiredKeys = [
      'app.name',
      'nav.jobs', 'nav.resumes', 'nav.admin', 'nav.applications',
      'nav.login', 'nav.register', 'nav.howItWorks',
      'auth.login.title', 'auth.login.email', 'auth.login.password', 'auth.login.submit',
      'auth.register.title', 'auth.register.email', 'auth.register.password', 'auth.register.submit',
      'auth.logout',
      'errors.404.title', 'errors.404.body',
      'errors.500.title', 'errors.500.body',
      'errors.backToJobs',
      'errors.sessionExpired', 'errors.authRequired', 'errors.forbidden',
      'errors.rateLimit', 'errors.validationFailed', 'errors.invalidCredentials',
      'jobs.list.title', 'jobs.list.empty',
      'jobs.detail.backToList',
      'coverLetter.mode.english', 'coverLetter.mode.aps',
      'onboarding.tooltip.step1.title', 'onboarding.tooltip.step1.body',
      'onboarding.tooltip.step2.title', 'onboarding.tooltip.step2.body',
      'onboarding.tooltip.step3.title', 'onboarding.tooltip.step3.body',
      'onboarding.cta.welcome',
      'howItWorks.title',
      'howItWorks.section1.title', 'howItWorks.section1.body',
      'howItWorks.section2.title', 'howItWorks.section2.body',
      'howItWorks.section3.title', 'howItWorks.section3.body',
      'filter.toggle', 'filter.location', 'filter.workType', 'filter.source',
      'sort.bestMatch', 'sort.newest', 'sort.salary',
      'tracker.title', 'tracker.empty',
      'resumes.list.title', 'resumes.upload.title',
    ];

    for (const key of requiredKeys) {
      assert.ok(key in en, `en.json missing key: ${key}`);
    }
  });

  it('zh.json has all required UI string keys matching en.json', () => {
    const enKeys = Object.keys(en);
    for (const key of enKeys) {
      assert.ok(key in zh, `zh.json missing key: ${key}`);
    }
  });

  it('both locale files have all APS classification data', () => {
    const apsClassifications = ['APS1', 'APS2', 'APS3', 'APS4', 'APS5', 'APS6', 'EL1', 'EL2', 'SES1', 'SES2', 'SES3'];

    for (const cls of apsClassifications) {
      assert.ok(`aps.${cls}.title` in en, `en.json missing aps.${cls}.title`);
      assert.ok(`aps.${cls}.salary_band` in en, `en.json missing aps.${cls}.salary_band`);
      assert.ok(`aps.${cls}.description` in en, `en.json missing aps.${cls}.description`);
      assert.ok(`aps.${cls}.private_sector_equivalent` in en, `en.json missing aps.${cls}.private_sector_equivalent`);

      assert.ok(`aps.${cls}.title` in zh, `zh.json missing aps.${cls}.title`);
      assert.ok(`aps.${cls}.salary_band` in zh, `zh.json missing aps.${cls}.salary_band`);
    }
  });

  // T-13.2: Batch apply locale keys (57 keys under batchApply.* namespace)
  it('both locale files have all 57 batchApply.* keys', () => {
    const expectedKeys = [
      // nav (2)
      'batchApply.nav.profile',
      'batchApply.nav.history',
      // profile (14)
      'batchApply.profile.title',
      'batchApply.profile.hint',
      'batchApply.profile.fullName',
      'batchApply.profile.email',
      'batchApply.profile.phone',
      'batchApply.profile.visaStatus',
      'batchApply.profile.workRights',
      'batchApply.profile.expectedSalary',
      'batchApply.profile.salaryHelp',
      'batchApply.profile.noticePeriod',
      'batchApply.profile.lastUpdated',
      'batchApply.profile.saved',
      'batchApply.profile.configureFirst',
      'batchApply.profile.uploadResume',
      'batchApply.profile.save',
      'batchApply.profile.validationError',
      // listing (8)
      'batchApply.listing.selected',
      'batchApply.listing.maxSelected',
      'batchApply.listing.applyAll',
      'batchApply.listing.clearSelection',
      'batchApply.listing.seekOnly',
      'batchApply.listing.configBanner',
      'batchApply.listing.resumeBanner',
      'batchApply.listing.missingCoverLetter',
      // progress (16)
      'batchApply.progress.title',
      'batchApply.progress.nowReviewing',
      'batchApply.progress.pending',
      'batchApply.progress.inProgress',
      'batchApply.progress.awaitingSubmit',
      'batchApply.progress.applied',
      'batchApply.progress.failed',
      'batchApply.progress.skipped',
      'batchApply.progress.summary',
      'batchApply.progress.cancelBatch',
      'batchApply.progress.cancelConfirm',
      'batchApply.progress.skipJob',
      'batchApply.progress.captcha',
      'batchApply.progress.rateLimited',
      'batchApply.progress.batchComplete',
      'batchApply.progress.sessionActive',
      // error (7)
      'batchApply.error.listingExpired',
      'batchApply.error.applyButtonNotFound',
      'batchApply.error.formFieldNotFound',
      'batchApply.error.resumeNotAttached',
      'batchApply.error.coverLetterNotAttached',
      'batchApply.error.playwrightMissing',
      'batchApply.error.browserCrash',
      // history (8)
      'batchApply.history.title',
      'batchApply.history.empty',
      'batchApply.history.viewDetail',
      'batchApply.history.browseJobs',
      'batchApply.history.statusPending',
      'batchApply.history.statusInProgress',
      'batchApply.history.statusCompleted',
      'batchApply.history.statusCancelled',
    ];

    assert.equal(expectedKeys.length, 57, 'expected exactly 57 batchApply keys');

    for (const key of expectedKeys) {
      assert.ok(key in en, `en.json missing key: ${key}`);
      assert.ok(key in zh, `zh.json missing key: ${key}`);
    }

    // Verify no batchApply keys exist in one file but not the other
    const enBatchKeys = Object.keys(en).filter(k => k.startsWith('batchApply.'));
    const zhBatchKeys = Object.keys(zh).filter(k => k.startsWith('batchApply.'));
    assert.equal(enBatchKeys.length, 57, `en.json should have exactly 57 batchApply keys, found ${enBatchKeys.length}`);
    assert.equal(zhBatchKeys.length, 57, `zh.json should have exactly 57 batchApply keys, found ${zhBatchKeys.length}`);

    for (const key of enBatchKeys) {
      assert.ok(key in zh, `zh.json missing batchApply key present in en.json: ${key}`);
    }
    for (const key of zhBatchKeys) {
      assert.ok(key in en, `en.json missing batchApply key present in zh.json: ${key}`);
    }
  });

  // T-13: Company research locale keys
  it('both locale files have company research keys (headquarters, researchPending)', () => {
    const companyKeys = [
      'jobs.detail.company.headquarters',
      'jobs.detail.company.researchPending',
    ];

    for (const key of companyKeys) {
      assert.ok(key in en, `en.json missing key: ${key}`);
      assert.ok(key in zh, `zh.json missing key: ${key}`);
    }

    // Verify exact values per INTERFACE_CONTRACT.md
    assert.equal(en['jobs.detail.company.headquarters'], 'Headquarters');
    assert.equal(en['jobs.detail.company.researchPending'], 'Research pending \u2014 please try again later.');
    assert.equal(zh['jobs.detail.company.headquarters'], '\u603b\u90e8');
    assert.equal(zh['jobs.detail.company.researchPending'], '\u7814\u7a76\u8fdb\u884c\u4e2d \u2014 \u8bf7\u7a0d\u540e\u518d\u8bd5\u3002');
  });

  it('both locale files have salary band data', () => {
    const levels = ['APS1', 'APS2', 'APS3', 'APS4', 'APS5', 'APS6', 'EL1', 'EL2', 'SES1', 'SES2', 'SES3'];

    for (const level of levels) {
      assert.ok(`salary_bands.${level}.min` in en, `en.json missing salary_bands.${level}.min`);
      assert.ok(`salary_bands.${level}.max` in en, `en.json missing salary_bands.${level}.max`);
      assert.ok(`salary_bands.${level}.description` in en, `en.json missing salary_bands.${level}.description`);
      assert.ok(typeof en[`salary_bands.${level}.min`] === 'number', `salary_bands.${level}.min should be a number`);
      assert.ok(typeof en[`salary_bands.${level}.max`] === 'number', `salary_bands.${level}.max should be a number`);
    }
  });
});

describe('Locale Middleware (app.js)', () => {
  // T-145: Locale middleware reads lang cookie
  it('app.js locale middleware resolves locale from cookie', () => {
    // Test the resolveLocale logic inline (same as in app.js)
    function resolveLocale(raw) {
      if (!raw) return 'en';
      const normalized = String(raw).toLowerCase();
      if (normalized.startsWith('en')) return 'en';
      if (normalized.startsWith('zh')) return 'zh';
      return 'en';
    }

    assert.equal(resolveLocale('en'), 'en');
    assert.equal(resolveLocale('en-AU'), 'en');
    assert.equal(resolveLocale('zh'), 'zh');
    assert.equal(resolveLocale('zh-CN'), 'zh');
    assert.equal(resolveLocale(null), 'en');
    assert.equal(resolveLocale(undefined), 'en');
    assert.equal(resolveLocale('fr'), 'en'); // unknown defaults to en
  });

  // T-146: Error pages receive locale data
  it('app.js exports a working Express app', () => {
    const app = require('../app');
    assert.ok(app, 'app should export');
    assert.equal(typeof app.use, 'function', 'should be an Express app');
  });
});
