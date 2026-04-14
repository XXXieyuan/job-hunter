const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getCoverLetter(jobId, resumeId, language = 'en', mode = 'standard') {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT * FROM cover_letters
       WHERE job_id = ? AND resume_id = ? AND language = ? AND mode = ?`
    )
    .get(jobId, resumeId, language, mode);
}

function getCoverLetterById(id, user_id) {
  const db = getDbInstance();
  if (user_id !== undefined) {
    return db
      .prepare('SELECT * FROM cover_letters WHERE id = ? AND user_id = ?')
      .get(id, user_id);
  }
  return db.prepare('SELECT * FROM cover_letters WHERE id = ?').get(id);
}

function getCoverLettersByUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT cl.*, j.title AS job_title, j.company_name
       FROM cover_letters cl
       JOIN jobs j ON j.id = cl.job_id
       WHERE cl.user_id = ?
       ORDER BY cl.updated_at DESC`
    )
    .all(user_id);
}

function upsertCoverLetter({
  job_id,
  resume_id,
  user_id,
  language = 'en',
  mode = 'standard',
  content,
  prompt_version,
}) {
  const db = getDbInstance();
  const existing = getCoverLetter(job_id, resume_id, language, mode);
  if (existing) {
    db.prepare(
      `UPDATE cover_letters
       SET content = ?, prompt_version = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(content, prompt_version || null, existing.id);
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO cover_letters (job_id, resume_id, user_id, language, mode, content, prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(job_id, resume_id, user_id, language, mode, content, prompt_version || null);
  return info.lastInsertRowid;
}

function updateUserEditedContent(id, user_id, user_edited_content) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `UPDATE cover_letters
       SET user_edited_content = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    )
    .run(user_edited_content, id, user_id);
  return info.changes;
}

function deleteCoverLetter(id, user_id) {
  const db = getDbInstance();
  const info = db
    .prepare('DELETE FROM cover_letters WHERE id = ? AND user_id = ?')
    .run(id, user_id);
  return info.changes;
}

/**
 * Get all cover letters for a job+resume pair (all modes/languages).
 * Returns array with id, language, mode, content, user_edited_content, created_at, updated_at.
 */
function getCoverLettersForJobAndResume(jobId, resumeId) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id, language, mode, content, user_edited_content, created_at, updated_at
       FROM cover_letters
       WHERE job_id = ? AND resume_id = ?
       ORDER BY created_at DESC`
    )
    .all(jobId, resumeId);
}

function getCount() {
  const db = getDbInstance();
  return db.prepare('SELECT COUNT(*) AS c FROM cover_letters').get().c;
}

function countForResume(resume_id) {
  const db = getDbInstance();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM cover_letters WHERE resume_id = ?')
    .get(resume_id);
  return row ? row.c : 0;
}

module.exports = {
  getCoverLetter,
  getCoverLetterById,
  getCoverLettersByUser,
  getCoverLettersForJobAndResume,
  upsertCoverLetter,
  updateUserEditedContent,
  deleteCoverLetter,
  getCount,
  countForResume,
};
