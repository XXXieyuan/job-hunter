'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function upsertOverride(job_id, user_id, resume_id) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `INSERT INTO resume_overrides (job_id, user_id, resume_id, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(job_id, user_id) DO UPDATE SET
         resume_id = excluded.resume_id,
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(job_id, user_id, resume_id);
  return info.lastInsertRowid || info.changes;
}

function getOverride(job_id, user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT ro.id, ro.job_id, ro.user_id, ro.resume_id, ro.created_at, ro.updated_at
       FROM resume_overrides ro
       JOIN resumes r ON r.id = ro.resume_id AND r.is_confirmed = 1
       WHERE ro.job_id = ? AND ro.user_id = ?`
    )
    .get(job_id, user_id);
}

function deleteOverride(job_id, user_id) {
  const db = getDbInstance();
  const info = db
    .prepare('DELETE FROM resume_overrides WHERE job_id = ? AND user_id = ?')
    .run(job_id, user_id);
  return info.changes;
}

function hasOverrides(user_id) {
  const db = getDbInstance();
  const row = db
    .prepare(
      'SELECT 1 AS has FROM resume_overrides WHERE user_id = ? LIMIT 1'
    )
    .get(user_id);
  return !!row;
}

module.exports = {
  upsertOverride,
  getOverride,
  deleteOverride,
  hasOverrides,
};
