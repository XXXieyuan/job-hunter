'use strict';

const express = require('express');
const { z } = require('zod');
const salaryAnalysisRepo = require('../repositories/salaryAnalysisRepo');
const { salaryApiLimiter } = require('../middleware/rateLimiter');
const { getLogger } = require('../logger');

const router = express.Router();
const logger = getLogger('salary');

/**
 * Zod schema for API query parameters.
 */
const apiQuerySchema = z.object({
  keyword: z.string().max(100).trim().optional(),
  location: z.string().max(100).trim().optional(),
  source: z.enum(['seek', 'linkedin', 'apsjobs']).optional(),
  aps_level: z
    .string()
    .regex(/^(APS[3-6]|EL[12]|SES|all)$/i)
    .optional(),
  group_by: z.enum(['location', 'source', 'aps_classification']).optional().default('location'),
});

/**
 * Extract salary.* locale keys from the translator function.
 */
function getSalaryLocale(t, localeData) {
  const salaryLocale = {};
  if (localeData) {
    for (const key of Object.keys(localeData)) {
      if (key.startsWith('salary.')) {
        salaryLocale[key] = localeData[key];
      }
    }
  }
  return salaryLocale;
}

/**
 * GET /salary-insights — Server-rendered salary insights page.
 */
router.get('/salary-insights', (req, res, next) => {
  try {
    const distribution = salaryAnalysisRepo.getDistribution({});
    const filterOptions = salaryAnalysisRepo.getFilterOptions();
    const meta = salaryAnalysisRepo.getMeta();

    const salaryLocale = getSalaryLocale(res.locals.t, res.locals.localeData);

    const initialData = {
      groups: distribution.groups,
      meta: {
        total_listings: meta.total_listings,
        listings_with_salary: meta.listings_with_salary,
        coverage_pct: meta.coverage_pct,
        truncated: distribution.meta.truncated,
      },
      filterOptions,
    };

    res.render('pages/salary-insights', {
      initialData,
      meta,
      filterOptions,
      salaryLocale,
    });
  } catch (err) {
    logger.error('Failed to render salary insights page', {
      message: err.message,
      stack: err.stack,
    });
    next(err);
  }
});

/**
 * GET /api/salary-insights — JSON API for salary distribution data.
 */
router.get('/api/salary-insights', salaryApiLimiter, (req, res) => {
  // Validate query parameters
  const parseResult = apiQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    const field = firstError.path[0];
    let message;

    switch (field) {
      case 'source':
        message = 'Invalid source — must be seek, linkedin, or apsjobs';
        break;
      case 'aps_level':
        message = 'Invalid APS level — must be APS3-6, EL1-2, SES, or all';
        break;
      case 'keyword':
        message = 'Keyword must be 100 characters or fewer';
        break;
      case 'group_by':
        message = 'Invalid group_by — must be location, source, or aps_classification';
        break;
      default:
        message = `Invalid parameter: ${field}`;
    }

    return res.status(400).json({ error: message });
  }

  const params = parseResult.data;

  const filters = {
    keyword: params.keyword || null,
    location: params.location || null,
    source: params.source || null,
    aps_level: params.aps_level || null,
    group_by: params.group_by,
  };

  try {
    const timeoutMs = 5000;
    const startTime = Date.now();

    const result = salaryAnalysisRepo.getDistribution(filters);

    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      logger.warn('Salary query exceeded timeout threshold', { elapsed, filters });
      return res.status(503).json({
        error: 'Salary data is temporarily unavailable. Please try again later.',
      });
    }

    res.json({
      groups: result.groups,
      meta: {
        total_matching: result.meta.total_matching,
        truncated: result.meta.truncated,
      },
      filters_applied: {
        keyword: filters.keyword,
        location: filters.location,
        source: filters.source,
        aps_level: filters.aps_level,
      },
    });
  } catch (err) {
    logger.error('Salary API error', {
      message: err.message,
      stack: err.stack,
      filters,
    });
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

module.exports = router;
