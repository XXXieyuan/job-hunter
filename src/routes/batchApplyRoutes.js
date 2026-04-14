'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { EventEmitter } = require('events');
const { requireAuth, csrfProtection } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const applicationProfilesRepo = require('../repositories/applicationProfilesRepo');
const batchApplyRepo = require('../repositories/batchApplyRepo');
const resumesRepo = require('../repositories/resumesRepo');
const coverLettersRepo = require('../repositories/coverLettersRepo');
const jobsRepo = require('../repositories/jobsRepo');
const batchApplyService = require('../services/batchApplyService');
const { getLogger } = require('../logger');

const logger = getLogger('batchApplyRoutes');
const router = Router();

// --- Zod schemas ---

const profileSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  phone: z.string().regex(/^[\d\s\-+]{8,15}$/),
  visa_status: z.enum(['Australian Citizen', 'Permanent Resident', 'Temporary Visa']),
  work_rights: z.enum(['Unrestricted', 'Restricted — requires sponsorship']),
  expected_salary: z.string().max(50).optional().default(''),
  notice_period: z.string().max(50).optional().default(''),
});

const jobIdsSchema = z.object({
  jobIds: z.preprocess(
    (val) => (Array.isArray(val) ? val : [val]),
    z.array(z.coerce.number().int().positive()).min(1).max(10)
  ),
}).transform((body) => ({ jobIds: [...new Set(body.jobIds)] }));

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

const paramIdSchema = z.coerce.number().int().positive();

// --- Rate limiters ---

const profileLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  scope: 'user',
  prefix: 'ba-profile',
  errorShape: 'flat',
});

const preflightLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  scope: 'user',
  prefix: 'ba-preflight',
  errorShape: 'flat',
});

const startLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  scope: 'user',
  prefix: 'ba-start',
  errorShape: 'flat',
});

const skipLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  scope: 'user',
  prefix: 'ba-skip',
  errorShape: 'flat',
});

const cancelLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  scope: 'user',
  prefix: 'ba-cancel',
  errorShape: 'flat',
});

const sseLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  scope: 'user',
  prefix: 'ba-sse',
  errorShape: 'flat',
});

// --- SSE emitter registry (sessionId → EventEmitter) ---

const sseEmitters = new Map();

function getOrCreateEmitter(sessionId) {
  if (!sseEmitters.has(sessionId)) {
    sseEmitters.set(sessionId, new EventEmitter());
  }
  return sseEmitters.get(sessionId);
}

// --- Seek URL pattern ---

const SEEK_URL_PATTERN = /^https:\/\/www\.seek\.com\.au\/job\//;

// --- Routes ---

// 1. GET /batch-apply/profile
router.get('/batch-apply/profile', requireAuth, (req, res) => {
  const profile = applicationProfilesRepo.getByUserId(req.user.id);
  const flash = {};
  if (req.query.success) flash.success = req.query.success;
  if (req.query.error) flash.error = req.query.error;
  res.render('batch-apply/profile', { profile, flash });
});

// 2. POST /batch-apply/profile
router.post('/batch-apply/profile', requireAuth, csrfProtection, profileLimiter, (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = res.locals.t('batchApply.profile.validationError', 'Invalid profile data. Please check your entries.');
    return res.redirect('/batch-apply/profile?error=' + encodeURIComponent(msg));
  }

  applicationProfilesRepo.upsert(req.user.id, parsed.data);

  const msg = res.locals.t('batchApply.profile.saved', 'Application profile saved.');
  return res.redirect('/batch-apply/profile?success=' + encodeURIComponent(msg));
});

// 3. POST /batch-apply/preflight
router.post('/batch-apply/preflight', requireAuth, csrfProtection, preflightLimiter, (req, res) => {
  const parsed = jobIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const { jobIds } = parsed.data;
  const resume = resumesRepo.getConfirmedResumeForUser(req.user.id);
  if (!resume) {
    return res.status(400).json({ error: 'No confirmed resume found' });
  }

  const jobsMissingCoverLetter = [];
  for (const jobId of jobIds) {
    const cl = coverLettersRepo.getCoverLetter(jobId, resume.id);
    if (!cl) {
      jobsMissingCoverLetter.push(jobId);
    }
  }

  return res.json({ jobsMissingCoverLetter });
});

