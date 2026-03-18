'use strict';

const express = require('express');
const { getDb, TABLES } = require('../db/database');
const { generateCoverLetter } = require('../services/coverLetterService');
const { validateLanguage } = require('../utils/validators');
const { createAppError } = require('../utils/appError');

const router = express.Router();

router.post('/generate', async (req, res, next) => {
  try {
    const { job_id: jobId, resume_id: resumeId, language } = req.body || {};
    if (!jobId || !resumeId || !validateLanguage(language)) {
      throw createAppError(400, 'VALIDATION_ERROR', 'job_id, resume_id and a valid language are required');
    }

    const primaryResume = getDb()
      .prepare(`SELECT id FROM ${TABLES.RESUMES} WHERE is_primary = 1 LIMIT 1`)
      .get();
    if (!primaryResume) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Primary resume is required before generating cover letters');
    }

    const result = await generateCoverLetter(Number(jobId), Number(resumeId), language);
    res.json({
      id: result.id,
      content: result.content,
      language: result.language
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:jobId', (req, res, next) => {
  try {
    const rows = getDb().prepare(`
      SELECT * FROM ${TABLES.COVER_LETTERS}
      WHERE job_id = ?
      ORDER BY created_at DESC
    `).all(req.params.jobId);

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = getDb().prepare(`DELETE FROM ${TABLES.COVER_LETTERS} WHERE id = ?`).run(req.params.id);
    if (!result.changes) {
      throw createAppError(404, 'NOT_FOUND', `Cover letter with id ${req.params.id} not found`);
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
