const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const { getJobById } = require('../repositories/jobsRepo');
const { getBestFitScoreForJob } = require('../repositories/fitScoresRepo');
const { getCoverLetter, getCoverLetterById, updateUserEditedContent, getCoverLettersForJobAndResume } = require('../repositories/coverLettersRepo');
const { getCompanyByName } = require('../repositories/companiesRepo');
const { getPrimaryResume } = require('../services/resumeService');
const { generateAndStore, isApsRole, getRecommendedModes, MODES } = require('../services/coverLetterService');
const { getConfirmedResumeForUser } = require('../repositories/resumesRepo');
const { AppError } = require('../utils/errors');
const { getLogger } = require('../logger');

const logger = getLogger('coverLetterRoutes');
const router = express.Router();

/**
 * POST /jobs/:id/cover-letter — generate a cover letter
 * Body: { resumeId, mode, language }
 */
router.post('/jobs/:id/cover-letter', requireAuth, rateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Cover letter generation limit reached (10 per hour). Please try again later.' }), async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = getJobById(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Determine mode from params
  let { mode, language } = req.body;

  // If language is provided but no explicit mode, derive mode from language
  if (!mode && language) {
    mode = language === 'zh' ? 'chinese_cover_letter' : 'english_cover_letter';
  }

  // Default mode
  if (!mode) {
    mode = 'english_cover_letter';
  }

  // Validate mode
  if (!MODES[mode]) {
    return res.status(400).json({
      error: 'Invalid mode. Valid modes: ' + Object.keys(MODES).join(', '),
    });
  }

  // Get resume
  const resume = getPrimaryResume();
  if (!resume) {
    return res.status(400).json({ error: 'No resume uploaded. Please upload a resume first.' });
  }

  // Get score breakdown if available
  let scoreBreakdown = null;
  const fit = getBestFitScoreForJob(jobId);
  if (fit && fit.breakdown_json) {
    try {
      scoreBreakdown = JSON.parse(fit.breakdown_json);
    } catch { /* ignore */ }
  }

  // Get company data if available
  const company = job.company_name ? getCompanyByName(job.company_name) : null;

  try {
    const result = await generateAndStore({
      mode,
      job,
      resume,
      scoreBreakdown,
      company,
      user_id: req.user.id,
    });

    if (!result.content) {
      return res.status(503).json({ error: 'AI service unavailable. Please check API key configuration.' });
    }

    logger.info('Cover letter generated via route', {
      jobId,
      mode,
      coverLetterId: result.id,
      userId: req.user.id,
    });

    res.status(201).json({
      id: result.id,
      content: result.content,
      mode,
      language: MODES[mode].language,
    });
  } catch (err) {
    logger.error('Cover letter generation failed', { jobId, mode, error: err.message });
    res.status(500).json({ error: 'Failed to generate cover letter' });
  }
});

/**
 * GET /jobs/:id/cover-letter — get existing cover letter(s)
 * Query: ?mode=english_cover_letter&language=en
 */
router.get('/jobs/:id/cover-letter', requireAuth, (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const resume = getPrimaryResume();
  if (!resume) {
    return res.status(400).json({ error: 'No resume uploaded' });
  }

  const language = req.query.language || 'en';
  const mode = req.query.mode || (language === 'zh' ? 'chinese_cover_letter' : 'english_cover_letter');

  const coverLetter = getCoverLetter(jobId, resume.id, language, mode);
  if (!coverLetter) {
    return res.status(404).json({ error: 'No cover letter found for this job and mode' });
  }

  res.json({
    id: coverLetter.id,
    content: coverLetter.user_edited_content || coverLetter.content,
    original_content: coverLetter.content,
    mode: coverLetter.mode,
    language: coverLetter.language,
    updated_at: coverLetter.updated_at,
  });
});

/**
 * PUT /cover-letters/:id — update edited content
 * Body: { content }
 */
router.put('/cover-letters/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid cover letter ID' });
  }

  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content is required' });
  }

  const existing = getCoverLetterById(id, req.user.id);
  if (!existing) {
    return res.status(404).json({ error: 'Cover letter not found' });
  }

  try {
    updateUserEditedContent(id, req.user.id, content);
    logger.info('Cover letter edited', { coverLetterId: id, userId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update cover letter', { id, error: err.message });
    res.status(500).json({ error: 'Failed to update cover letter' });
  }
});

