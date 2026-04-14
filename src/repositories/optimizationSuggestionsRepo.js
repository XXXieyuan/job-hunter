'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

/**
 * Upsert an optimization suggestion row.
 * Uses INSERT OR REPLACE on UNIQUE(job_id, resume_id).
 * // WARNING: INSERT OR REPLACE deletes + re-inserts (triggers CASCADE).
 * // Safe because this table has no dependents.
 */
function upsert({ jobId, resumeId, userId, currentScore, predictedScore, suggestionsJson, partial }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO optimization_suggestions
     (job_id, resume_id, user_id, current_score, predicted_score, suggestions_json, partial)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(jobId, resumeId, userId, currentScore, predictedScore, suggestionsJson, partial ? 1 : 0);
  return info.lastInsertRowid;
}

/**
 * Get cached suggestion for a job+resume pair, scoped to userId.
 * Returns null if:
 *   - No row exists
 *   - Row is older than 24 hours (expired)
 *   - userId does not match (IDOR prevention)
 * Computes `stale` field: true when resume was updated after suggestions were generated.
 */
function getByJobAndResume(jobId, resumeId, userId) {
  const db = getDbInstance();
  const row = db.prepare(
    `SELECT os.id, os.job_id, os.resume_id, os.user_id,
            os.current_score, os.predicted_score, os.suggestions_json,
            os.partial, os.created_at,
            r.updated_at AS resume_updated_at
     FROM optimization_suggestions os
     JOIN resumes r ON r.id = os.resume_id
     WHERE os.job_id = ? AND os.resume_id = ? AND os.user_id = ?
       AND julianday('now') - julianday(os.created_at) < 1`
  ).get(jobId, resumeId, userId);

  if (!row) return null;

  return {
    id: row.id,
    job_id: row.job_id,
    resume_id: row.resume_id,
    user_id: row.user_id,
    current_score: row.current_score,
    predicted_score: row.predicted_score,
    suggestions_json: row.suggestions_json,
    partial: row.partial,
    created_at: row.created_at,
    stale: row.resume_updated_at > row.created_at,
  };
}

/**
 * Delete optimization suggestions older than the given number of days.
 * Returns the number of deleted rows.
 */
function deleteOlderThan(days) {
  const db = getDbInstance();
  const info = db.prepare(
    `DELETE FROM optimization_suggestions
     WHERE julianday('now') - julianday(created_at) > ?`
  ).run(days);
  return info.changes;
}

module.exports = {
  upsert,
  getByJobAndResume,
  deleteOlderThan,
};
