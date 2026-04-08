const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { validateFileType, validateDocxOnly } = require('../middleware/fileValidator');
const {
  getAllResumes,
  getResumeById,
  getResumesByUser,
  getResumeByIdAndUser,
  updateExtractedData,
  getConfirmedResumeForUser,
  deleteResume,
  updateEmbedding,
} = require('../repositories/resumesRepo');
const {
  createResumeFromUpload,
  deleteResumeWithFile,
  setMainResume,
  confirmResume,
} = require('../services/resumeService');
const { getActiveJobIds } = require('../repositories/jobsRepo');
const backgroundQueue = require('../services/backgroundQueue');
const { AppError } = require('../utils/errors');
const { rateLimiter } = require('../middleware/rateLimiter');
const { requireAuth } = require('../middleware/auth');
const { validateResumeUpdate } = require('../middleware/validators');
const { generateEmbedding } = require('../services/openAIClient');
const { buildResumeEmbeddingText } = require('../services/scoringService');
const { getLogger } = require('../logger');

const logger = getLogger('resumeRoutes');

const router = express.Router();

// Multer storage for resumes under data/uploads/resumes
const uploadsRoot = path.join(__dirname, '..', '..', 'data', 'uploads', 'resumes');

if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsRoot);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per DESIGN.md spec
  },
});

// GET /resumes — render manage page (requireAuth)
router.get('/resumes', requireAuth, (req, res) => {
  let resumes;
  try {
    // Try user-scoped query first, fall back to all resumes
    resumes = typeof getResumesByUser === 'function'
      ? getResumesByUser(req.user.id)
      : getAllResumes();
  } catch (e) {
    resumes = getAllResumes();
  }
  res.render('resumes/manage', { resumes });
});

// GET /resumes/:id — resume detail JSON (for AJAX)
router.get('/resumes/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid resume ID' });
  }

  const resume = getResumeById(id);
  if (!resume) {
    return res.status(404).json({ error: 'Resume not found' });
  }

  // Parse JSON fields safely
  let skills = [];
  try { skills = JSON.parse(resume.skills_json || '[]'); } catch (e) { skills = []; }
  let experience = [];
  try { experience = JSON.parse(resume.experience_json || '[]'); } catch (e) { experience = []; }
  let education = [];
  try { education = JSON.parse(resume.education_json || '[]'); } catch (e) { education = []; }

  // Return JSON for AJAX consumers; HTML accept gets the manage page
  if (req.accepts('json') && !req.accepts('html')) {
    return res.json({
      resume,
      skills,
      experience,
      education,
    });
  }

  // Fallback: render detail view
  res.render('resumes/detail', {
    resume,
    skills,
    experience,
    education,
  });
});

// POST /resumes/upload — handle file upload (multer)
router.post('/resumes/upload', requireAuth, upload.single('resume'), validateFileType(['pdf', 'docx']), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('Please select a resume file to upload.');
  }

  try {
    await createResumeFromUpload(req.file, req.user ? req.user.id : null);
    return res.redirect('/resumes');
  } catch (err) {
    logger.error('Failed to process uploaded resume', {
      err,
      fileSize: req.file.size,
      mimetype: req.file.mimetype,
    });
    return res.status(500).send('Failed to process resume file. Please try again.');
  }
});

// GET /resumes/:id/confirm — show confirm/review page
router.get('/resumes/:id/confirm', requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return next(new AppError('NOT_FOUND', 'Resume not found'));
  }

  const resume = req.user
    ? getResumeByIdAndUser(id, req.user.id)
    : getResumeById(id);
  if (!resume) {
    return next(new AppError('NOT_FOUND', 'Resume not found'));
  }

  // Parse JSON fields for template
  try { resume.skills_json = typeof resume.skills_json === 'string' ? JSON.parse(resume.skills_json) : (resume.skills_json || []); } catch(e) { resume.skills_json = []; }
  try { resume.experience_json = typeof resume.experience_json === 'string' ? JSON.parse(resume.experience_json) : (resume.experience_json || []); } catch(e) { resume.experience_json = []; }
  try { resume.education_json = typeof resume.education_json === 'string' ? JSON.parse(resume.education_json) : (resume.education_json || []); } catch(e) { resume.education_json = []; }
  try { resume.certifications_json = typeof resume.certifications_json === 'string' ? JSON.parse(resume.certifications_json) : (resume.certifications_json || []); } catch(e) { resume.certifications_json = []; }

  res.render('resumes/confirm', {
    resume,
    user: req.user,
    currentPath: `/resumes/${id}/confirm`,
  });
});