/**
 * GET /jobs/:id/cover-letter-modes — get recommended modes for a job
 */
router.get('/jobs/:id/cover-letter-modes', requireAuth, (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = getJobById(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const modes = getRecommendedModes(job);
  const isAps = isApsRole(job);

  res.json({ modes, isAps });
});

// ─── API routes ──────────────────────────────────────────────────────

/**
 * GET /api/cover-letters — list cover letters for a job+resume pair
 */
router.get('/api/cover-letters', requireAuth, (req, res) => {
  const jobId = Number(req.query.job_id);
  if (!req.query.job_id || !Number.isFinite(jobId)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'job_id query parameter is required' } });
  }

  let resumeId = req.query.resume_id ? Number(req.query.resume_id) : null;
  if (!resumeId) {
    const resume = getConfirmedResumeForUser(req.user.id);
    if (!resume) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No confirmed resume found. Provide resume_id or confirm a resume.' } });
    }
    resumeId = resume.id;
  }

  const rows = getCoverLettersForJobAndResume(jobId, resumeId);
  res.json({
    cover_letters: rows.map((r) => ({
      id: r.id,
      language: r.language,
      mode: r.mode,
      content: r.content,
      user_edited_content: r.user_edited_content,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

/**
 * POST /api/cover-letters — generate a new cover letter
 */
router.post('/api/cover-letters', requireAuth, express.json(), rateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Cover letter generation limit reached (10 per hour).' }), async (req, res) => {
  const { job_id, resume_id: bodyResumeId, language, mode } = req.body;

  if (!job_id || !Number.isFinite(Number(job_id))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'job_id is required' } });
  }
  if (language !== 'en') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'language must be "en"' } });
  }
  if (!['standard', 'aps_selection_criteria'].includes(mode)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'mode must be "standard" or "aps_selection_criteria"' } });
  }

  let resumeId = bodyResumeId ? Number(bodyResumeId) : null;
  if (!resumeId) {
    const resume = getConfirmedResumeForUser(req.user.id);
    if (!resume) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No confirmed resume found. Provide resume_id or confirm a resume.' } });
    }
    resumeId = resume.id;
  }

  const jobId = Number(job_id);
  const job = getJobById(jobId);
  if (!job) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
  }

  // Map API mode to internal mode
  const internalMode = mode === 'aps_selection_criteria' ? 'aps_selection_criteria' : 'english_cover_letter';

  let scoreBreakdown = null;
  const fit = getBestFitScoreForJob(jobId);
  if (fit && fit.breakdown_json) {
    try { scoreBreakdown = JSON.parse(fit.breakdown_json); } catch { /* ignore */ }
  }

  const company = job.company_name ? getCompanyByName(job.company_name) : null;

  try {
    const result = await generateAndStore({
      mode: internalMode,
      job,
      resume: { id: resumeId },
      scoreBreakdown,
      company,
      user_id: req.user.id,
    });

    if (!result.content) {
      return res.status(503).json({ error: { code: 'INTERNAL_ERROR', message: 'AI service unavailable' } });
    }

    logger.info('API cover letter generated', { jobId, mode: internalMode, coverLetterId: result.id, userId: req.user.id });

    res.status(201).json({
      cover_letter: {
        id: result.id,
        job_id: jobId,
        resume_id: resumeId,
        language: 'en',
        mode,
        content: result.content,
        user_edited_content: null,
        created_at: result.created_at || new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('API cover letter generation failed', { jobId, mode, error: err.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate cover letter' } });
  }
});

/**
 * PUT /api/cover-letters/:id — update user-edited content
 */
router.put('/api/cover-letters/:id', requireAuth, express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid cover letter ID' } });
  }

  const { user_edited_content } = req.body;

  const existing = getCoverLetterById(id, req.user.id);
  if (!existing) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Cover letter not found' } });
  }

  try {
    updateUserEditedContent(id, req.user.id, user_edited_content);
    logger.info('API cover letter edited', { coverLetterId: id, userId: req.user.id });
    res.json({
      cover_letter: {
        id,
        user_edited_content,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('API failed to update cover letter', { id, error: err.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update cover letter' } });
  }
});

module.exports = router;
