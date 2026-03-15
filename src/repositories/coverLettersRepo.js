const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getCoverLetter(jobId, resumeId, language = 'en') {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM cover_letters WHERE job_id = ? AND resume_id = ? AND language = ?'
    )
    .get(jobId, resumeId, language);
}

function upsertCoverLetter({ job_id, resume_id, language = 'en', content }) {
  const db = getDbInstance();
  const existing = getCoverLetter(job_id, resume_id, language);
  if (existing) {
    db.prepare('UPDATE cover_letters SET content = ? WHERE id = ?').run(
      content,
      existing.id
    );
    return existing.id;
  }
  const info = db
    .prepare(
      'INSERT INTO cover_letters (job_id, resume_id, language, content) VALUES (?, ?, ?, ?)'
    )
    .run(job_id, resume_id, language, content);
  return info.lastInsertRowid;
}

module.exports = {
  getCoverLetter,
  upsertCoverLetter,
};

