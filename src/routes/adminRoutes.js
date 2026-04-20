const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sanitizeHtml = require('sanitize-html');
const { ADMIN_TOKEN } = require('../config');
const { requireAdmin: requireAdminRole } = require('../middleware/auth');
const { AppError, errorRingBuffer } = require('../utils/errors');
const {
  triggerFullAnalysis,
  triggerAnalysis,
  getLastAnalysisRun,
  VALID_ANALYSIS_TYPES,
} = require('../services/analysisService');
const {
  triggerScrape,
  VALID_PLATFORMS,
} = require('../services/scraperService');
const { detectDuplicates } = require('../services/deduplicationService');
const backgroundQueue = require('../services/backgroundQueue');
const jobsRepo = require('../repositories/jobsRepo');
const usersRepo = require('../repositories/usersRepo');
const resumesRepo = require('../repositories/resumesRepo');
const fitScoresRepo = require('../repositories/fitScoresRepo');
const scraperRunsRepo = require('../repositories/scraperRunsRepo');
const analysisRunsRepo = require('../repositories/analysisRunsRepo');
const duplicateGroupsRepo = require('../repositories/duplicateGroupsRepo');
const coverLettersRepo = require('../repositories/coverLettersRepo');
const sessionsRepo = require('../repositories/sessionsRepo');
const optimizationSuggestionsRepo = require('../repositories/optimizationSuggestionsRepo');
const companiesRepo = require('../repositories/companiesRepo');
const companyService = require('../services/companyService');
const { batchCompanyResearchLimiter } = require('../middleware/rateLimiter');
const { getDbSizeMb } = require('../db/connection');
const { getLogger } = require('../logger');

const logger = getLogger('adminRoutes');
const router = express.Router();
const ADMIN_COOKIE_NAME = 'jh_admin_session';

// Multer for file upload (POST /admin/upload)
const jobsUploadRoot = path.join(__dirname, '..', '..', 'data', 'uploads', 'jobs');
if (!fs.existsSync(jobsUploadRoot)) {
  fs.mkdirSync(jobsUploadRoot, { recursive: true });
}

const jobsStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, jobsUploadRoot),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const jobsUpload = multer({
  storage: jobsStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ──────────────────────────────────────────────────────────────
// T-J.1: POST /admin/login — Public (no auth middleware)
// ──────────────────────────────────────────────────────────────

router.post('/admin/login', express.json({ limit: '1mb' }), (req, res) => {
  const { token } = req.body || {};

  if (!token || !ADMIN_TOKEN) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid admin token.' },
    });
  }

  // Constant-time comparison to prevent timing attacks
  const tokenBuf = Buffer.from(String(token));
  const expectedBuf = Buffer.from(ADMIN_TOKEN);

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid admin token.' },
    });
  }

  // Set admin session cookie
  res.cookie(ADMIN_COOKIE_NAME, ADMIN_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
  });

  logger.info('Admin login successful');
  return res.redirect(302, '/admin');
});

// ──────────────────────────────────────────────────────────────
// GET /admin — Admin dashboard page (renders token form when session absent)
// ──────────────────────────────────────────────────────────────

router.get('/admin', (req, res) => {
  const adminToken = req.cookies && req.cookies[ADMIN_COOKIE_NAME];
  const isAdmin = adminToken && ADMIN_TOKEN &&
    adminToken.length === ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(ADMIN_TOKEN));

  if (!isAdmin) {
    return res.status(401).render('admin/dashboard', { isAdmin: false });
  }

  const lastRun = getLastAnalysisRun();
  const jobCounts = jobsRepo.getJobCounts();
  const fitStats = fitScoresRepo.getStats();
  const scraperRuns = scraperRunsRepo.getRecentRuns(20);

  // Source counts — map the bySource array into an object keyed by source name.
  // Covers linkedin/seek/apsjobs/actgov/nswgov; anything else bucketed as "other".
  const sourceCounts = { linkedin: 0, seek: 0, apsjobs: 0, actgov: 0, nswgov: 0, other: 0 };
  if (Array.isArray(jobCounts.bySource)) {
    for (const row of jobCounts.bySource) {
      const src = String(row.source || '').toLowerCase();
      if (src in sourceCounts) sourceCounts[src] = row.count;
      else sourceCounts.other += row.count;
    }
  }

  // Other dashboard stats that were previously only exposed via /admin/stats.
  const userCounts = {
    total: usersRepo.getCount(),
    with_resume: resumesRepo.countUsersWithResume(),
  };
  const coverLetterCount = coverLettersRepo.getCount();
  const dbSizeMb = getDbSizeMb();
  const sourceFreshness = scraperRunsRepo.getSourceFreshness();
  const platformHealth = scraperRunsRepo.getPlatformHealth();

  // Company research stats for admin dashboard (T-G.1)
  const allCompanies = companiesRepo.getAll();
  const totalCompanies = allCompanies.length;
  const unresearchedCount = allCompanies.filter(c => !c.description).length;

  res.render('admin/dashboard', {
    isAdmin: true,
    lastRun,
    jobCounts,
    fitStats,
    scraperRuns,
    sourceCounts,
    userCounts,
    coverLetterCount,
    dbSizeMb,
    sourceFreshness,
    platformHealth,
    totalCompanies,
    unresearchedCount,
  });
});