// POST /resumes/:id/confirm — confirm extracted data
router.post('/resumes/:id/confirm', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).send('Invalid resume ID');
  }

  const existing = getResumeById(id);
  if (!existing) {
    return res.status(404).send('Resume not found');
  }

  try {
    if (typeof confirmResume === 'function') {
      confirmResume(id);
    } else if (typeof setMainResume === 'function') {
      setMainResume(id);
    }
  } catch (err) {
    logger.error('Failed to confirm resume', { err, resumeId: id });
    return res.status(500).send('Failed to confirm resume. Please try again.');
  }

  return res.redirect('/resumes');
});

// POST /resumes/:id/delete — delete resume
router.post('/resumes/:id/delete', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).send('Invalid resume ID');
  }

  const existing = getResumeById(id);
  if (!existing) {
    return res.status(404).send('Resume not found');
  }

  deleteResumeWithFile(id);
  return res.redirect('/resumes');
});

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function safeParseJson(str) {
  if (!str) return null;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return null; }
}

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// GET /api/resumes — list user's resumes
router.get('/api/resumes', requireAuth, (req, res) => {
  const allQueueTasks = [...(backgroundQueue.queue || [])];
  if (backgroundQueue.currentTask) allQueueTasks.push(backgroundQueue.currentTask);

  const resumes = getResumesByUser(req.user.id).map((r) => ({
    id: r.id,
    name: r.name,
    file_type: r.file_type,
    summary: r.summary,
    skills_json: safeParseJson(r.skills_json) || [],
    certifications_json: safeParseJson(r.certifications_json) || [],
    is_confirmed: r.is_confirmed,
    scoring_in_progress: allQueueTasks.some(
      (t) => t.type === 'scoreAllJobs' && t.params && t.params.resumeId === r.id
    ),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  res.json({ resumes });
});

// GET /api/resumes/:id — resume detail
router.get('/api/resumes/:id', requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return next(new AppError('VALIDATION_ERROR', 'Invalid resume ID'));
  }

  const resume = getResumeByIdAndUser(id, req.user.id);
  if (!resume) {
    return next(new AppError('NOT_FOUND', 'Resume not found'));
  }

  const detailQueueTasks = [...(backgroundQueue.queue || [])];
  if (backgroundQueue.currentTask) detailQueueTasks.push(backgroundQueue.currentTask);
  const scoringInProgress = detailQueueTasks.some(
    (t) => t.type === 'scoreAllJobs' && t.params && t.params.resumeId === id
  );

  res.json({
    resume: {
      id: resume.id,
      name: resume.name,
      file_type: resume.file_type,
      summary: resume.summary,
      skills_json: safeParseJson(resume.skills_json) || [],
      experience_json: safeParseJson(resume.experience_json) || [],
      education_json: safeParseJson(resume.education_json) || [],
      certifications_json: safeParseJson(resume.certifications_json) || [],
      is_confirmed: resume.is_confirmed,
      scoring_in_progress: scoringInProgress,
      created_at: resume.created_at,
      updated_at: resume.updated_at,
    },
  });
});

// DELETE /api/resumes/:id — delete resume
router.delete('/api/resumes/:id', requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return next(new AppError('VALIDATION_ERROR', 'Invalid resume ID'));
  }

  const resume = getResumeByIdAndUser(id, req.user.id);
  if (!resume) {
    return next(new AppError('NOT_FOUND', 'Resume not found'));
  }

  deleteResume(id, req.user.id);

  // Also delete the physical file if it exists
  if (resume.file_path) {
    const fullPath = path.isAbsolute(resume.file_path)
      ? resume.file_path
      : path.join(__dirname, '..', '..', resume.file_path);
    try { fs.unlinkSync(fullPath); } catch {}
  }

  res.json({ deleted: true });
});

