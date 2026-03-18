'use strict';

const express = require('express');
const { URL } = require('url');
const { getDb, TABLES } = require('../db/database');
const { getConfig, setConfig } = require('../services/configService');
const { createAppError } = require('../utils/appError');

const router = express.Router();

router.get('/stats', (req, res, next) => {
  try {
    const db = getDb();
    const stats = {
      jobs_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.JOBS}`).get().count,
      resumes_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.RESUMES}`).get().count,
      matched_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.MATCHES}`).get().count,
      cl_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.COVER_LETTERS}`).get().count,
      by_source: {}
    };

    const rows = db.prepare(`
      SELECT sources.name, COUNT(jobs.id) AS count
      FROM ${TABLES.SOURCES} sources
      LEFT JOIN ${TABLES.JOBS} jobs ON jobs.source_id = sources.id
      GROUP BY sources.name
    `).all();

    for (const row of rows) {
      stats.by_source[row.name] = row.count;
    }

    res.json(stats);
  } catch (error) {
    next(error);
  }
});

router.get('/logs', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const level = req.query.level;
    let query = `
      SELECT id, level, action, detail, created_at
      FROM ${TABLES.OPERATION_LOGS}
    `;
    const params = [];

    if (level) {
      query += ' WHERE level = ?';
      params.push(level);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = getDb().prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.put('/config', (req, res, next) => {
  try {
    const { openai_base_url: openaiBaseUrl, openai_api_key: openaiApiKey } = req.body || {};
    if (openaiBaseUrl) {
      try {
        new URL(openaiBaseUrl);
      } catch (error) {
        throw createAppError(400, 'VALIDATION_ERROR', 'openai_base_url must be a valid URL');
      }
    }

    setConfig({
      OPENAI_BASE_URL: openaiBaseUrl || '',
      OPENAI_API_KEY: openaiApiKey || ''
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/config/public', (req, res, next) => {
  try {
    const config = getConfig();
    res.json({ openai_base_url: config.openaiBaseUrl || '' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