// ──────────────────────────────────────────────────────────────
// All remaining /admin routes require admin auth
// ──────────────────────────────────────────────────────────────

router.use('/admin', requireAdminRole);

// ──────────────────────────────────────────────────────────────
// T-J.1: GET /admin/stats — Dashboard statistics
// ──────────────────────────────────────────────────────────────

router.get('/admin/stats', (req, res) => {
  // Job counts with by_source breakdown
  const rawCounts = jobsRepo.getJobCounts();
  const bySourceMap = {
    linkedin: 0, seek: 0, apsjobs: 0, actgov: 0, nswgov: 0, manual: 0,
  };
  if (Array.isArray(rawCounts.bySource)) {
    for (const row of rawCounts.bySource) {
      const src = String(row.source).toLowerCase();
      if (src in bySourceMap) {
        bySourceMap[src] = row.count;
      } else {
        bySourceMap.manual += row.count;
      }
    }
  }

  const job_counts = {
    total: rawCounts.total,
    active: rawCounts.active,
    by_source: bySourceMap,
  };

  // User counts
  const userTotal = usersRepo.getCount();
  const user_counts = {
    total: userTotal,
    with_resume: resumesRepo.countUsersWithResume(),
  };

  // Score and cover letter counts
  const scoreStats = fitScoresRepo.getStats();
  const score_count = scoreStats.total;
  const cover_letter_count = coverLettersRepo.getCount();

  // DB size
  const db_size_mb = getDbSizeMb();

  // Source freshness
  const source_freshness = scraperRunsRepo.getSourceFreshness();

  // Platform health
  const platform_health = scraperRunsRepo.getPlatformHealth();

  res.json({
    job_counts,
    user_counts,
    score_count,
    cover_letter_count,
    db_size_mb,
    source_freshness,
    platform_health,
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.2: GET /admin/scraper/runs — Paginated scraper run history
// ──────────────────────────────────────────────────────────────

router.get('/admin/scraper/runs', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const result = scraperRunsRepo.getPaginatedRuns(page, 25);
  res.json(result);
});

// ──────────────────────────────────────────────────────────────
// T-J.2: POST /admin/scraper/run — Trigger single scraper
// Rate limit: 6 per hour global
// ──────────────────────────────────────────────────────────────

router.post('/admin/scraper/run', express.json({ limit: '1mb' }), (req, res) => {
  const { name, options } = req.body || {};

  // Validate platform name
  if (!name || !VALID_PLATFORMS.includes(name)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` },
    });
  }

  // Rate limit: 60 per hour global. Bumped from 6 to support orchestrated
  // multi-keyword sweeps (8 keywords × 5 sources = 40 triggers in <2 min).
  // The downstream queue is serial so we don't risk overwhelming scrapers
  // — each one still runs its full crawl one at a time.
  const recentCount = scraperRunsRepo.countRecentRuns(3600000);
  if (recentCount >= 60) {
    res.set('Retry-After', '3600');
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Scraper rate limit exceeded. Maximum 60 runs per hour.' },
    });
  }

  try {
    const result = triggerScrape(name, options || {});
    logger.info('Admin triggered scraper run', { runId: result.runId, platform: name });
    res.json({ runId: result.runId });
  } catch (err) {
    if (err && err.code === 'SCRAPER_ALREADY_RUNNING') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: err.message },
      });
    }
    if (err && err.code === 'INVALID_SCRAPER_OPTIONS') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }
    logger.error('Failed to trigger scraper', { error: err.message });
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ──────────────────────────────────────────────────────────────
// T-J.2: POST /admin/scraper/run-all — Trigger all scrapers
// ──────────────────────────────────────────────────────────────

router.post('/admin/scraper/run-all', express.json({ limit: '1mb' }), (req, res) => {
  const { options } = req.body || {};
  const runIds = {};

  try {
    for (const platform of VALID_PLATFORMS) {
      const result = triggerScrape(platform, options || {});
      runIds[platform] = result.runId;
    }

    logger.info('Admin triggered all scrapers', { runIds });
    res.json({ runIds });
  } catch (err) {
    if (err && err.code === 'SCRAPER_ALREADY_RUNNING') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: err.message },
      });
    }
    logger.error('Failed to trigger all scrapers', { error: err.message });
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ──────────────────────────────────────────────────────────────
// T-J.3: POST /admin/analysis/run — Trigger batch analysis
// ──────────────────────────────────────────────────────────────

router.post('/admin/analysis/run', express.json({ limit: '1mb' }), (req, res) => {
  const { type, config } = req.body || {};

  if (!type || !VALID_ANALYSIS_TYPES.includes(type)) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid analysis type. Must be one of: ${VALID_ANALYSIS_TYPES.join(', ')}`,
      },
    });
  }

  try {
    const runId = type === 'full'
      ? triggerFullAnalysis(config || {})
      : triggerAnalysis({ type, config: config || {} });

    logger.info('Admin triggered analysis run', { runId, type });
    res.json({ runId });
  } catch (err) {
    logger.error('Failed to trigger analysis', { error: err.message });
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ──────────────────────────────────────────────────────────────
// T-J.3: GET /admin/analysis/runs — Paginated analysis run history
// ──────────────────────────────────────────────────────────────

router.get('/admin/analysis/runs', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const result = analysisRunsRepo.getPaginatedRuns(page, 25);
  res.json(result);
});

// ──────────────────────────────────────────────────────────────
// T-J.3: GET /admin/queue/status — Background queue status (in-memory)
// ──────────────────────────────────────────────────────────────

router.get('/admin/queue/status', (req, res) => {
  const status = backgroundQueue.getStatus();
  res.json(status);
});

// ──────────────────────────────────────────────────────────────
// T-J.3: GET /admin/errors — Recent errors from ring buffer
// ──────────────────────────────────────────────────────────────

router.get('/admin/errors', (req, res) => {
  let limit = parseInt(req.query.limit, 10) || 50;
  limit = Math.min(Math.max(1, limit), 200);

  const errors = errorRingBuffer.getEntries(limit);
  res.json({
    errors,
    total: errorRingBuffer.total,
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: POST /admin/cleanup — Data retention cleanup
// ──────────────────────────────────────────────────────────────

router.post('/admin/cleanup', express.json({ limit: '1mb' }), (req, res) => {
  const { type } = req.body || {};
  const cleanupType = type || 'all';
  const validTypes = ['raw_json', 'inactive', 'sessions', 'notifications', 'all'];

  if (!validTypes.includes(cleanupType)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `Invalid cleanup type. Must be one of: ${validTypes.join(', ')}` },
    });
  }

  let raw_json_cleared = 0;
  let archived_jobs = 0;
  let sessions_cleaned = 0;
  let notifications_cleaned = 0;
  let optimization_suggestions_cleaned = 0;

  if (cleanupType === 'raw_json' || cleanupType === 'all') {
    raw_json_cleared = jobsRepo.clearRawJsonOlderThan(30);
  }

  if (cleanupType === 'inactive' || cleanupType === 'all') {
    archived_jobs = jobsRepo.archiveInactive(90);
  }

  if (cleanupType === 'sessions' || cleanupType === 'all') {
    sessions_cleaned = sessionsRepo.deleteExpired();
  }

  if (cleanupType === 'notifications' || cleanupType === 'all') {
    const notificationsRepo = require('../repositories/notificationsRepo');
    notifications_cleaned = notificationsRepo.deleteOlderThan(90);
  }

  if (cleanupType === 'all') {
    optimization_suggestions_cleaned = optimizationSuggestionsRepo.deleteOlderThan(30);
  }

  logger.info('Admin cleanup completed', { type: cleanupType, raw_json_cleared, archived_jobs, sessions_cleaned, notifications_cleaned, optimization_suggestions_cleaned });

  res.json({
    raw_json_cleared,
    archived_jobs,
    sessions_cleaned,
    notifications_cleaned,
    optimization_suggestions_cleaned,
  });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: POST /admin/upload — Upload jobs JSON
// ──────────────────────────────────────────────────────────────

// HTML sanitization for job descriptions
const SANITIZE_OPTIONS = {
  allowedTags: ['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['https'],
  disallowedTagsMode: 'discard',
};

function validateAndMapJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.title || typeof raw.title !== 'string') return null;

  return {
    external_id: raw.external_id || null,
    source: raw.source || 'manual',
    role: raw.role || 'general',
    title: String(raw.title).slice(0, 500),
    company_name: raw.company_name || raw.company || null,
    location: raw.location || null,
    work_type: raw.work_type || null,
    salary: raw.salary || null,
    salary_min: raw.salary_min || null,
    salary_max: raw.salary_max || null,
    description: sanitizeHtml(raw.description || '', SANITIZE_OPTIONS),
    url: raw.url || null,
    posted_at: raw.posted_at || null,
    closes_at: raw.closes_at || null,
    raw_json: JSON.stringify(raw),
    scraped_at: new Date().toISOString(),
  };
}

router.post('/admin/upload', express.json({ limit: '10mb' }), (req, res) => {
  const payload = req.body;
  const jobsArray = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.jobs)
      ? payload.jobs
      : null;

  if (!jobsArray) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON array of jobs or { jobs: [...] }.' },
    });
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches of 50
  const BATCH_SIZE = 50;
  for (let i = 0; i < jobsArray.length; i += BATCH_SIZE) {
    const batch = jobsArray.slice(i, i + BATCH_SIZE);
    const mapped = [];

    for (const raw of batch) {
      const job = validateAndMapJob(raw);
      if (job) {
        mapped.push(job);
      } else {
        errors++;
      }
    }

    if (mapped.length > 0) {
      try {
        jobsRepo.upsertManyJobs(mapped);
        imported += mapped.length;
      } catch (err) {
        logger.error('Failed to upsert job batch', { error: err.message, batchIndex: i });
        errors += mapped.length;
      }
    }
  }

  skipped = jobsArray.length - imported - errors;

  logger.info('Admin upload completed', { imported, skipped, errors });
  res.json({ imported, skipped, errors });
});

// Also support file upload via multipart form
router.post('/admin/jobs/upload', jobsUpload.single('jobFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Please upload a JSON file containing job data.' },
    });
  }

  let raw;
  try {
    raw = fs.readFileSync(req.file.path, 'utf8');
  } catch (err) {
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to read uploaded file.' },
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Uploaded file is not valid JSON.' },
    });
  }

  const jobsArray = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.jobs)
      ? payload.jobs
      : null;

  if (!jobsArray) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'JSON must be an array of jobs or { jobs: [...] }.' },
    });
  }

  let imported = 0;
  let errors = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < jobsArray.length; i += BATCH_SIZE) {
    const batch = jobsArray.slice(i, i + BATCH_SIZE);
    const mapped = [];
    for (const item of batch) {
      const job = validateAndMapJob(item);
      if (job) mapped.push(job);
      else errors++;
    }
    if (mapped.length > 0) {
      try {
        jobsRepo.upsertManyJobs(mapped);
        imported += mapped.length;
      } catch (err) {
        logger.error('Failed to upsert file upload batch', { error: err.message });
        errors += mapped.length;
      }
    }
  }

  logger.info('Admin file upload completed', { imported, errors });
  res.json({ imported, skipped: 0, errors });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: POST /admin/dedup/run — Trigger deduplication
