const express = require('express');
const { getJobsWithScore, getJobById, searchJobs, getJobCounts, getJobsApi, searchJobsApi, countJobs, countSearchJobs, getDuplicateSourcesForJob, getJobApplicationForUser } = require('../repositories/jobsRepo');
const { getBestFitScoreForJob, getScoreForJobAndResume } = require('../repositories/fitScoresRepo');
const { getSourceFreshness } = require('../repositories/scraperRunsRepo');
const { getConfirmedResumeForUser } = require('../repositories/resumesRepo');
const backgroundQueue = require('../services/backgroundQueue');
const { AppError } = require('../utils/errors');
const { getCoverLetter } = require('../repositories/coverLettersRepo');
const { getCompanyByName } = require('../repositories/companiesRepo');
const { findByUserAndJob } = require('../repositories/applicationsRepo');
const { findByUserAndJob: findFeedbackByUserAndJob } = require('../repositories/scoreFeedbackRepo');
const { getPrimaryResume } = require('../services/resumeService');
const { isApsRole, getRecommendedModes } = require('../services/coverLetterService');
const { ensureCompanyForJob } = require('../services/companyService');
const { requireAuth } = require('../middleware/auth');
const { sanitizeFtsQuery } = require('../utils/ftsQuerySanitizer');
const { getLogger } = require('../logger');

const logger = getLogger('jobsRoutes');
const router = express.Router();

const JOBS_PER_PAGE = 20;
const HOME_JOB_LIMIT = 8;

/**
 * GET / — Landing home page
 */
router.get('/', (req, res) => {
  try {
    const stats = getJobCounts();

    res.render('pages/landing', {
      stats,
      user: req.user || null,
      currentPath: '/',
    });
  } catch (err) {
    logger.error('Error rendering landing page', { error: err.message });
    res.render('pages/landing', {
      stats: {},
      error: true,
      user: req.user || null,
      currentPath: '/',
    });
  }
});

/**
 * GET /how-it-works — Static page
 */
router.get('/how-it-works', (req, res) => {
  res.render('pages/how-it-works', {
    user: req.user || null,
    currentPath: '/how-it-works',
  });
});

/**
 * GET /jobs — Job listing page with full search/filter/pagination
 */
router.get('/jobs', (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const location = (req.query.location || '').trim();
  const source = req.query.source || '';
  const workType = req.query.workType || '';
  const visa = req.query.visa || '';
  const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
  const sort = req.query.sort || 'newest';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const filters = {
    keyword,
    location,
    source,
    workType,
    visa,
    minScore: Number.isFinite(minScore) && minScore > 0 ? minScore : '',
  };

  try {
    const repoFilters = {};
    if (source) repoFilters.source = source;
    if (location) repoFilters.location = location;
    if (workType) repoFilters.work_type = workType;
    if (visa) repoFilters.visa_eligibility = visa;
    if (Number.isFinite(minScore) && minScore > 0) repoFilters.minScore = minScore;
    repoFilters.sort = sort === 'score' ? undefined : 'posted_at';
    repoFilters.limit = JOBS_PER_PAGE;
    repoFilters.offset = (page - 1) * JOBS_PER_PAGE;

    let jobs;
    const ftsQuery = keyword ? sanitizeFtsQuery(keyword) : null;

    if (ftsQuery) {
      jobs = searchJobs(ftsQuery, repoFilters);
    } else {
      jobs = getJobsWithScore(repoFilters);
    }

    // Get total count for pagination (approximate using current result set)
    // For simplicity, if we got a full page, there are likely more
    const totalCount = jobs.length < JOBS_PER_PAGE ? (page - 1) * JOBS_PER_PAGE + jobs.length : (page + 1) * JOBS_PER_PAGE;
    const totalPages = Math.max(1, Math.ceil(totalCount / JOBS_PER_PAGE));

    const user = req.user || null;
    const resume = user ? getPrimaryResume() : null;

    // Source freshness timestamps
    let sourceFreshness = {};
    try { sourceFreshness = getSourceFreshness(); } catch (e) { /* ignore */ }

    // Check if scoring is in progress for this user
    let scoringInProgress = false;
    if (user && resume && backgroundQueue) {
      try {
        const pending = typeof backgroundQueue.getPending === 'function' ? backgroundQueue.getPending() : [];
        const current = typeof backgroundQueue.getCurrent === 'function' ? backgroundQueue.getCurrent() : null;
        scoringInProgress = pending.some(t => t.type === 'scoreAllJobs') || (current && current.type === 'scoreAllJobs');
      } catch (e) { /* ignore */ }
    }

    logger.debug('Rendering jobs list', {
      filters,
      sort,
      page,
      jobsCount: jobs.length,
      hasUser: !!user,
    });

    res.render('jobs/list', {
      jobs,
      filters,
      sort,
      page,
      totalCount,
      totalPages,
      user,
      hasResume: !!resume,
      sourceFreshness,
      scoringInProgress,
      currentPath: '/jobs',
    });
  } catch (err) {
    logger.error('Error rendering jobs list', { error: err.message });
    res.render('jobs/list', {
      jobs: [],
      filters,
      sort,
      page: 1,
      totalCount: 0,
      totalPages: 1,
      error: true,
      user: req.user || null,
      hasResume: false,
      currentPath: '/jobs',
    });
  }
});

