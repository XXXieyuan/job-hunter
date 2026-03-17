const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createRun(scraperName) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO scraper_runs (scraper_name, status)
     VALUES (@scraper_name, 'queued')`
  );
  const info = stmt.run({
    scraper_name: scraperName,
  });
  return info.lastInsertRowid;
}

function markRunRunning(id) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'running',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
     WHERE id = @id`
  ).run({ id });
}

function markRunSuccess(id, jobsAdded) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'success',
         finished_at = CURRENT_TIMESTAMP,
         jobs_added = @jobs_added
     WHERE id = @id`
  ).run({
    id,
    jobs_added: typeof jobsAdded === 'number' ? jobsAdded : 0,
  });
}

function markRunFailure(id, errorMessage) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE scraper_runs
     SET status = 'failure',
         finished_at = CURRENT_TIMESTAMP,
         error_message = @error_message
     WHERE id = @id`
  ).run({
    id,
    error_message: errorMessage ? String(errorMessage) : null,
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
       ORDER BY started_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit);
}

function deleteRun(id) {
  const db = getDbInstance();
  db.prepare('DELETE FROM scraper_runs WHERE id = ?').run(id);
}

module.exports = {
  createRun,
  markRunRunning,
  markRunSuccess,
  markRunFailure,
  getRunById,
  getRecentRuns,
  deleteRun,
};