// ──────────────────────────────────────────────────────────────

backgroundQueue.registerHandler('dedup', async () => {
  return detectDuplicates();
});

router.post('/admin/dedup/run', (req, res) => {
  const jobCount = jobsRepo.countActiveNonDuplicate();

  backgroundQueue.enqueue('dedup', {}, { description: 'Deduplication run' });

  logger.info('Admin triggered deduplication', { jobCount });
  res.json({ status: 'queued', job_count: jobCount });
});

// ──────────────────────────────────────────────────────────────
// POST /admin/embeddings/run — Batch-embed all jobs missing vectors
// ──────────────────────────────────────────────────────────────
// Handler is self-registered by embeddingService on server boot.
router.post('/admin/embeddings/run', (req, res) => {
  const missing = jobsRepo.getJobsMissingEmbedding(100000).length;
  backgroundQueue.enqueue('embed-jobs', {}, {
    description: `Backfill embeddings for ${missing} jobs`,
  });
  logger.info('Admin triggered embedding backfill', { missing });
  res.json({ status: 'queued', missing });
});

// ──────────────────────────────────────────────────────────────
// POST /admin/extract-skills/run — LLM-extract required skills per job
// Body: { effort?: 'minimal'|'low'|'medium'|'high'|'xhigh' } (default medium)
// ──────────────────────────────────────────────────────────────
router.post('/admin/extract-skills/run', express.json({ limit: '1mb' }), (req, res) => {
  const effort = req.body && req.body.effort;
  const missing = jobsRepo.getJobsMissingRequiredSkills(100000).length;
  backgroundQueue.enqueue('extract-job-skills', { effort }, {
    description: `Extract required skills for ${missing} jobs (effort=${effort || 'medium'})`,
  });
  logger.info('Admin triggered skill extraction', { missing, effort });
  res.json({ status: 'queued', missing, effort: effort || 'medium' });
});

