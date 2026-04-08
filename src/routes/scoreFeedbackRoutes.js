const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { create, findById, findByUserAndJob } = require('../repositories/scoreFeedbackRepo');
const { getJobById } = require('../repositories/jobsRepo');
const { getPrimaryResume } = require('../services/resumeService');
const { getResumeByIdAndUser } = require('../repositories/resumesRepo');
const { AppError } = require('../utils/errors');
const { getLogger } = require('../logger');

const logger = getLogger('scoreFeedbackRoutes');
const router = express.Router();

const VALID_FEEDBACK_TYPES = ['helpful', 'not_helpful'];

/**
 * POST /jobs/:id/score-feedback — submit feedback on match score
 * Body: { feedback_type, comment }
 */
router.post('/jobs/:id/score-feedback', requireAuth, (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = getJobById(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const { feedback_type, comment } = req.body;

  if (!feedback_type || !VALID_FEEDBACK_TYPES.includes(feedback_type)) {
    return res.status(400).json({
      error: 'Invalid feedback_type. Must be one of: ' + VALID_FEEDBACK_TYPES.join(', '),
    });
  }

  // Check if user already submitted feedback for this job
  const existing = findByUserAndJob(req.user.id, jobId);
  if (existing) {
    return res.status(409).json({ error: 'Feedback already submitted for this job' });
  }

  const resume = getPrimaryResume();
  const resumeId = resume ? resume.id : null;

  try {
    const id = create({
      user_id: req.user.id,
      job_id: jobId,
      resume_id: resumeId,
      feedback_type,
      comment: comment || null,
    });

    logger.info('Score feedback submitted', {
      feedbackId: id,
      jobId,
      userId: req.user.id,
      feedbackType: feedback_type,
    });

    res.status(201).json({ id, feedback_type });
  } catch (err) {
    logger.error('Failed to submit score feedback', { jobId, error: err.message });
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ─── API routes ──────────────────────────────────────────────────────

const API_VALID_FEEDBACK_TYPES = ['too_high', 'too_low', 'irrelevant', 'helpful'];

/**
 * POST /api/score-feedback — submit feedback on match score (API)
 */
router.post('/api/score-feedback', requireAuth, express.json(), (req, res) => {
  const { job_id, resume_id, feedback_type, comment } = req.body;

  if (!job_id || !Number.isFinite(Number(job_id))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'job_id is required' } });
  }
  if (!resume_id || !Number.isFinite(Number(resume_id))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'resume_id is required' } });
  }
  if (!feedback_type || !API_VALID_FEEDBACK_TYPES.includes(feedback_type)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'feedback_type must be one of: ' + API_VALID_FEEDBACK_TYPES.join(', ') },
    });
  }

  // Verify resume ownership
  const resume = getResumeByIdAndUser(Number(resume_id), req.user.id);
  if (!resume) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume not found or not owned by user' } });
  }

  try {
    const lastId = create({
      user_id: req.user.id,
      job_id: Number(job_id),
      resume_id: Number(resume_id),
      feedback_type,
      comment: comment || null,
    });

    // Get the created record
    const record = findById(lastId);

    logger.info('API score feedback submitted', {
      feedbackId: lastId,
      jobId: job_id,
      userId: req.user.id,
      feedbackType: feedback_type,
    });

    res.status(201).json({
      feedback: {
        id: record.id,
        job_id: record.job_id,
        resume_id: record.resume_id,
        feedback_type: record.feedback_type,
        comment: record.comment,
        created_at: record.created_at,
      },
    });
  } catch (err) {
    logger.error('API failed to submit score feedback', { jobId: job_id, error: err.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to submit feedback' } });
  }
});

module.exports = router;
