const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getAllResumes() {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM resumes ORDER BY created_at DESC').all();
}

function getResumesByUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM resumes WHERE user_id = ? ORDER BY created_at DESC')
    .all(user_id);
}

function getResumeById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM resumes WHERE id = ?').get(id);
}

function getResumeByIdAndUser(id, user_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM resumes WHERE id = ? AND user_id = ?')
    .get(id, user_id);
}

function getResumeCount() {
  const db = getDbInstance();
  const row = db.prepare('SELECT COUNT(*) AS count FROM resumes').get();
  return row.count;
}

function insertResume(resume) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO resumes (
      user_id, name, file_path, file_type, summary,
      skills_json, experience_json, education_json,
      certifications_json, raw_text, is_confirmed, label
    )
    VALUES (
      @user_id, @name, @file_path, @file_type, @summary,
      @skills_json, @experience_json, @education_json,
      @certifications_json, @raw_text, @is_confirmed, @label
    )`
  );
  const info = stmt.run({
    user_id: resume.user_id,
    name: resume.name,
    file_path: resume.file_path || null,
    file_type: resume.file_type || null,
    summary: resume.summary || null,
    skills_json: resume.skills_json || null,
    experience_json: resume.experience_json || null,
    education_json: resume.education_json || null,
    certifications_json: resume.certifications_json || null,
    raw_text: resume.raw_text || null,
    is_confirmed: resume.is_confirmed || 0,
    label: resume.label || null,
  });
  return info.lastInsertRowid;
}

function updateExtractedData(id, user_id, data) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `UPDATE resumes SET
      summary = @summary,
      skills_json = @skills_json,
      experience_json = @experience_json,
      education_json = @education_json,
      certifications_json = @certifications_json,
      is_confirmed = @is_confirmed,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND user_id = @user_id`
  );
  const info = stmt.run({
    id,
    user_id,
    summary: data.summary || null,
    skills_json: data.skills_json || null,
    experience_json: data.experience_json || null,
    education_json: data.education_json || null,
    certifications_json: data.certifications_json || null,
    is_confirmed: data.is_confirmed || 0,
  });
  return info.changes;
}

function updateEmbedding(id, embedding, embedding_model) {
  const db = getDbInstance();
  const info = db
    .prepare(
      'UPDATE resumes SET embedding = ?, embedding_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    .run(embedding, embedding_model, id);
  return info.changes;
}

function deleteResume(id, user_id) {
  const db = getDbInstance();
  // Cascade-delete dependent records to avoid FK constraint errors
  db.prepare('DELETE FROM job_fit_scores WHERE resume_id = ?').run(id);
  db.prepare('DELETE FROM cover_letters WHERE resume_id = ?').run(id);
  db.prepare('DELETE FROM resume_overrides WHERE resume_id = ?').run(id);
  if (user_id !== undefined) {
    return db
      .prepare('DELETE FROM resumes WHERE id = ? AND user_id = ?')
      .run(id, user_id).changes;
  }
  return db.prepare('DELETE FROM resumes WHERE id = ?').run(id).changes;
}

function getConfirmedResumeForUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM resumes WHERE user_id = ? AND is_confirmed = 1 ORDER BY updated_at DESC LIMIT 1'
    )
    .get(user_id);
}

// Legacy compatibility: kept for existing code that may call these
function clearMainResume() {
  // no-op in new schema (is_main replaced by is_confirmed)
}

function setMainResume(id) {
  const db = getDbInstance();
  return db
    .prepare('UPDATE resumes SET is_confirmed = 1 WHERE id = ?')
    .run(id).changes;
}

function getMainResume() {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM resumes WHERE is_confirmed = 1 ORDER BY updated_at DESC LIMIT 1'
    )
    .get();
}

function countResumesForUser(user_id) {
  const db = getDbInstance();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM resumes WHERE user_id = ?')
    .get(user_id);
  return row ? row.c : 0;
}

function countConfirmedResumesForUser(user_id) {
  const db = getDbInstance();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM resumes WHERE user_id = ? AND is_confirmed = 1'
  ).get(user_id);
  return row ? row.c : 0;
}

function getConfirmedResumesForUser(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM resumes WHERE user_id = ? AND is_confirmed = 1 ORDER BY created_at DESC'
    )
    .all(user_id);
}

function getResumesWithCascadeCounts(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT r.id, r.label, r.name AS file_name, r.created_at, r.is_confirmed,
              COALESCE(sc.cnt, 0) AS score_count,
              COALESCE(cl.cnt, 0) AS cover_letter_count
       FROM resumes r
       LEFT JOIN (SELECT resume_id, COUNT(*) AS cnt FROM job_fit_scores GROUP BY resume_id) sc
         ON sc.resume_id = r.id
       LEFT JOIN (SELECT resume_id, COUNT(*) AS cnt FROM cover_letters GROUP BY resume_id) cl
         ON cl.resume_id = r.id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC`
    )
    .all(user_id);
}

function updateLabel(id, user_id, label) {
  const db = getDbInstance();
  const info = db
    .prepare(
      'UPDATE resumes SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    )
    .run(label, id, user_id);
  return info.changes;
}

function countUsersWithResume() {
  const db = getDbInstance();
  const row = db.prepare(
    'SELECT COUNT(DISTINCT user_id) AS c FROM resumes WHERE user_id IS NOT NULL'
  ).get();
  return row ? row.c : 0;
}

module.exports = {
  getAllResumes,
  getResumesByUser,
  getResumeById,
  getResumeByIdAndUser,
  getResumeCount,
  insertResume,
  updateExtractedData,
  updateEmbedding,
  deleteResume,
  getConfirmedResumeForUser,
  countResumesForUser,
  countConfirmedResumesForUser,
  getConfirmedResumesForUser,
  getResumesWithCascadeCounts,
  updateLabel,
  clearMainResume,
  setMainResume,
  getMainResume,
  countUsersWithResume,
};