// ──────────────────────────────────────────────────────────────
// POST /admin/embed-skills/run — Embed every unique skill name in use
// (job required_skills + resume skills) into the global cache table.
// ──────────────────────────────────────────────────────────────
router.post('/admin/embed-skills/run', (req, res) => {
  backgroundQueue.enqueue('embed-skills', {}, {
    description: 'Backfill skill-vocabulary embeddings for semantic keyword match',
  });
  logger.info('Admin triggered skill-embed backfill');
  res.json({ status: 'queued' });
});

// ──────────────────────────────────────────────────────────────
// T-J.4: GET /admin/dedup/groups — List duplicate groups (paginated)
// ──────────────────────────────────────────────────────────────

router.get('/admin/dedup/groups', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const result = duplicateGroupsRepo.getPaginatedGroups(page, 20);
  res.json(result);
});

// ──────────────────────────────────────────────────────────────
// T-J.4: POST /admin/dedup/resolve — Resolve duplicate group
// ──────────────────────────────────────────────────────────────

router.post('/admin/dedup/resolve', express.json({ limit: '1mb' }), (req, res) => {
  const { group_id, canonical_job_id, action } = req.body || {};

  if (!group_id || !action) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'group_id and action are required.' },
    });
  }

  if (!['merge', 'split'].includes(action)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'action must be "merge" or "split".' },
    });
  }

  const group = duplicateGroupsRepo.findById(group_id);
  if (!group) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Duplicate group not found.' },
    });
  }

  if (action === 'merge') {
    if (!canonical_job_id) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'canonical_job_id is required for merge action.' },
      });
    }
    duplicateGroupsRepo.mergeGroup(group_id, canonical_job_id);
    logger.info('Admin merged duplicate group', { group_id, canonical_job_id });
  } else {
    // split: delete group and unmark members
    duplicateGroupsRepo.dismissGroup(group_id);
    logger.info('Admin split duplicate group', { group_id });
  }

  res.json({ resolved: true, action, group_id });
});

