const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function insertJob(job) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO jobs (
      external_id, source, role, title, company_name, location, salary,
      description, url, posted_at, application_status, raw_json
    ) VALUES (
      @external_id, @source, @role, @title, @company_name, @location, @salary,
      @description, @url, @posted_at, @application_status, @raw_json
    )`
  );
  const info = stmt.run(job);
  return info.lastInsertRowid;
}

function insertManyJobs(jobs) {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO jobs (
      external_id, source, role, title, company_name, location, salary,
      description, url, posted_at, application_status, raw_json
    ) VALUES (
      @external_id, @source, @role, @title, @company_name, @location, @salary,
      @description, @url, @posted_at, @application_status, @raw_json
    )`
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  insertMany(jobs);
}

function getJobById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getJobsWithScore(filters = {}) {
  const db = getDbInstance();
  const conditions = [];
  const params = {};

  if (filters.role) {
    conditions.push('j.role = @role');
    params.role = filters.role;
  }
  if (filters.source) {
    conditions.push('j.source = @source');
    params.source = filters.source;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      j.*,
      fs.overall_score,
      fs.keyword_score,
      fs.embedding_score
    FROM jobs j
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id
    ${where}
    ORDER BY COALESCE(fs.overall_score, 0) DESC, j.created_at DESC
  `;

  return db.prepare(sql).all(params);
}

function getJobCounts() {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
  const withScore = db
    .prepare(
      'SELECT COUNT(DISTINCT job_id) AS c FROM job_fit_scores WHERE overall_score IS NOT NULL'
    )
    .get().c;
  return { total, withScore };
}

module.exports = {
  insertJob,
  insertManyJobs,
  getJobById,
  getJobsWithScore,
  getJobCounts,
};

