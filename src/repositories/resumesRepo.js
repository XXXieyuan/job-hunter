const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getAllResumes() {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM resumes ORDER BY created_at DESC').all();
}

function getResumeById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM resumes WHERE id = ?').get(id);
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
      name,
      summary,
      skills_json,
      experience_json,
      education_json,
      raw_json,
      file_name,
      file_type,
      storage_path,
      is_main,
      parsed_data
    )
    VALUES (
      @name,
      @summary,
      @skills_json,
      @experience_json,
      @education_json,
      @raw_json,
      @file_name,
      @file_type,
      @storage_path,
      @is_main,
      @parsed_data
    )`
  );
  const info = stmt.run(resume);
  return info.lastInsertRowid;
}

function deleteResume(id) {
  const db = getDbInstance();
  const stmt = db.prepare('DELETE FROM resumes WHERE id = ?');
  const info = stmt.run(id);
  return info.changes;
}

function clearMainResume() {
  const db = getDbInstance();
  const stmt = db.prepare('UPDATE resumes SET is_main = 0 WHERE is_main != 0');
  stmt.run();
}

function setMainResume(id) {
  const db = getDbInstance();
  clearMainResume();
  const stmt = db.prepare('UPDATE resumes SET is_main = 1 WHERE id = ?');
  const info = stmt.run(id);
  return info.changes;
}

function getMainResume() {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM resumes WHERE is_main = 1 ORDER BY created_at DESC LIMIT 1')
    .get();
}

module.exports = {
  getAllResumes,
  getResumeById,
  getResumeCount,
  insertResume,
  deleteResume,
  clearMainResume,
  setMainResume,
  getMainResume,
};