// ──────────────────────────────────────────────────────────────
// T-F.1: POST /admin/company-research/run — Trigger batch company research
// ──────────────────────────────────────────────────────────────

backgroundQueue.registerHandler('company-research', async (params) => {
  await companyService.batchResearchCompanies({ onProgress: params.onProgress });
});

router.post('/admin/company-research/run', batchCompanyResearchLimiter, (req, res) => {
  const allCompanies = companiesRepo.getAll();
  const unresearched = allCompanies.filter(c => !c.description || c.description.trim() === '');

  if (unresearched.length === 0) {
    return res.redirect(302, '/admin?flash=' + encodeURIComponent('All companies already researched.'));
  }

  backgroundQueue.enqueue('company-research', {}, {
    description: `Batch company research: ${unresearched.length} companies`,
  });

  logger.info('Admin triggered batch company research', { count: unresearched.length });
  res.redirect(302, '/admin?flash=' + encodeURIComponent(`Batch company research started. Processing ${unresearched.length} companies.`));
});

// ──────────────────────────────────────────────────────────────
// Legacy: GET /admin/scraper/runs/:id
// ──────────────────────────────────────────────────────────────

router.get('/admin/scraper/runs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid run ID.' } });
  }
  const run = scraperRunsRepo.getRunById(id);
  if (!run) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found.' } });
  }
  res.json({ run });
});

module.exports = router;
