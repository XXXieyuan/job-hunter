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
    `INSERT INTO resumes (name, summary, skills_json, experience_json, education_json, raw_json)
     VALUES (@name, @summary, @skills_json, @experience_json, @education_json, @raw_json)`
  );
  const info = stmt.run(resume);
  return info.lastInsertRowid;
}

module.exports = {
  getAllResumes,
  getResumeById,
  getResumeCount,
  insertResume,
};

