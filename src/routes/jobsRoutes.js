const express = require('express');
const { getJobsWithScore, getJobById, searchJobs, getJobCounts, getJobsApi, searchJobsApi, countJobs, countSearchJobs, getDuplicateSourcesForJob, getJobApplicationForUser } = require('../repositories/jobsRepo');
const { getBestFitScoreForJob, getScoreForJobAndResume, getScoresForJobByUser, getBestScorePerJobForUser, getBestScorePerJobForUserWithOverrides, getFitScore } = require('../repositories/fitScoresRepo');
const { getSourceFreshness } = require('../repositories/scraperRunsRepo');
const { getConfirmedResumeForUser, countConfirmedResumesForUser, getResumeByIdAndUser } = require('../repositories/resumesRepo');
const resumeOverridesRepo = require('../repositories/resumeOverridesRepo');
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
const { optimizationLimiter, companyResearchLimiter, resumeOverrideLimiter } = require('../middleware/rateLimiter');
const optimizationSuggestionsRepo = require('../repositories/optimizationSuggestionsRepo');
const optimizationService = require('../services/optimizationService');
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

    // Multi-resume: compute best score per job with resume label
    let _userResumeCount = 0;
    let bestScoreMap = {};
    if (user) {
      _userResumeCount = countConfirmedResumesForUser(user.id);
      if (_userResumeCount >= 1) {
        try {
          const hasOverrides = resumeOverridesRepo.hasOverrides(user.id);
          const bestScores = hasOverrides
            ? getBestScorePerJobForUserWithOverrides(user.id)
            : getBestScorePerJobForUser(user.id);
          for (const row of bestScores) {
            bestScoreMap[row.job_id] = row;
          }
        } catch (e) {
          logger.warn('Failed to load best scores per job', { error: e.message });
        }
      }
    }

    // Attach display_score and display_label to each job
    for (const job of jobs) {
      const best = bestScoreMap[job.id];
      if (best) {
        job.display_score = best.display_score;
        job.display_label = best.display_label || null;
      } else {
        job.display_score = null;
        job.display_label = null;
      }
    }

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
      _userResumeCount,
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

  // Side effect: mark notification as read from email link
  const alertRead = req.query.alert_read;
  if (alertRead && /^[a-f0-9]{32}$/.test(alertRead)) {
    try {
      const { markReadByToken } = require('../repositories/notificationsRepo');
      markReadByToken(alertRead);
    } catch {
      // silently ignore
    }
  }

  const user = req.user || null;
  const resume = user ? getPrimaryResume() : null;

  // Multi-resume: load all per-resume scores and compute primary score
  let _userResumeCount = 0;
  let allScores = [];
  let primaryScore = null;
  let overrideResumeId = null;

  let score = null;
  let breakdown = { matched_keywords: [], missing_skills: [], total_keywords: 0 };

  if (user) {
    _userResumeCount = countConfirmedResumesForUser(user.id);

    if (_userResumeCount >= 1) {
      try {
        // Get all scores for this job across user's resumes
        const rawScores = getScoresForJobByUser(job.id, user.id);
        allScores = rawScores.map(s => {
          let matched_skills = [];
          try {
            const bd = JSON.parse(s.breakdown_json || '{}');
            matched_skills = bd.matched_skills || [];
          } catch { /* ignore */ }
          let missing_skills = [];
          try {
            missing_skills = JSON.parse(s.skill_gaps_json || '[]');
          } catch { /* ignore */ }
          return {
            resume_id: s.resume_id,
            resume_label: s.resume_label,
            overall_score: s.overall_score,
            semantic_score: s.semantic_score,
            keyword_score: s.keyword_score,
            role_alignment_score: s.role_alignment_score,
            location_score: s.location_score,
            matched_skills,
            missing_skills,
          };
        });

        // Check for manual override
        const override = resumeOverridesRepo.getOverride(job.id, user.id);
        if (override) {
          overrideResumeId = override.resume_id;
          const overrideScore = allScores.find(s => s.resume_id === override.resume_id);
          if (overrideScore) {
            primaryScore = overrideScore;
          }
        }

        // Fallback to best (highest) score
        if (!primaryScore && allScores.length > 0) {
          primaryScore = allScores[0]; // already sorted DESC by overall_score
        }
      } catch (e) {
        logger.warn('Failed to load multi-resume scores for job detail', { jobId: job.id, error: e.message });
      }
    }
  }

  // Use primaryScore for backward-compatible score/breakdown variables
  if (primaryScore) {
    score = primaryScore;
    breakdown = {
      matched_keywords: primaryScore.matched_skills || [],
      missing_skills: primaryScore.missing_skills || [],
      total_keywords: (primaryScore.matched_skills || []).length + (primaryScore.missing_skills || []).length,
    };
  } else if (resume) {
    // Fallback for single-resume or legacy behavior
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
  // Use primaryScore's resume_id if available, otherwise fall back to primary resume
  const coverLetterResumeId = (primaryScore && primaryScore.resume_id) || (resume && resume.id);
  let coverLetter = coverLetterResumeId ? getCoverLetter(job.id, coverLetterResumeId, 'en', 'english_cover_letter') : null;
  if (!coverLetter && coverLetterResumeId) {
    coverLetter = getCoverLetter(job.id, coverLetterResumeId, 'zh', 'chinese_cover_letter');
  }
  // Legacy fallback
  if (!coverLetter && coverLetterResumeId) {
    coverLetter = getCoverLetter(job.id, coverLetterResumeId, 'zh');
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

  // Optimization suggestions (SSR injection)
  let optimizationSuggestions = undefined;
  let optimizationSuggestionsStale = false;
  const optResumeId = (primaryScore && primaryScore.resume_id) || (resume && resume.id);
  if (user && optResumeId && score) {
    try {
      const cached = optimizationSuggestionsRepo.getByJobAndResume(job.id, optResumeId, user.id);
      if (cached) {
        if (cached.stale) {
          optimizationSuggestionsStale = true;
        } else {
          optimizationSuggestions = optimizationService.formatResponse(cached);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Flash from query params
  const flash = {};
  if (req.query.success) flash.success = req.query.success;
  if (req.query.error) flash.error = req.query.error;

  logger.debug('Rendering job detail', {
    jobId: job.id,
    hasUser: !!user,
    hasResume: !!resume,
    hasScore: !!score,
    hasCompany: !!company,
    hasCoverLetter: !!coverLetter,
    applicationStatus: application ? application.status : null,
    isAps,
    allScoresCount: allScores.length,
    overrideResumeId,
  });

  res.render('jobs/detail', {
    job,
    user,
    resume,
    hasResume: !!resume,
    score,
    breakdown,
    allScores,
    primaryScore,
    overrideResumeId,
    _userResumeCount,
    company,
    coverLetter,
    application,
    scoreFeedback,
    isAps,
    recommendedModes,
    duplicateSources,
    optimizationSuggestions,
    optimizationSuggestionsStale,
    flash,
    currentPath: `/jobs/${job.id}`,
  });
});

/**
 * POST /jobs/:id/resume-override — manually select a resume for this job's scoring
 */
router.post('/jobs/:id/resume-override', requireAuth, resumeOverrideLimiter, (req, res, next) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return next(new AppError('NOT_FOUND', 'Job not found'));
  }

  const job = getJobById(jobId);
  if (!job) {
    return next(new AppError('NOT_FOUND', 'Job not found'));
  }

  const resumeId = Number(req.body.resume_id);
  if (!Number.isFinite(resumeId)) {
    return res.redirect(`/jobs/${jobId}?error=` + encodeURIComponent('Invalid resume selection.'));
  }

  // Validate resume ownership
  const resume = getResumeByIdAndUser(resumeId, req.user.id);
  if (!resume) {
    return next(new AppError('NOT_FOUND', 'Resume not found'));
  }

  // Validate resume is confirmed
  if (resume.is_confirmed !== 1) {
    return res.redirect(`/jobs/${jobId}?error=` + encodeURIComponent('Resume must be confirmed before use.'));
  }

  // Validate score exists for this job+resume
  const existingScore = getFitScore(jobId, resumeId);
  if (!existingScore) {
    return res.redirect(`/jobs/${jobId}?error=` + encodeURIComponent('Resume has not been scored for this job.'));
  }

  resumeOverridesRepo.upsertOverride(jobId, req.user.id, resumeId);
  return res.redirect(`/jobs/${jobId}`);
});

/**
 * POST /jobs/:id/resume-override/clear — revert to automatic best match
 */
router.post('/jobs/:id/resume-override/clear', requireAuth, resumeOverrideLimiter, (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.redirect('/jobs');
  }

  resumeOverridesRepo.deleteOverride(jobId, req.user.id);
  const msg = res.locals.t('jobs.detail.overrideCleared', 'Reverted to automatic best match.');
  return res.redirect(`/jobs/${jobId}?success=` + encodeURIComponent(msg));
});

/**
 * POST /jobs/:id/company-research — trigger company research for a job
 */
router.post('/jobs/:id/company-research', requireAuth, companyResearchLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = getJobById(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!job.company_name) {
    return res.status(400).json({ error: 'No company name available for this job' });
  }

  try {
    const company = await ensureCompanyForJob(job, { forceResearch: true });
    if (!company) {
      return res.status(500).json({ error: 'Company research failed' });
    }

    logger.info('Company research triggered', { jobId: id, company: company.name });
    res.json({
      name: company.name,
      industry: company.industry || null,
      size: company.size || null,
      description: company.description || null,
      headquarters: company.headquarters || null,
      website: company.website || null,
    });
  } catch (err) {
    logger.error('Company research failed', { jobId: id, error: err.message });
    res.status(500).json({ error: 'Company research failed' });
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

/**
 * POST /api/jobs/:jobId/optimization-suggestions — Generate optimization suggestions
 */
/**
 * Wraps the shared optimizationLimiter to return { error: string } per INTERFACE_CONTRACT.md.
 * The shared rateLimiter factory returns { error: { code, message } } (nested object),
 * but the contract specifies all error responses as { "error": "<string>" }.
 */
function flatErrorLimiter(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (res.statusCode === 429 && body && body.error && typeof body.error === 'object') {
      return originalJson({ error: body.error.message });
    }
    return originalJson(body);
  };
  optimizationLimiter(req, res, next);
}

router.post('/api/jobs/:jobId/optimization-suggestions', requireAuth, flatErrorLimiter, async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isFinite(jobId)) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const job = getJobById(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const result = await optimizationService.generateSuggestions(jobId, req.user.id);
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('Optimization suggestion generation failed', { jobId, userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  }
});

/**
 * GET /api/jobs/:jobId/optimization-suggestions — Retrieve cached suggestions
 */
router.get('/api/jobs/:jobId/optimization-suggestions', requireAuth, (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isFinite(jobId)) {
    return res.status(404).json({ error: 'No suggestions found — click Improve Resume to generate' });
  }

  const resume = getConfirmedResumeForUser(req.user.id);
  if (!resume) {
    return res.status(404).json({ error: 'No suggestions found — click Improve Resume to generate' });
  }

  const cached = optimizationSuggestionsRepo.getByJobAndResume(jobId, resume.id, req.user.id);
  if (!cached) {
    return res.status(404).json({ error: 'No suggestions found — click Improve Resume to generate' });
  }

  const response = optimizationService.formatResponse(cached);
  res.json(response);
});

module.exports = router;
