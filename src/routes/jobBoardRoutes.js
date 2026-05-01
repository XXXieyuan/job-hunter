'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const jobSearchSectionsRepo = require('../repositories/jobSearchSectionsRepo');
const jobSearchService = require('../services/jobSearchService');
const { getAllCategories } = require('../utils/roleCategory');
const { getLogger } = require('../logger');

const router = express.Router();
const logger = getLogger('jobBoardRoutes');

const VALID_SOURCES = new Set(['seek', 'linkedin', 'apsjobs', 'actgov', 'nswgov']);
const VALID_SORTS = new Set(['newest', 'score', 'salary']);
const VALID_ROLE_KEYS = new Set(getAllCategories().map((category) => category.key));

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function positiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function buildSectionFiltersFromBody(body = {}) {
  const filters = {};
  const keyword = cleanText(body.keyword);
  const location = cleanText(body.location);
  const workType = cleanText(body.workType, 60);
  const visa = cleanText(body.visa, 60);
  const sort = cleanText(body.sort, 20);
  const minScore = positiveNumber(body.minScore);
  const salaryMin = positiveNumber(body.salaryMin || body.minSalary);
  const salaryMax = positiveNumber(body.salaryMax || body.maxSalary);
  const sources = normalizeList(body.source).filter((source) => VALID_SOURCES.has(source));
  const roles = normalizeList(body.roles).filter((role) => VALID_ROLE_KEYS.has(role));

  if (keyword) filters.keyword = keyword;
  if (location) filters.location = location;
  if (sources.length > 0) filters.source = sources;
  if (workType) filters.workType = workType;
  if (visa) filters.visa = visa;
  if (minScore !== null) filters.minScore = minScore;
  if (salaryMin !== null) filters.salaryMin = salaryMin;
  if (salaryMax !== null) filters.salaryMax = salaryMax;
  if (roles.length > 0) filters.roles = roles;
  if (VALID_SORTS.has(sort)) filters.sort = sort;

  return filters;
}

function safeRedirect(value) {
  if (!value || typeof value !== 'string') return '/job-board';
  try {
    const parsed = new URL(value, 'http://job-hunter.local');
    if (parsed.origin !== 'http://job-hunter.local') return '/job-board';
    if (parsed.pathname === '/job-board' || parsed.pathname.startsWith('/jobs')) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return '/job-board';
  }
  return '/job-board';
}

function suggestSectionName(filters) {
  if (filters.keyword && filters.location) return `${filters.keyword} in ${filters.location}`;
  if (filters.keyword) return filters.keyword;
  if (filters.location) return `Jobs in ${filters.location}`;
  return 'Saved job search';
}

router.get('/job-board', requireAuth, (req, res, next) => {
  try {
    const sections = jobSearchSectionsRepo.listByUser(req.user.id);
    const sectionPreviews = jobSearchService.buildSectionPreviews(sections, { perSection: 6 });
    const totalMatches = sectionPreviews.reduce((sum, section) => sum + section.totalCount, 0);

    res.render('pages/job-board', {
      currentPath: '/job-board',
      sectionPreviews,
      totalMatches,
      allCategories: getAllCategories(),
    });
  } catch (err) {
    logger.error('Failed to render job board', {
      userId: req.user && req.user.id,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

router.post('/job-board/sections', requireAuth, (req, res, next) => {
  try {
    const filters = buildSectionFiltersFromBody(req.body);
    const existing = jobSearchSectionsRepo.listByUser(req.user.id);
    const name = cleanText(req.body.name, 80) || suggestSectionName(filters);

    jobSearchSectionsRepo.create({
      user_id: req.user.id,
      name,
      filters,
      position: existing.length * 10,
    });

    res.redirect(safeRedirect(req.body.redirectTo));
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR') {
      return res.redirect('/job-board?error=invalid-section');
    }
    return next(err);
  }
});

router.post('/job-board/sections/:id/delete', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isFinite(id)) {
      jobSearchSectionsRepo.remove(id, req.user.id);
    }
    res.redirect(safeRedirect(req.body.redirectTo));
  } catch (err) {
    next(err);
  }
});

router._buildSectionFiltersFromBody = buildSectionFiltersFromBody;
router._safeRedirect = safeRedirect;

module.exports = router;