/**
 * GET /jobs/:id — Job detail page
 */
router.get('/jobs/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return next();

  const job = getJobById(id);
  if (!job) return next();

  const user = req.user || null;
  const resume = user ? getPrimaryResume() : null;

  let score = null;
  let breakdown = { matched_keywords: [], missing_skills: [], total_keywords: 0 };
  if (resume) {
    const fit = getBestFitScoreForJob(job.id);
    if (fit) {
      score = fit;
      try {
        breakdown = JSON.parse(fit.breakdown_json || '{}') || breakdown;
      } catch {
        // ignore parse error
      }
    }
  }

  const company =
    job.company_name && getCompanyByName(job.company_name)
      ? getCompanyByName(job.company_name)
      : null;

  // Get cover letter - try English first, then Chinese
  let coverLetter = resume ? getCoverLetter(job.id, resume.id, 'en', 'english_cover_letter') : null;
  if (!coverLetter && resume) {
    coverLetter = getCoverLetter(job.id, resume.id, 'zh', 'chinese_cover_letter');
  }
  // Legacy fallback
  if (!coverLetter && resume) {
    coverLetter = getCoverLetter(job.id, resume.id, 'zh');
  }

  // Application tracking status
  const application = user ? findByUserAndJob(user.id, job.id) : null;

  // Score feedback
  const scoreFeedback = user ? findFeedbackByUserAndJob(user.id, job.id) : null;

  // APS detection and recommended modes
  const isAps = isApsRole(job);
  const recommendedModes = getRecommendedModes(job);

  // Duplicate sources
  let duplicateSources = [];
  try { duplicateSources = getDuplicateSourcesForJob(job.id) || []; } catch (e) { /* ignore */ }

  logger.debug('Rendering job detail', {
    jobId: job.id,
    hasUser: !!user,
    hasResume: !!resume,
    hasScore: !!score,
    hasCompany: !!company,
    hasCoverLetter: !!coverLetter,
    applicationStatus: application ? application.status : null,
    isAps,
  });

  res.render('jobs/detail', {
    job,
    user,
    resume,
    hasResume: !!resume,
    score,
    breakdown,
    company,
    coverLetter,
    application,
    scoreFeedback,
    isAps,
    recommendedModes,
    duplicateSources,
    currentPath: `/jobs/${job.id}`,
  });
});

/**
 * POST /jobs/:id/company-research — trigger company research for a job
 */
