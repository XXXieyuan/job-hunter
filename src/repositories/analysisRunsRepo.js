const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createRun({ type, config }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO analysis_runs (status, type, config_json, started_at)
     VALUES ('running', @type, @config_json, CURRENT_TIMESTAMP)`
  );
  const info = stmt.run({
    type: type || 'full',
    config_json: config ? JSON.stringify(config) : null,
  });
  return info.lastInsertRowid;
}

function markRunCompleted(id, stats) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE analysis_runs
     SET status = 'success',
         stats_json = @stats_json,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ).run({
    id,
    stats_json: JSON.stringify(stats || {}),
  });
}

function markRunFailed(id, error) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE analysis_runs
     SET status = 'failure',
         error = @error,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ).run({
    id,
    error: String(error),
  });
}

function getRunById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id);
}

function getLastRun() {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 1')
    .get();
}

function getRecentRuns(limit = 20) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT ?'
    )
    .all(limit);
}

/**
 * Update progress of a running analysis run.
 * Encodes last_processed_job_id inside stats_json since the column
 * may not exist in older schemas.
 *
 * @param {number} id - Run ID
 * @param {object} data
 * @param {number} [data.last_processed_job_id] - Checkpoint job ID
 * @param {object} [data.stats_json] - Progress stats object
 */
function updateProgress(id, { last_processed_job_id, stats_json }) {
  const db = getDbInstance();
  const progressData = {
    ...(stats_json || {}),
  };
  if (last_processed_job_id) {
    progressData.last_processed_job_id = last_processed_job_id;
  }
  db.prepare(
    `UPDATE analysis_runs
     SET stats_json = @stats_json
     WHERE id = @id`
  ).run({
    id,
    stats_json: JSON.stringify(progressData),
  });
}

function findRunning() {
  const db = getDbInstance();
  return db
    .prepare("SELECT * FROM analysis_runs WHERE status = 'running'")
    .all();
}

/**
 * Get paginated analysis runs.
 * @param {number} page - 1-based page number
 * @param {number} perPage - items per page
 * @returns {{ runs: object[], pagination: object }}
 */
function getPaginatedRuns(page = 1, perPage = 25) {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM analysis_runs').get().c;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (Math.max(1, page) - 1) * perPage;

  const runs = db
    .prepare(
      `SELECT * FROM analysis_runs
       ORDER BY started_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(perPage, offset);

  // Parse JSON fields
  for (const run of runs) {
    if (run.config_json && typeof run.config_json === 'string') {
      try { run.config_json = JSON.parse(run.config_json); } catch { /* keep string */ }
    }
    if (run.stats_json && typeof run.stats_json === 'string') {
      try { run.stats_json = JSON.parse(run.stats_json); } catch { /* keep string */ }
    }
  }

  return {
    runs,
    pagination: { page: Math.max(1, page), per_page: perPage, total, total_pages: totalPages },
  };
}

module.exports = {
  createRun,
  markRunCompleted,
  markRunFailed,
  getRunById,
  getLastRun,
  getRecentRuns,
  getPaginatedRuns,
  updateProgress,
  findRunning,
};