// 4. POST /batch-apply/start
router.post('/batch-apply/start', requireAuth, csrfProtection, startLimiter, (req, res) => {
  const parsed = jobIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.redirect('/jobs?error=' + encodeURIComponent('Invalid job selection.'));
  }

  const { jobIds } = parsed.data;
  const t = res.locals.t;

  // Validation 1: profile must exist
  const profile = applicationProfilesRepo.getByUserId(req.user.id);
  if (!profile) {
    const msg = t('batchApply.profile.configureFirst', 'Configure your application profile before starting a batch apply.');
    return res.redirect('/jobs?error=' + encodeURIComponent(msg));
  }

  // Validation 2: confirmed resume must exist
  const resume = resumesRepo.getConfirmedResumeForUser(req.user.id);
  if (!resume) {
    const msg = t('batchApply.profile.uploadResume', 'Upload and confirm a resume before starting a batch apply.');
    return res.redirect('/jobs?error=' + encodeURIComponent(msg));
  }

  // Validation 3: all jobs must be valid Seek jobs
  for (const jobId of jobIds) {
    const job = jobsRepo.getJobById(jobId);
    if (!job || job.source !== 'seek' || !job.url || !SEEK_URL_PATTERN.test(job.url)) {
      return res.redirect('/jobs?error=' + encodeURIComponent('One or more selected jobs are not valid Seek listings.'));
    }
  }

  // Validation 4: no active session
  const activeSession = batchApplyRepo.getActiveSession(req.user.id);
  if (activeSession) {
    const msg = t('batchApply.progress.sessionActive', 'A batch apply session is already in progress.');
    return res.redirect('/jobs?error=' + encodeURIComponent(msg));
  }

  // Build cover letter IDs array (aligned with jobIds)
  const coverLetterIds = jobIds.map((jobId) => {
    const cl = coverLettersRepo.getCoverLetter(jobId, resume.id);
    return cl ? cl.id : null;
  });

  // Create session + jobs in transaction
  const sessionId = batchApplyRepo.createSessionWithJobs(
    { userId: req.user.id, totalJobs: jobIds.length },
    jobIds,
    resume.id,
    coverLetterIds
  );

  return res.redirect(`/batch-apply/progress/${sessionId}`);
});

// 5. GET /batch-apply/progress/:sessionId
router.get('/batch-apply/progress/:sessionId', requireAuth, (req, res) => {
  const sessionId = paramIdSchema.safeParse(req.params.sessionId);
  if (!sessionId.success) {
    return res.status(404).render('errors/404', {
      statusCode: 404,
      message: 'Session not found.',
    });
  }

  const session = batchApplyRepo.getSession(sessionId.data);
  if (!session) {
    return res.status(404).render('errors/404', {
      statusCode: 404,
      message: 'Session not found.',
    });
  }

  if (session.user_id !== req.user.id) {
    return res.status(403).render('errors/500', {
      statusCode: 403,
      message: 'Access denied.',
    });
  }

  const jobs = batchApplyRepo.getSessionJobs(sessionId.data);
  res.render('batch-apply/progress', { session, jobs });
});

