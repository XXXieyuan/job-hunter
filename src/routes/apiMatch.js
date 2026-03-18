'use strict';

const express = require('express');
const { getDb, TABLES } = require('../db/database');
const { batchMatch } = require('../services/matchService');
const { createAppError } = require('../utils/appError');

const router = express.Router();

function getPrimaryResumeId() {
  const row = getDb()
    .prepare(`SELECT id FROM ${TABLES.RESUMES} WHERE is_primary = 1 ORDER BY id DESC LIMIT 1`)
    .get();
  return row ? row.id : null;
}

router.post('/run', async (req, res, next) => {
  try {
    const primaryResumeId = getPrimaryResumeId();
    if (!primaryResumeId) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Primary resume is required before matching');
    }

    const payload = req.body || {};
    const jobIds = Array.isArray(payload.jobIds) ? payload.jobIds.map((id) => Number(id)).filter(Boolean) : [];
    const result = await batchMatch(jobIds, primaryResumeId);
    res.json({ matched: result.matched, skipped: result.skipped });
  } catch (error) {
    next(error);
  }
});

router.get('/:jobId', (req, res, next) => {
  try {
    const primaryResumeId = getPrimaryResumeId();
    if (!primaryResumeId) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Primary resume is required before matching');
    }

    const match = getDb().prepare(`
      SELECT total_score, skill_score, semantic_score, keyword_score, gap_analysis
      FROM ${TABLES.MATCHES}
      WHERE job_id = ? AND resume_id = ?
      ORDER BY analyzed_at DESC
      LIMIT 1
    `).get(req.params.jobId, primaryResumeId);

    if (!match) {
      throw createAppError(404, 'NOT_FOUND', `Match for job ${req.params.jobId} not found`);
    }

    res.json({
      ...match,
      gap_analysis: JSON.parse(match.gap_analysis || '{}')
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
