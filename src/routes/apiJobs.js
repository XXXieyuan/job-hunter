'use strict';

const express = require('express');
const { getDb, TABLES } = require('../db/database');
const { log } = require('../utils/logger');
const { validateJobStatus } = require('../utils/validators');
const { createAppError } = require('../utils/appError');

const router = express.Router();

function getPrimaryResumeId() {
  const row = getDb()
    .prepare(`SELECT id FROM ${TABLES.RESUMES} WHERE is_primary = 1 ORDER BY id DESC LIMIT 1`)
    .get();
  return row ? row.id : null;
}

router.get('/companies', (req, res, next) => {
  try {
    const rows = getDb().prepare(`
      SELECT company, COUNT(*) AS count, MAX(created_at) AS latest_job_date
      FROM ${TABLES.JOBS}
      WHERE company IS NOT NULL AND company != ''
      GROUP BY company
      ORDER BY count DESC, latest_job_date DESC
    `).all();

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const primaryResumeId = getPrimaryResumeId();
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];

    if (req.query.source) {
      where.push('sources.name = ?');
      params.push(req.query.source);
    }

    if (req.query.keyword) {
      where.push('(jobs.title LIKE ? OR jobs.company LIKE ? OR jobs.job_description LIKE ?)');
      const pattern = `%${req.query.keyword}%`;
      params.push(pattern, pattern, pattern);
    }

    if (req.query.status) {
      where.push("COALESCE(job_status.status, 'unread') = ?");
      params.push(req.query.status);
    }

    if (req.query.minScore) {
      where.push('COALESCE(matches.total_score, 0) >= ?');
      params.push(Number(req.query.minScore));
    }

    if (req.query.maxScore) {
      where.push('COALESCE(matches.total_score, 0) <= ?');
      params.push(Number(req.query.maxScore));
    }

    const matchJoin = primaryResumeId
      ? `LEFT JOIN ${TABLES.MATCHES} matches ON matches.job_id = jobs.id AND matches.resume_id = ${Number(primaryResumeId)}`
      : `LEFT JOIN ${TABLES.MATCHES} matches ON matches.job_id = jobs.id`;
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${TABLES.JOBS} jobs
      JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
      ${matchJoin}
      LEFT JOIN ${TABLES.JOB_STATUS} job_status ON job_status.job_id = jobs.id
      ${whereClause}
    `).get(...params).count;

    const jobs = db.prepare(`
      SELECT
        jobs.*,
        sources.name AS source,
        sources.label AS source_label,
        matches.total_score,
        matches.skill_score,
        matches.semantic_score,
        matches.keyword_score,
        COALESCE(job_status.status, 'unread') AS status
      FROM ${TABLES.JOBS} jobs
      JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
      ${matchJoin}
      LEFT JOIN ${TABLES.JOB_STATUS} job_status ON job_status.job_id = jobs.id
      ${whereClause}
      ORDER BY COALESCE(matches.total_score, -1) DESC, jobs.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ jobs, total, page, limit });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const primaryResumeId = getPrimaryResumeId();
    const job = db.prepare(`
      SELECT jobs.*, sources.name AS source, sources.label AS source_label
      FROM ${TABLES.JOBS} jobs
      JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
      WHERE jobs.id = ?
    `).get(req.params.id);

    if (!job) {
      throw createAppError(404, 'NOT_FOUND', `Job with id ${req.params.id} not found`);
    }

    const match = primaryResumeId
      ? db.prepare(`
          SELECT *
          FROM ${TABLES.MATCHES}
          WHERE job_id = ? AND resume_id = ?
          ORDER BY analyzed_at DESC
          LIMIT 1
        `).get(req.params.id, primaryResumeId)
      : null;

    const coverLetters = db.prepare(`
      SELECT * FROM ${TABLES.COVER_LETTERS}
      WHERE job_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id);
    const status = db.prepare(`
      SELECT status
      FROM ${TABLES.JOB_STATUS}
      WHERE job_id = ?
    `).get(req.params.id);

    res.json({
      job,
      match: match ? { ...match, gap_analysis: JSON.parse(match.gap_analysis || '{}') } : null,
      cover_letters: coverLetters,
      status: status ? status.status : 'unread'
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id/status', (req, res, next) => {
  try {
    const status = req.body.status;
    if (!validateJobStatus(status)) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Invalid job status');
    }

    const db = getDb();
    const job = db.prepare(`SELECT id FROM ${TABLES.JOBS} WHERE id = ?`).get(req.params.id);
    if (!job) {
      throw createAppError(404, 'NOT_FOUND', `Job with id ${req.params.id} not found`);
    }

    db.prepare(`
      INSERT INTO ${TABLES.JOB_STATUS} (job_id, status, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(req.params.id, status);

    log('info', 'JOB_STATUS_UPDATED', `Updated job ${req.params.id} to ${status}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