// POST /api/resumes — upload and parse resume (DOCX only, rate limited)
router.post(
  '/api/resumes',
  requireAuth,
  rateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 10, scope: 'user', prefix: 'resume:upload' }),
  upload.single('resume'),
  validateDocxOnly(),
  async (req, res, next) => {
    if (!req.file) {
      return next(new AppError('VALIDATION_ERROR', 'Please select a resume file to upload'));
    }

    try {
      const result = await createResumeFromUpload(req.file, req.user.id);
      const resume = typeof result === 'object' ? result : getResumeByIdAndUser(result, req.user.id);

      if (!resume) {
        return res.status(201).json({ resume: { id: result } });
      }

      res.status(201).json({
        resume: {
          id: resume.id,
          name: resume.name,
          file_type: resume.file_type || 'docx',
          summary: resume.summary,
          skills_json: safeParseJson(resume.skills_json) || [],
          experience_json: safeParseJson(resume.experience_json) || [],
          education_json: safeParseJson(resume.education_json) || [],
          certifications_json: safeParseJson(resume.certifications_json) || [],
          is_confirmed: resume.is_confirmed || 0,
          created_at: resume.created_at,
        },
      });
    } catch (err) {
      logger.error('Failed to process uploaded resume via API', {
        err,
        fileSize: req.file.size,
        mimetype: req.file.mimetype,
      });
      return next(err);
    }
  }
);

// PUT /api/resumes/:id — update/confirm resume data
router.put('/api/resumes/:id', requireAuth, validateResumeUpdate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid resume ID'));
    }

    const existing = getResumeByIdAndUser(id, req.user.id);
    if (!existing) {
      return next(new AppError('NOT_FOUND', 'Resume not found'));
    }

    const validated = req.validatedBody || req.body;
    const { summary, skills_json, experience_json, education_json, certifications_json, is_confirmed } = validated;

    const updateData = {};
    if (summary !== undefined) updateData.summary = summary;
    if (skills_json !== undefined) updateData.skills_json = JSON.stringify(skills_json);
    if (experience_json !== undefined) updateData.experience_json = JSON.stringify(experience_json);
    if (education_json !== undefined) updateData.education_json = JSON.stringify(education_json);
    if (certifications_json !== undefined) updateData.certifications_json = JSON.stringify(certifications_json);
    if (is_confirmed !== undefined) updateData.is_confirmed = is_confirmed ? 1 : 0;

    // Detect is_confirmed 0→1 transition for embedding regeneration
    const confirmTransition = existing.is_confirmed === 0 && updateData.is_confirmed === 1;

    updateExtractedData(id, req.user.id, updateData);

    // Trigger embedding regeneration on 0→1 confirmation transition
    if (confirmTransition) {
      const updatedResume = getResumeByIdAndUser(id, req.user.id);
      const resumeText = buildResumeEmbeddingText(updatedResume);
      const embedding = await generateEmbedding(resumeText);
      if (embedding) {
        const embeddingBuffer = Buffer.from(new Float64Array(embedding).buffer);
        updateEmbedding(id, embeddingBuffer, 'text-embedding-3-small');
      }
    }

    const updated = getResumeByIdAndUser(id, req.user.id);
    res.json({
      resume: {
        id: updated.id,
        name: updated.name,
        summary: updated.summary,
        skills_json: safeParseJson(updated.skills_json) || [],
        is_confirmed: updated.is_confirmed,
        updated_at: updated.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/resumes/:id/score — trigger scoring
router.post(
  '/api/resumes/:id/score',
  requireAuth,
  rateLimiter({ windowMs: 60 * 60 * 1000, max: 5, scope: 'user', prefix: 'resume:score' }),
  (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid resume ID'));
    }

    const resume = getResumeByIdAndUser(id, req.user.id);
    if (!resume) {
      return next(new AppError('NOT_FOUND', 'Resume not found'));
    }

    if (resume.is_confirmed !== 1) {
      return next(new AppError('RESUME_NOT_CONFIRMED', 'Resume must be confirmed before scoring'));
    }

    const activeJobIds = getActiveJobIds();
    const jobCount = activeJobIds ? activeJobIds.length : 0;

    backgroundQueue.enqueue('scoreAllJobs', { resumeId: id, userId: req.user.id });

    res.json({ status: 'queued', job_count: jobCount });
  }
);

// Handle multer errors for API resume upload
router.use('/api/resumes', (err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds 10MB limit' } });
  }
  next(err);
});

module.exports = router;
