const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function upsertFitScore({ job_id, resume_id, overall_score, keyword_score, embedding_score, breakdown_json }) {
  const db = getDbInstance();
  const existing = db
    .prepare(
      'SELECT id FROM job_fit_scores WHERE job_id = ? AND resume_id = ?'
    )
    .get(job_id, resume_id);

  if (existing) {
    db.prepare(
      `UPDATE job_fit_scores
       SET overall_score = ?, keyword_score = ?, embedding_score = ?, breakdown_json = ?
       WHERE id = ?`
    ).run(overall_score, keyword_score, embedding_score, breakdown_json, existing.id);
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO job_fit_scores
       (job_id, resume_id, overall_score, keyword_score, embedding_score, breakdown_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(job_id, resume_id, overall_score, keyword_score, embedding_score, breakdown_json);
  return info.lastInsertRowid;
}

function getFitScore(jobId, resumeId) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM job_fit_scores WHERE job_id = ? AND resume_id = ?'
    )
    .get(jobId, resumeId);
}

function getBestFitScoreForJob(jobId) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM job_fit_scores WHERE job_id = ? ORDER BY overall_score DESC LIMIT 1'
    )
    .get(jobId);
}

function getStats() {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM job_fit_scores').get().c;
  const avgRow = db
    .prepare('SELECT AVG(overall_score) AS avg_score FROM job_fit_scores')
    .get();
  const avg = avgRow && avgRow.avg_score ? avgRow.avg_score : 0;
  const highFitPerRole = db
    .prepare(
      `SELECT j.role, COUNT(*) AS count
       FROM job_fit_scores fs
       JOIN jobs j ON j.id = fs.job_id
       WHERE fs.overall_score >= 80
       GROUP BY j.role`
    )
    .all();
  return { total, avg, highFitPerRole };
}

module.exports = {
  upsertFitScore,
  getFitScore,
  getBestFitScoreForJob,
  getStats,
};