router.post('/jobs/:id/company-research', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = getJobById(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!job.company_name) {
    return res.status(400).json({ error: 'Job has no company name' });
  }

  try {
    const company = await ensureCompanyForJob(job);
    if (!company || !company.description) {
      return res.status(503).json({ error: 'Company research unavailable. AI service may be down.' });
    }

    logger.info('Company research triggered', { jobId: id, company: company.name });
    res.json({
      name: company.name,
      description: company.description,
      industry: company.industry,
      size: company.size,
      headquarters: company.headquarters,
      website: company.website,
    });
  } catch (err) {
    logger.error('Company research failed', { jobId: id, error: err.message });
    res.status(500).json({ error: 'Failed to research company' });
  }
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/jobs — Job search and listing API
 */
router.get('/api/jobs', (req, res, next) => {
  try {
    const q = (req.query.q || '').trim() || null;
    const location = (req.query.location || '').trim() || null;
    const source = (req.query.source || '').trim() || null; // comma-separated
    const work_type = (req.query.work_type || '').trim() || null;
    const visa = (req.query.visa || '').trim() || null;
    const aps_class = (req.query.aps_class || '').trim() || null;
    const min_score = req.query.min_score ? parseInt(req.query.min_score, 10) : null;
    const min_salary = req.query.min_salary ? parseInt(req.query.min_salary, 10) : null;
    const max_salary = req.query.max_salary ? parseInt(req.query.max_salary, 10) : null;
    let sort = req.query.sort || 'posted_at';
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const per_page = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));

    const user = req.user || null;
    let resume_id = null;
    if (user) {
      const resume = getConfirmedResumeForUser(user.id);
      if (resume) resume_id = resume.id;
    }

    // Fallback: if sorting by score but no resume, use posted_at
    if (sort === 'score' && !resume_id) {
      sort = 'posted_at';
    }

    const filters = {};
    if (location) filters.location = location;
    if (source) filters.source = source;
    if (work_type) filters.work_type = work_type;
    if (visa) filters.visa_eligibility = visa;
    if (aps_class) filters.aps_classification = aps_class;
    if (Number.isFinite(min_score) && min_score > 0) filters.minScore = min_score;
    if (Number.isFinite(min_salary)) filters.min_salary = min_salary;
    if (Number.isFinite(max_salary)) filters.max_salary = max_salary;
    filters.sort = sort;
    filters.order = order;
    filters.limit = per_page;
    filters.offset = (page - 1) * per_page;
    if (resume_id) filters.resume_id = resume_id;

    const ftsQuery = q ? sanitizeFtsQuery(q) : null;
    let jobs, total;

    if (ftsQuery) {
      jobs = searchJobsApi(ftsQuery, filters);
      total = countSearchJobs(ftsQuery, filters);
    } else {
      jobs = getJobsApi(filters);
      total = countJobs(filters);
    }

    const total_pages = Math.max(1, Math.ceil(total / per_page));

    // Map jobs to response shape
    const mappedJobs = jobs.map((job) => {
      let fit_score = null;
      if (user && resume_id && job.fs_overall_score != null) {
        let top_matched_skills = [];
        try {
          const bd = JSON.parse(job.fs_breakdown_json || '{}');
          if (Array.isArray(bd.matched_skills)) {
            top_matched_skills = bd.matched_skills.slice(0, 3);
          }
        } catch { /* ignore */ }
        fit_score = {
          overall_score: job.fs_overall_score,
          visa_match: job.fs_visa_match,
          top_matched_skills,
        };
      }

      let application = null;
      if (user) {
        const app = findByUserAndJob(user.id, job.id);
        if (app) application = { status: app.status };
      }

      return {
        id: job.id,
        title: job.title,
        company_name: job.company_name,
        location: job.location,
        work_type: job.work_type,
        salary: job.salary,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        source: job.source,
        posted_at: job.posted_at,
        closes_at: job.closes_at,
        visa_eligibility: job.visa_eligibility,
        security_clearance: job.security_clearance,
        aps_classification: job.aps_classification,
        is_active: job.is_active,
        url: job.url,
        fit_score,
        application,
      };
    });

    const source_freshness = getSourceFreshness();

    // Check if scoring is in progress for this user's resume
    let scoring_in_progress = false;
    if (resume_id) {
      const queueStatus = backgroundQueue.getStatus();
      const allTasks = [...(queueStatus.pending || [])];
      if (queueStatus.currentTask) allTasks.push(queueStatus.currentTask);
      scoring_in_progress = allTasks.some(
        (t) => t.type === 'scoreAllJobs'
      );
    }

    res.json({
      jobs: mappedJobs,
      filters_applied: {
        q: q || null,
        location: location || null,
        source: source || null,
        work_type: work_type || null,
        visa: visa || null,
        aps_class: aps_class || null,
        min_score: Number.isFinite(min_score) ? min_score : null,
        min_salary: Number.isFinite(min_salary) ? min_salary : null,
        max_salary: Number.isFinite(max_salary) ? max_salary : null,
        sort,
      },
      pagination: { page, per_page, total, total_pages },
      source_freshness,
      scoring_in_progress,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/jobs/:id — Job detail API
 */
router.get('/api/jobs/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      throw new AppError('NOT_FOUND', 'Job not found');
    }

    const job = getJobById(id);
    if (!job) {
      throw new AppError('NOT_FOUND', 'Job not found');
    }

    const company = job.company_id && job.company_name
      ? getCompanyByName(job.company_name) || null
      : null;

    const user = req.user || null;
    const rawApp = user ? findByUserAndJob(user.id, job.id) : null;
    const application = rawApp ? {
      id: rawApp.id,
      status: rawApp.status,
      notes: rawApp.notes,
      applied_at: rawApp.applied_at,
      status_updated_at: rawApp.status_updated_at,
    } : null;
    const duplicate_sources = getDuplicateSourcesForJob(job.id);

    res.json({
      job: {
        id: job.id,
        title: job.title,
        company_name: job.company_name,
        company_id: job.company_id,
        location: job.location,
        work_type: job.work_type,
        salary: job.salary,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        description: job.description,
        url: job.url,
        source: job.source,
        external_id: job.external_id,
        posted_at: job.posted_at,
        closes_at: job.closes_at,
        visa_eligibility: job.visa_eligibility,
        security_clearance: job.security_clearance,
        aps_classification: job.aps_classification,
        is_active: job.is_active,
        created_at: job.created_at,
        updated_at: job.updated_at,
      },
      company: company ? {
        name: company.name,
        website: company.website,
        description: company.description,
        industry: company.industry,
        size: company.size,
        logo_url: company.logo_url,
        headquarters: company.headquarters,
        researched_at: company.researched_at,
      } : null,
      application,
      duplicate_sources,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/jobs/:jobId/score — Score detail API (requires auth)
 */
router.get('/api/jobs/:jobId/score', requireAuth, (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      throw new AppError('NOT_FOUND', 'Job not found');
    }

    const resume = getConfirmedResumeForUser(req.user.id);
    if (!resume) {
      throw new AppError('SCORE_NOT_FOUND', 'Score not found for this job');
    }

    const score = getScoreForJobAndResume(jobId, resume.id);
    if (!score) {
      throw new AppError('SCORE_NOT_FOUND', 'Score not found for this job');
    }

    let breakdown_json = {};
    try {
      breakdown_json = JSON.parse(score.breakdown_json || '{}');
    } catch { /* ignore */ }

    res.json({
      score: {
        overall_score: score.overall_score,
        semantic_score: score.semantic_score,
        keyword_score: score.keyword_score,
        role_alignment_score: score.role_alignment_score,
        location_score: score.location_score,
        visa_match: score.visa_match,
        values_international_experience: !!score.values_international_experience,
        breakdown_json: {
          matched_skills: breakdown_json.matched_skills || [],
          missing_skills: breakdown_json.missing_skills || [],
          role_alignment_detail: breakdown_json.role_alignment_detail || null,
          location_detail: breakdown_json.location_detail || null,
          visa_note: breakdown_json.visa_note || null,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
