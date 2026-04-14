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

/**
 * Find active jobs that have not yet been scored for a given resume.
 * Returns array of { id } objects, limited to 100, ordered by posted_at DESC.
 */
function findUnscoredJobsForResume(resumeId) {
  const db = getDbInstance();
  return db.prepare(
    `SELECT j.id FROM jobs j
     WHERE j.is_active = 1
     AND j.id NOT IN (
       SELECT fs.job_id FROM job_fit_scores fs WHERE fs.resume_id = ?
     )
     ORDER BY j.posted_at DESC
     LIMIT 100`
  ).all(resumeId);
}

function getScoresForJobByUser(job_id, user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT jfs.resume_id, jfs.overall_score, jfs.semantic_score, jfs.keyword_score,
              jfs.role_alignment_score, jfs.location_score, jfs.breakdown_json, jfs.skill_gaps_json,
              r.label AS resume_label
       FROM job_fit_scores jfs
       JOIN resumes r ON r.id = jfs.resume_id
       WHERE jfs.job_id = ? AND r.user_id = ?
       ORDER BY jfs.overall_score DESC`
    )
    .all(job_id, user_id);
}

function getBestScorePerJobForUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `WITH user_scores AS (
         SELECT jfs.job_id, jfs.overall_score, jfs.resume_id, r.label
         FROM job_fit_scores jfs
         JOIN resumes r ON r.id = jfs.resume_id
         WHERE r.user_id = ?
       ),
       ranked AS (
         SELECT job_id, overall_score, resume_id, label,
                ROW_NUMBER() OVER (
                  PARTITION BY job_id
                  ORDER BY overall_score DESC, resume_id ASC
                ) AS rn
         FROM user_scores
       )
       SELECT job_id, overall_score AS display_score, label AS display_label, resume_id AS display_resume_id
       FROM ranked
       WHERE rn = 1`
    )
    .all(user_id);
}

function getBestScorePerJobForUserWithOverrides(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `WITH user_resumes AS (
         SELECT id, label FROM resumes WHERE user_id = ?
       ),
       best_match AS (
         SELECT jfs.job_id, jfs.overall_score, jfs.resume_id, ur.label,
                ROW_NUMBER() OVER (
                  PARTITION BY jfs.job_id
                  ORDER BY jfs.overall_score DESC, jfs.resume_id ASC
                ) AS rn
         FROM job_fit_scores jfs
         JOIN user_resumes ur ON ur.id = jfs.resume_id
       )
       SELECT j.id AS job_id,
              COALESCE(ov_jfs.overall_score, bm.overall_score) AS display_score,
              COALESCE(ov_r.label, bm.label) AS display_label,
              COALESCE(ro.resume_id, bm.resume_id) AS display_resume_id
       FROM jobs j
       LEFT JOIN resume_overrides ro ON ro.job_id = j.id AND ro.user_id = ?
       LEFT JOIN job_fit_scores ov_jfs ON ov_jfs.job_id = j.id AND ov_jfs.resume_id = ro.resume_id
       LEFT JOIN user_resumes ov_r ON ov_r.id = ro.resume_id
       LEFT JOIN best_match bm ON bm.job_id = j.id AND bm.rn = 1
       WHERE COALESCE(ov_jfs.overall_score, bm.overall_score) IS NOT NULL`
    )
    .all(user_id, user_id);
}

function deleteScoresForResume(resume_id) {
  const db = getDbInstance();
  const info = db
    .prepare('DELETE FROM job_fit_scores WHERE resume_id = ?')
    .run(resume_id);
  return info.changes;
}

function countScoresForResume(resume_id) {
  const db = getDbInstance();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM job_fit_scores WHERE resume_id = ?')
    .get(resume_id);
  return row ? row.c : 0;
}

module.exports = {
  upsertFitScore,
  getFitScore,
  getBestFitScoreForJob,
  getScoreForJobAndResume,
  getScoresForUser,
  getStats,
  findUnscoredJobsForResume,
  getScoresForJobByUser,
  getBestScorePerJobForUser,
  getBestScorePerJobForUserWithOverrides,
  deleteScoresForResume,
  countScoresForResume,
};
