const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function upsertFitScore({
  job_id,
  resume_id,
  overall_score,
  semantic_score,
  keyword_score,
  role_alignment_score,
  location_score,
  breakdown_json,
  skill_gaps_json,
  visa_match,
}) {
  const db = getDbInstance();
  const existing = db
    .prepare(
      'SELECT id FROM job_fit_scores WHERE job_id = ? AND resume_id = ?'
    )
    .get(job_id, resume_id);

  if (existing) {
    db.prepare(
      `UPDATE job_fit_scores
       SET overall_score = ?, semantic_score = ?, keyword_score = ?,
           role_alignment_score = ?, location_score = ?,
           breakdown_json = ?, skill_gaps_json = ?, visa_match = ?
       WHERE id = ?`
    ).run(
      overall_score,
      semantic_score || null,
      keyword_score || null,
      role_alignment_score || null,
      location_score || null,
      breakdown_json || null,
      skill_gaps_json || null,
      visa_match !== undefined ? visa_match : null,
      existing.id
    );
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO job_fit_scores
       (job_id, resume_id, overall_score, semantic_score, keyword_score,
        role_alignment_score, location_score, breakdown_json, skill_gaps_json, visa_match)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      job_id,
      resume_id,
      overall_score,
      semantic_score || null,
      keyword_score || null,
      role_alignment_score || null,
      location_score || null,
      breakdown_json || null,
      skill_gaps_json || null,
      visa_match !== undefined ? visa_match : null
    );
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

/**
 * Get all scores for a user's resumes, joined with job data.
 */
function getScoresForUser(user_id, { minScore, limit, offset } = {}) {
  const db = getDbInstance();
  const conditions = ['r.user_id = @user_id'];
  const params = { user_id };

  if (typeof minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = minScore;
  }

  params.limit = limit || 50;
  params.offset = offset || 0;

  const where = conditions.join(' AND ');
  const sql = `
    SELECT fs.*, j.title, j.company_name, j.location, j.source
    FROM job_fit_scores fs
    JOIN resumes r ON r.id = fs.resume_id
    JOIN jobs j ON j.id = fs.job_id
    WHERE ${where}
    ORDER BY fs.overall_score DESC
    LIMIT @limit OFFSET @offset
  `;
  return db.prepare(sql).all(params);
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

/**
 * Get score for a specific job + resume combination.
 * Returns full score row with all sub-scores and breakdown_json.
 */
function getScoreForJobAndResume(jobId, resumeId) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM job_fit_scores WHERE job_id = ? AND resume_id = ?'
    )
    .get(jobId, resumeId);
}

module.exports = {
  upsertFitScore,
  getFitScore,
  getBestFitScoreForJob,
  getScoreForJobAndResume,
  getScoresForUser,
  getStats,
};
