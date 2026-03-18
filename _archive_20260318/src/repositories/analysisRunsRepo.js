const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createRun(sources) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO analysis_runs (status, sources_json)
     VALUES ('running', @sources_json)`
  );
  const info = stmt.run({
    sources_json: JSON.stringify(sources || {}),
  });
  return info.lastInsertRowid;
}

function markRunCompleted(id, stats) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE analysis_runs
     SET status = 'completed',
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
     SET status = 'failed',
         error = @error,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ).run({
    id,
    error: String(error),
  });
}

function getLastRun() {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 1')
    .get();
}

module.exports = {
  createRun,
  markRunCompleted,
  markRunFailed,
  getLastRun,
};

