'use strict';

const express = require('express');
const { getDb, TABLES } = require('../db/database');
const { runScraper, getProgressStream } = require('../services/scraperService');
const { validateSource } = require('../utils/validators');
const { log } = require('../utils/logger');
const { createAppError } = require('../utils/appError');

const router = express.Router();

function getSourceId(source) {
  const row = getDb().prepare(`SELECT id FROM ${TABLES.SOURCES} WHERE name = ?`).get(source);
  return row ? row.id : null;
}

router.post('/run', (req, res, next) => {
  try {
    const { source, keywords, maxPages } = req.body || {};
    if (!validateSource(source)) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Invalid source');
    }
    if (!String(keywords || '').trim()) {
      throw createAppError(400, 'VALIDATION_ERROR', 'Keywords are required');
    }

    const pages = Math.max(Number(maxPages || 1), 1);
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO ${TABLES.SCRAPE_HISTORY} (source_id, keywords, pages, jobs_found, status)
      VALUES (?, ?, ?, 0, 'started')
    `).run(getSourceId(source), keywords.trim(), pages);

    runScraper(source, keywords.trim(), pages, result.lastInsertRowid);
    log('info', 'SCRAPE_START', `Started ${source} scrape ${result.lastInsertRowid}`);

    res.json({
      history_id: result.lastInsertRowid,
      status: 'started'
    });
  } catch (error) {
    next(error);
  }
});

router.get('/progress/:historyId', (req, res, next) => {
  try {
    getProgressStream(req.params.historyId, req, res);
  } catch (error) {
    next(error);
  }
});

router.get('/history', (req, res, next) => {
  try {
    const rows = getDb().prepare(`
      SELECT
        scrape_history.*,
        sources.name AS source,
        sources.label AS source_label
      FROM ${TABLES.SCRAPE_HISTORY} scrape_history
      LEFT JOIN ${TABLES.SOURCES} sources ON sources.id = scrape_history.source_id
      ORDER BY scrape_history.started_at DESC
      LIMIT 50
    `).all();

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/sources', (req, res, next) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, name, label, active
      FROM ${TABLES.SOURCES}
      WHERE active = 1
      ORDER BY id ASC
    `).all();

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
