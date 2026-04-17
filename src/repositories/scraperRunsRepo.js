const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createRun(scraperName, config) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO scraper_runs (scraper_name, status, config_json, created_at)
     VALUES (@scraper_name, 'pending', @config_json, CURRENT_TIMESTAMP)`
  );
  const info = stmt.run({
    scraper_name: scraperName,
    config_json: config ? JSON.stringify(config) : null,
  });
  return info.lastInsertRowid;
}

function markRunRunning(id) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'running',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
     WHERE id = ?`
  ).run(id);
}

function markRunSuccess(id, stats) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'success',
         completed_at = CURRENT_TIMESTAMP,
         jobs_found = @jobs_found,
         jobs_new = @jobs_new,
         jobs_updated = @jobs_updated,
         pages_scraped = @pages_scraped
     WHERE id = @id`
  ).run({
    id,
    jobs_found: (stats && stats.jobs_found) || 0,
    jobs_new: (stats && stats.jobs_new) || 0,
    jobs_updated: (stats && stats.jobs_updated) || 0,
    pages_scraped: (stats && stats.pages_scraped) || 0,
  });
}

function markRunFailure(id, errorMessage) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'failure',
         completed_at = CURRENT_TIMESTAMP,
         error = @error
     WHERE id = @id`
  ).run({
    id,
    error: errorMessage ? String(errorMessage) : null,
  });
}

let _progressMessageColumnEnsured = false;
function ensureProgressMessageColumn(db) {
  if (_progressMessageColumnEnsured) return;
  const cols = db.pragma('table_info(scraper_runs)').map((c) => c.name);
  if (!cols.includes('progress_message')) {
    db.exec('ALTER TABLE scraper_runs ADD COLUMN progress_message TEXT');
  }
  _progressMessageColumnEnsured = true;
}

function updateProgress(id, stats) {
  const db = getDbInstance();
  ensureProgressMessageColumn(db);
  db.prepare(
    `UPDATE scraper_runs
     SET jobs_found = @jobs_found,
         jobs_new = @jobs_new,
         jobs_updated = @jobs_updated,
         pages_scraped = @pages_scraped,
         progress_message = @progress_message
     WHERE id = @id`
  ).run({
    id,
    jobs_found: (stats && stats.jobs_found) || 0,
    jobs_new: (stats && stats.jobs_new) || 0,
    jobs_updated: (stats && stats.jobs_updated) || 0,
    pages_scraped: (stats && stats.pages_scraped) || 0,
    progress_message: (stats && stats.progress_message) || null,
  });
}

function getRunById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM scraper_runs WHERE id = ?').get(id);
}

function getRecentRuns(limit = 20) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT *
       FROM scraper_runs
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit);
}

function findRunning(scraperName) {
  const db = getDbInstance();
  if (scraperName) {
    return db
      .prepare(
        "SELECT * FROM scraper_runs WHERE status = 'running' AND scraper_name = ?"
      )
      .get(scraperName);
  }
  return db
    .prepare("SELECT * FROM scraper_runs WHERE status = 'running'")
    .all();
}

function deleteRun(id) {
  const db = getDbInstance();
  db.prepare('DELETE FROM scraper_runs WHERE id = ?').run(id);
}

/**
 * Get the latest successful completion time per scraper platform.
 * Returns { linkedin: <timestamp>, seek: <timestamp>, apsjobs: <timestamp> }
 */
function getSourceFreshness() {
  const db = getDbInstance();
  const rows = db.prepare(
    `SELECT scraper_name, MAX(completed_at) AS last_success
     FROM scraper_runs
     WHERE status = 'success'
     GROUP BY scraper_name`
  ).all();

  const freshness = { linkedin: null, seek: null, apsjobs: null, actgov: null, nswgov: null };
  for (const row of rows) {
    const name = row.scraper_name;
    if (name in freshness) {
      freshness[name] = row.last_success;
    }
  }
  return freshness;
}

/**
 * Get paginated scraper runs.
 * @param {number} page - 1-based page number
 * @param {number} perPage - items per page
 * @returns {{ runs: object[], pagination: object }}
 */
function getPaginatedRuns(page = 1, perPage = 25) {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM scraper_runs').get().c;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (Math.max(1, page) - 1) * perPage;

  const runs = db
    .prepare(
      `SELECT * FROM scraper_runs
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(perPage, offset);

  // Parse config_json for each run
  for (const run of runs) {
    if (run.config_json && typeof run.config_json === 'string') {
      try { run.config_json = JSON.parse(run.config_json); } catch { /* keep string */ }
    }
  }

  return {
    runs,
    pagination: { page: Math.max(1, page), per_page: perPage, total, total_pages: totalPages },
  };
}

/**
 * Get platform health data: last_success, last_error, error_rate per platform.
 * error_rate = failures / total runs in last 30 days.
 */
function getPlatformHealth() {
  const db = getDbInstance();

  const platforms = ['linkedin', 'seek', 'apsjobs', 'actgov', 'nswgov'];
  const health = {};

  for (const platform of platforms) {
    const lastSuccess = db.prepare(
      `SELECT MAX(completed_at) AS ts FROM scraper_runs
       WHERE scraper_name = ? AND status = 'success'`
    ).get(platform);

    const lastError = db.prepare(
      `SELECT MAX(completed_at) AS ts FROM scraper_runs
       WHERE scraper_name = ? AND status = 'failure'`
    ).get(platform);

    const rateRow = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures
       FROM scraper_runs
       WHERE scraper_name = ? AND started_at > datetime('now', '-30 days')`
    ).get(platform);

    const errorRate = (rateRow && rateRow.total > 0)
      ? Math.round((rateRow.failures / rateRow.total) * 100) / 100
      : 0;

    const lastSuccessTs = (lastSuccess && lastSuccess.ts) || null;
    const lastErrorTs = (lastError && lastError.ts) || null;

    // Derive status per INTERFACE_CONTRACT rules
    let status = 'healthy';
    const now = Date.now();
    const HOUR_48 = 48 * 60 * 60 * 1000;
    const DAY_7 = 7 * 24 * 60 * 60 * 1000;

    const lastSuccessAge = lastSuccessTs ? (now - new Date(lastSuccessTs).getTime()) : Infinity;

    if (errorRate >= 0.5 || lastSuccessAge > DAY_7 || !lastSuccessTs) {
      status = 'error';
    } else if (errorRate >= 0.2 || lastSuccessAge > HOUR_48) {
      status = 'warning';
    }

    health[platform] = {
      last_success: lastSuccessTs,
      last_error: lastErrorTs,
      error_rate: errorRate,
      status,
    };
  }

  return health;
}

/**
 * Count runs started in the last hour (for rate limiting).
 */
function countRecentRuns(windowMs = 3600000) {
  const db = getDbInstance();
  const seconds = Math.floor(windowMs / 1000);
  return db.prepare(
    `SELECT COUNT(*) AS c FROM scraper_runs WHERE created_at >= datetime('now', '-' || CAST(? AS TEXT) || ' seconds')`
  ).get(seconds).c;
}

module.exports = {
  createRun,
  markRunRunning,
  markRunSuccess,
  markRunFailure,
  updateProgress,
  getRunById,
  getRecentRuns,
  getPaginatedRuns,
  findRunning,
  deleteRun,
  getSourceFreshness,
  getPlatformHealth,
  countRecentRuns,
};
