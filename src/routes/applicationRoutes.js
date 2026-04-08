const express = require('express');
const {
  create,
  createIdempotent,
  findByUser,
  findById,
  findByUserPaginated,
  updateStatus,
  updateNotes,
  updateStatusAndNotes,
  deleteApplication,
  countByStatus,
  countAllStatuses,
  countForUser,
} = require('../repositories/applicationsRepo');
const { requireAuth } = require('../middleware/auth');
const { getConfirmedResumeForUser } = require('../repositories/resumesRepo');
const { AppError } = require('../utils/errors');
const { getLogger } = require('../logger');

const logger = getLogger('applicationRoutes');

const router = express.Router();

const VALID_STATUSES = ['saved', 'applied', 'interviewing', 'offered', 'rejected', 'withdrawn'];

// GET /tracker — render tracker page (requireAuth)
router.get('/tracker', requireAuth, (req, res) => {
  const userId = req.user.id;
  const statusFilter = req.query.status || '';
  const sortBy = req.query.sort || 'date';

  // Get counts for summary bar
  const statusCounts = countByStatus(userId);

  // Get applications with optional status filter
  const filterOpts = {};
  if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
    filterOpts.status = statusFilter;
  }

  let applications = findByUser(userId, filterOpts);

  // Sort
  if (sortBy === 'score') {
    applications = applications.sort(function (a, b) {
      const scoreA = a.overall_score || a.score || 0;
      const scoreB = b.overall_score || b.score || 0;
      return scoreB - scoreA;
    });
  }
  // Default sort is by date (already ordered by status_updated_at DESC from repo)

  res.render('applications/tracker', {
    applications,
    statusCounts,
    activeFilter: statusFilter,
    sortBy,
  });
});

// POST /applications — save/track a job
router.post('/applications', requireAuth, express.json(), (req, res) => {
  const userId = req.user.id;
  const { job_id, status, notes } = req.body;

  if (!job_id) {
    return res.status(400).json({ error: 'job_id is required' });
  }

  const validStatus = status && VALID_STATUSES.includes(status) ? status : 'saved';

  try {
    const id = create({
      user_id: userId,
      job_id,
      status: validStatus,
      notes: notes || null,
      applied_at: validStatus === 'applied' ? new Date().toISOString() : null,
    });
    logger.info('Application created', { applicationId: id, userId, jobId: job_id });
    res.status(201).json({ id, status: validStatus });
  } catch (err) {
    logger.error('Failed to create application', { err, userId, jobId: job_id });
    res.status(500).json({ error: 'Failed to save application' });
  }
});