// 6. GET /batch-apply/progress/:sessionId/events (SSE)
router.get('/batch-apply/progress/:sessionId/events', requireAuth, sseLimiter, (req, res) => {
  const sessionId = paramIdSchema.safeParse(req.params.sessionId);
  if (!sessionId.success) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const session = batchApplyRepo.getSession(sessionId.data);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Set SSE headers
  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache');
  res.set('Connection', 'keep-alive');
  res.flushHeaders();

  // If session already completed/cancelled, send single event and close
  if (session.status === 'completed') {
    const s = batchApplyRepo.getSession(sessionId.data);
    res.write(`event: batch-complete\ndata: ${JSON.stringify({ summary: { applied: s.applied_count, failed: s.failed_count, skipped: s.skipped_count } })}\n\n`);
    return res.end();
  }
  if (session.status === 'cancelled') {
    res.write(`event: batch-cancelled\ndata: ${JSON.stringify({})}\n\n`);
    return res.end();
  }

  // Subscribe to SSE emitter
  const emitter = getOrCreateEmitter(sessionId.data);

  const onSse = (payload) => {
    res.write(`event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    if (payload.event === 'batch-complete' || payload.event === 'batch-cancelled') {
      res.end();
    }
  };

  emitter.on('sse', onSse);

  // Trigger execution on first connection for pending sessions
  if (session.status === 'pending' && !batchApplyService.isExecuting(sessionId.data)) {
    batchApplyService.executeBatch(sessionId.data, emitter).catch((err) => {
      logger.error('executeBatch error', { sessionId: sessionId.data, error: err.message });
    });
  }

  // Clean up on client disconnect
  req.on('close', () => {
    emitter.removeListener('sse', onSse);
    // Clean up emitter if no more listeners
    if (emitter.listenerCount('sse') === 0) {
      sseEmitters.delete(sessionId.data);
    }
  });
});

// 7. POST /batch-apply/skip/:sessionId/:jobId
router.post('/batch-apply/skip/:sessionId/:jobId', requireAuth, csrfProtection, skipLimiter, (req, res) => {
  const sessionIdParsed = paramIdSchema.safeParse(req.params.sessionId);
  const jobIdParsed = paramIdSchema.safeParse(req.params.jobId);

  if (!sessionIdParsed.success || !jobIdParsed.success) {
    return res.status(404).json({ error: 'Not found' });
  }

  const session = batchApplyRepo.getSession(sessionIdParsed.data);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (session.status !== 'in-progress') {
    return res.status(409).json({ error: 'Session is not in progress' });
  }

  // Find the job in session jobs
  const jobs = batchApplyRepo.getSessionJobs(sessionIdParsed.data);
  const job = jobs.find((j) => j.id === jobIdParsed.data);

  if (!job) {
    return res.status(404).json({ error: 'Job not found in session' });
  }

  if (job.status !== 'awaiting-submit' && job.status !== 'in-progress') {
    return res.status(409).json({ error: 'Job is not in a skippable state' });
  }

  batchApplyService.requestSkip(sessionIdParsed.data, jobIdParsed.data);
  return res.json({ ok: true });
});

// 8. POST /batch-apply/cancel/:sessionId
router.post('/batch-apply/cancel/:sessionId', requireAuth, csrfProtection, cancelLimiter, (req, res) => {
  const sessionIdParsed = paramIdSchema.safeParse(req.params.sessionId);
  if (!sessionIdParsed.success) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const session = batchApplyRepo.getSession(sessionIdParsed.data);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (session.status !== 'in-progress') {
    return res.status(409).json({ error: 'Session is not in progress' });
  }

  batchApplyService.requestCancel(sessionIdParsed.data);
  return res.json({ ok: true });
});

// 9. GET /batch-apply/history
router.get('/batch-apply/history', requireAuth, (req, res) => {
  const parsed = pageSchema.safeParse(req.query);
  const page = parsed.success ? parsed.data.page : 1;

  const sessions = batchApplyRepo.getSessionsByUser(req.user.id, { page, limit: 10 });
  const totalSessions = batchApplyRepo.countSessionsByUser(req.user.id);
  const totalPages = Math.ceil(totalSessions / 10) || 1;

  res.render('batch-apply/history', {
    sessions,
    pagination: { page, totalPages, totalSessions },
  });
});

// --- Readiness middleware (for GET /jobs) ---

/**
 * Sets res.locals._hasApplicationProfile and res.locals._hasConfirmedResume
 * for authenticated users. These flags control batch-apply UI elements on the job listing.
 */
function batchApplyReadiness(req, res, next) {
  if (!req.user) {
    res.locals._hasApplicationProfile = false;
    res.locals._hasConfirmedResume = false;
    return next();
  }

  try {
    res.locals._hasApplicationProfile = Boolean(applicationProfilesRepo.getByUserId(req.user.id));
    res.locals._hasConfirmedResume = Boolean(resumesRepo.getConfirmedResumeForUser(req.user.id));
  } catch (err) {
    logger.warn('batchApplyReadiness error', { error: err.message });
    res.locals._hasApplicationProfile = false;
    res.locals._hasConfirmedResume = false;
  }
  next();
}

module.exports = router;
module.exports.batchApplyReadiness = batchApplyReadiness;
module.exports.profileSchema = profileSchema;
module.exports.jobIdsSchema = jobIdsSchema;
module.exports.pageSchema = pageSchema;
