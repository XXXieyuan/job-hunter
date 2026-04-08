const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function create({ user_id, job_id, resume_id, feedback_type, comment }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO score_feedback (user_id, job_id, resume_id, feedback_type, comment)
     VALUES (@user_id, @job_id, @resume_id, @feedback_type, @comment)`
  );
  const info = stmt.run({
    user_id,
    job_id,
    resume_id,
    feedback_type,
    comment: comment || null,
  });
  return info.lastInsertRowid;
}

function findByUserAndJob(user_id, job_id) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM score_feedback WHERE user_id = ? AND job_id = ?'
    )
    .get(user_id, job_id);
}

function findByJob(job_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM score_feedback WHERE job_id = ? ORDER BY created_at DESC')
    .all(job_id);
}

function getStats() {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT feedback_type, COUNT(*) AS count
       FROM score_feedback
       GROUP BY feedback_type`
    )
    .all();
}

function findById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM score_feedback WHERE id = ?').get(id);
}

module.exports = {
  create,
  findById,
  findByUserAndJob,
  findByJob,
  getStats,
};