// PUT /applications/:id/status — update status (AJAX)
router.put('/applications/:id/status', requireAuth, express.json(), (req, res) => {
  const userId = req.user.id;
  const appId = Number(req.params.id);
  const { status } = req.body;

  if (!Number.isFinite(appId)) {
    return res.status(400).json({ error: 'Invalid application ID' });
  }

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be one of: ' + VALID_STATUSES.join(', ') });
  }

  const existing = findById(appId, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  try {
    updateStatus(appId, userId, status);
    logger.info('Application status updated', { applicationId: appId, userId, newStatus: status });
    res.json({ success: true, status });
  } catch (err) {
    logger.error('Failed to update application status', { err, applicationId: appId });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PUT /applications/:id/notes — update notes (AJAX)
router.put('/applications/:id/notes', requireAuth, express.json(), (req, res) => {
  const userId = req.user.id;
  const appId = Number(req.params.id);
  const { notes } = req.body;

  if (!Number.isFinite(appId)) {
    return res.status(400).json({ error: 'Invalid application ID' });
  }

  const existing = findById(appId, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  try {
    updateNotes(appId, userId, notes || '');
    logger.info('Application notes updated', { applicationId: appId, userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update application notes', { err, applicationId: appId });
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

// DELETE /applications/:id — remove tracking
router.delete('/applications/:id', requireAuth, (req, res) => {
  const userId = req.user.id;
  const appId = Number(req.params.id);

  if (!Number.isFinite(appId)) {
    return res.status(400).json({ error: 'Invalid application ID' });
  }

  const existing = findById(appId, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  try {
    deleteApplication(appId, userId);
    logger.info('Application deleted', { applicationId: appId, userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete application', { err, applicationId: appId });
    res.status(500).json({ error: 'Failed to remove application' });
  }
});

// ─── API routes ──────────────────────────────────────────────────────

/**
 * GET /api/applications — list user's applications with pagination
 */
router.get('/api/applications', requireAuth, (req, res) => {
  const userId = req.user.id;
  const statusFilter = req.query.status || null;
  const sort = req.query.sort || 'status_updated_at';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter. Must be one of: ' + VALID_STATUSES.join(', ') } });
  }

  if (!['status_updated_at', 'score', 'company_name'].includes(sort)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid sort. Must be one of: status_updated_at, score, company_name' } });
  }

  // Get confirmed resume for score join
  const resume = getConfirmedResumeForUser(userId);
  const resumeId = resume ? resume.id : null;

  const offset = (page - 1) * perPage;
  const applications = findByUserPaginated(userId, {
    status: statusFilter,
    sort,
    resumeId,
    limit: perPage,
    offset,
  });

  const counts = countAllStatuses(userId);
  const total = countForUser(userId, statusFilter);
  const totalPages = Math.ceil(total / perPage) || 1;

  res.json({
    applications: applications.map((a) => ({
      id: a.id,
      user_id: a.user_id,
      job_id: a.job_id,
      status: a.status,
      notes: a.notes,
      applied_at: a.applied_at,
      status_updated_at: a.status_updated_at,
      created_at: a.created_at,
      job: {
        title: a.job_title,
        company_name: a.job_company_name,
        location: a.job_location,
        source: a.job_source,
        url: a.job_url,
        is_active: a.job_is_active,
      },
      fit_score: a.fs_overall_score != null ? { overall_score: a.fs_overall_score } : null,
    })),
    counts,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: totalPages,
    },
  });
});

/**
 * POST /api/applications — create/save an application (idempotent)
 */
router.post('/api/applications', requireAuth, express.json(), (req, res) => {
  const userId = req.user.id;
  const { job_id, status } = req.body;

  if (!job_id || !Number.isFinite(Number(job_id))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'job_id is required' } });
  }

  const validStatus = status || 'saved';
  if (!VALID_STATUSES.includes(validStatus)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status. Must be one of: ' + VALID_STATUSES.join(', ') } });
  }

  try {
    const result = createIdempotent({
      user_id: userId,
      job_id: Number(job_id),
      status: validStatus,
    });

    const app = findById(result.id, userId);
    logger.info('API application created/found', { applicationId: result.id, userId, jobId: job_id, created: result.created });

    res.status(result.created ? 201 : 200).json({
      application: {
        id: app.id,
        user_id: app.user_id,
        job_id: app.job_id,
        status: app.status,
        notes: app.notes,
        applied_at: app.applied_at,
        status_updated_at: app.status_updated_at,
        created_at: app.created_at,
      },
    });
  } catch (err) {
    logger.error('API failed to create application', { err, userId, jobId: job_id });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save application' } });
  }
});

/**
 * PUT /api/applications/:id — update status and/or notes
 */
router.put('/api/applications/:id', requireAuth, express.json(), (req, res) => {
  const userId = req.user.id;
  const appId = Number(req.params.id);

  if (!Number.isFinite(appId)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid application ID' } });
  }

  const { status, notes } = req.body;

  if (status === undefined && notes === undefined) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'At least one of status or notes must be provided' } });
  }

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status. Must be one of: ' + VALID_STATUSES.join(', ') } });
  }

  const existing = findById(appId, userId);
  if (!existing) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Application not found' } });
  }

  try {
    updateStatusAndNotes(appId, userId, { status, notes });
    const updated = findById(appId, userId);

    logger.info('API application updated', { applicationId: appId, userId });

    res.json({
      application: {
        id: updated.id,
        status: updated.status,
        notes: updated.notes,
        applied_at: updated.applied_at,
        status_updated_at: updated.status_updated_at,
      },
    });
  } catch (err) {
    logger.error('API failed to update application', { err, applicationId: appId });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update application' } });
  }
});

module.exports = router;
