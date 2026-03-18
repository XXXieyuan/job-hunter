'use strict';

const { getDb, TABLES } = require('../db/database');

const LEVELS = new Set(['info', 'warn', 'error']);

function sanitizeDetail(detail) {
  if (detail === null || detail === undefined) {
    return null;
  }

  if (typeof detail === 'string') {
    return detail.slice(0, 4000);
  }

  return JSON.stringify(detail).slice(0, 4000);
}

function log(level, action, detail) {
  const normalizedLevel = LEVELS.has(level) ? level : 'info';
  const normalizedAction = String(action || 'UNKNOWN').slice(0, 255);
  const sanitizedDetail = sanitizeDetail(detail);

  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO ${TABLES.OPERATION_LOGS} (level, action, detail) VALUES (?, ?, ?)`
  );

  return statement.run(normalizedLevel, normalizedAction, sanitizedDetail);
}

module.exports = {
  LEVELS,
  log
};
