const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function normalizeSourceFilter(sourceValue) {
  if (!sourceValue) return [];
  if (Array.isArray(sourceValue)) {
    return sourceValue
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }
  return String(sourceValue)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function applySourceFilter(conditions, params, sourceValue, column = 'j.source') {
  const sources = normalizeSourceFilter(sourceValue);
  if (sources.length === 0) return;
  if (sources.length === 1) {
    conditions.push(`${column} = @source`);
    params.source = sources[0];
    return;
  }

  const placeholders = sources.map((source, index) => {
    const key = `source_${index}`;
    params[key] = source;
    return `@${key}`;
  });
  conditions.push(`${column} IN (${placeholders.join(', ')})`);
}

function extractIdentifierCandidates(rawKeyword) {
  if (!rawKeyword || typeof rawKeyword !== 'string') return [];

  const trimmed = rawKeyword.trim();
  if (!trimmed) return [];

  const candidates = new Set([trimmed]);

  try {
    const parsed = new URL(trimmed);
    const pathnameParts = parsed.pathname.split('/').filter(Boolean);
    const lastPart = pathnameParts[pathnameParts.length - 1];
    const genericPathParts = new Set(['job-details', 'job-search', 'search-jobs', 'jobs']);
    if (lastPart && !genericPathParts.has(String(lastPart).toLowerCase())) {
      candidates.add(lastPart);
      candidates.add(decodeURIComponent(lastPart));
    }
    const jobId = parsed.searchParams.get('Id') || parsed.searchParams.get('id');
    if (jobId) {
      candidates.add(jobId);
    }
  } catch {
    // Not a URL; keep the raw string only.
  }

  const referenceMatch = trimmed.match(/\b([A-Za-z]{2,}-\d{4,})\b/);
  if (referenceMatch) {
    candidates.add(referenceMatch[1]);
  }

  return Array.from(candidates)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function buildIdentifierMatchClause(params, rawKeyword) {
  const candidates = extractIdentifierCandidates(rawKeyword);
  if (candidates.length === 0) return null;

  const clauses = [];
  candidates.forEach((candidate, index) => {
    const key = `identifier_${index}`;
    const likeKey = `identifier_like_${index}`;
    params[key] = candidate;
    params[likeKey] = `%${candidate}%`;
    clauses.push(`j.external_id = @${key}`);
    clauses.push(`j.external_id LIKE @${likeKey}`);
    clauses.push(`j.url = @${key}`);
    clauses.push(`j.url LIKE @${likeKey}`);
    clauses.push(`j.raw_json LIKE @${likeKey}`);
  });

  return `(${clauses.join(' OR ')})`;
}

function insertJob(job) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO jobs (
      external_id, source, role, title, company_name, company_id, location,
      work_type, salary, salary_min, salary_max, description, url,
      posted_at, closes_at, visa_eligibility, security_clearance,
      aps_classification, is_active, raw_json, scraped_at
    ) VALUES (
      @external_id, @source, @role, @title, @company_name, @company_id, @location,
      @work_type, @salary, @salary_min, @salary_max, @description, @url,
      @posted_at, @closes_at, @visa_eligibility, @security_clearance,
      @aps_classification, @is_active, @raw_json, @scraped_at
    )`
  );
  const info = stmt.run({
    external_id: job.external_id || null,
    source: job.source || 'manual',
    role: job.role,
    title: job.title,
    company_name: job.company_name || null,
    company_id: job.company_id || null,
    location: job.location || null,
    work_type: job.work_type || null,
    salary: job.salary || null,
    salary_min: job.salary_min || null,
    salary_max: job.salary_max || null,
    description: job.description || null,
    url: job.url || null,
    posted_at: job.posted_at || null,
    closes_at: job.closes_at || null,
    visa_eligibility: job.visa_eligibility || null,
    security_clearance: job.security_clearance || null,
    aps_classification: job.aps_classification || null,
    is_active: job.is_active !== undefined ? job.is_active : 1,
    raw_json: job.raw_json || null,
    scraped_at: job.scraped_at || null,
  });
  return info.lastInsertRowid;
}

function insertManyJobs(jobs) {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO jobs (
      external_id, source, role, title, company_name, location, salary,
      description, url, posted_at, raw_json
    ) VALUES (
      @external_id, @source, @role, @title, @company_name, @location, @salary,
      @description, @url, @posted_at, @raw_json
    )`
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  insertMany(jobs);
}

function upsertManyJobs(jobs) {
  const db = getDbInstance();
  const upsert = db.prepare(
    `INSERT INTO jobs (
      external_id, source, role, title, company_name, location, salary,
      salary_min, salary_max, work_type, description, url,
      posted_at, closes_at, visa_eligibility, security_clearance,
      aps_classification, raw_json, scraped_at
    ) VALUES (
      @external_id, @source, @role, @title, @company_name, @location, @salary,
      @salary_min, @salary_max, @work_type, @description, @url,
      @posted_at, @closes_at, @visa_eligibility, @security_clearance,
      @aps_classification, @raw_json, @scraped_at
    )
    ON CONFLICT(external_id) DO UPDATE SET
      title = excluded.title,
      company_name = excluded.company_name,
      location = excluded.location,
      salary = excluded.salary,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      work_type = excluded.work_type,
      description = excluded.description,
      url = excluded.url,
      posted_at = excluded.posted_at,
      closes_at = excluded.closes_at,
      visa_eligibility = COALESCE(excluded.visa_eligibility, jobs.visa_eligibility),
      security_clearance = COALESCE(excluded.security_clearance, jobs.security_clearance),
      aps_classification = COALESCE(excluded.aps_classification, jobs.aps_classification),
      raw_json = excluded.raw_json,
      scraped_at = excluded.scraped_at,
      updated_at = CURRENT_TIMESTAMP`
  );
  const upsertTx = db.transaction((rows) => {
    let newCount = 0;
    let updatedCount = 0;
    for (const row of rows) {
      const info = upsert.run({
        external_id: row.external_id || null,
        source: row.source || 'manual',
        role: row.role || 'general',
        title: row.title,
        company_name: row.company_name || null,
        location: row.location || null,
        salary: row.salary || null,
        salary_min: row.salary_min || null,
        salary_max: row.salary_max || null,
        work_type: row.work_type || null,
        description: row.description || null,
        url: row.url || null,
        posted_at: row.posted_at || null,
        closes_at: row.closes_at || null,
        visa_eligibility: row.visa_eligibility || null,
        security_clearance: row.security_clearance || null,
        aps_classification: row.aps_classification || null,
        raw_json: row.raw_json || null,
        scraped_at: row.scraped_at || null,
      });
      if (info.changes > 0 && info.lastInsertRowid) {
        newCount++;
      } else {
        updatedCount++;
      }
    }
    return { newCount, updatedCount };
  });
  return upsertTx(jobs);
}

function getJobById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getJobByExternalId(external_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM jobs WHERE external_id = ?')
    .get(external_id);
}

function getJobsWithScore(filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  if (filters.role) {
    conditions.push('j.role = @role');
    params.role = filters.role;
  }
  applySourceFilter(conditions, params, filters.source);
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }
  // Exclude duplicates by default (only show canonical or non-duplicate jobs)
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sort =
    filters.sort === 'posted_at'
      ? 'j.posted_at DESC'
      : 'COALESCE(fs.overall_score, 0) DESC, j.created_at DESC';

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const sql = `
    SELECT
      j.*,
      fs.overall_score,
      fs.semantic_score,
      fs.keyword_score,
      fs.role_alignment_score,
      fs.location_score
    FROM jobs j
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id
    ${where}
    ORDER BY ${sort}
    LIMIT @limit OFFSET @offset
  `;

  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params);
}

/**
 * Full-text search using FTS5 index with fallback to LIKE.
 * @param {string} ftsQuery - Sanitized FTS5 query string (from ftsQuerySanitizer)
 * @param {object} filters - Additional filters (same as getJobsWithScore)
 */
function searchJobs(ftsQuery, filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  applySourceFilter(conditions, params, filters.source);
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  params.ftsQuery = ftsQuery;
  params.limit = limit;
  params.offset = offset;

  const sql = `
    SELECT j.*, fs.overall_score, fs.semantic_score, fs.keyword_score,
           fs.role_alignment_score, fs.location_score
    FROM jobs j
    JOIN jobs_fts ON jobs_fts.rowid = j.id
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id
    WHERE jobs_fts MATCH @ftsQuery
    ${where}
    ORDER BY rank
    LIMIT @limit OFFSET @offset
  `;

  return db.prepare(sql).all(params);
}

function searchJobsByIdentifier(rawKeyword, filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  applySourceFilter(conditions, params, filters.source);
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const identifierClause = buildIdentifierMatchClause(params, rawKeyword);
  if (!identifierClause) return [];

  conditions.push(identifierClause);
  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const sql = `
    SELECT
      j.*,
      fs.overall_score,
      fs.semantic_score,
      fs.keyword_score,
      fs.role_alignment_score,
      fs.location_score,
      fs.overall_score AS fs_overall_score,
      fs.visa_match AS fs_visa_match,
      fs.breakdown_json AS fs_breakdown_json
    FROM jobs j
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id
    ${where}
    ORDER BY j.posted_at DESC, j.created_at DESC
    LIMIT @limit OFFSET @offset
  `;

  params.limit = limit;
  params.offset = offset;
  return db.prepare(sql).all(params);
}

/**
 * Find potential duplicate jobs by title + company match.
 */
function findDuplicateCandidates(title, company_name) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id, external_id, source, title, company_name, url
       FROM jobs
       WHERE company_name = ? AND title = ? AND is_active = 1 AND canonical_job_id IS NULL`
    )
    .all(company_name, title);
}

function getJobCounts() {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
  const active = db
    .prepare('SELECT COUNT(*) AS c FROM jobs WHERE is_active = 1')
    .get().c;
  const withScore = db
    .prepare(
      'SELECT COUNT(DISTINCT job_id) AS c FROM job_fit_scores WHERE overall_score IS NOT NULL'
    )
    .get().c;
  const bySource = db
    .prepare(
      'SELECT source, COUNT(*) AS count FROM jobs GROUP BY source'
    )
    .all();
  return { total, active, withScore, bySource };
}

function getActiveJobIds() {
  const db = getDbInstance();
  return db
    .prepare('SELECT id FROM jobs WHERE is_active = 1 AND canonical_job_id IS NULL')
    .all()
    .map((r) => r.id);
}

/**
 * Fetch active non-duplicate jobs that still lack a stored embedding. Used
 * by the embed-jobs background task to backfill and keep the precompute
 * cache warm. Returns enough columns for buildJobEmbeddingText.
 */
function getJobsMissingEmbedding(limit = 1000) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id, title, role, company_name, location, description
         FROM jobs
        WHERE is_active = 1
          AND canonical_job_id IS NULL
          AND embedding IS NULL
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(limit);
}

/**
 * Persist an embedding BLOB for a job. Mirrors resumesRepo.updateEmbedding
 * so encode/decode shape is identical between the two tables.
 */
function updateJobEmbedding(id, embeddingBuffer, embeddingModel) {
  const db = getDbInstance();
  return db
    .prepare(
      'UPDATE jobs SET embedding = ?, embedding_model = ? WHERE id = ?'
    )
    .run(embeddingBuffer, embeddingModel, id);
}

/**
 * Auto-add the required_skills_json column on first use (mirrors the
 * progress_message pattern elsewhere — avoids a full migration file for a
 * single nullable TEXT column).
 */
let _requiredSkillsColumnEnsured = false;
function ensureRequiredSkillsColumn(db) {
  if (_requiredSkillsColumnEnsured) return;
  const cols = db.pragma('table_info(jobs)').map((c) => c.name);
  if (!cols.includes('required_skills_json')) {
    db.exec('ALTER TABLE jobs ADD COLUMN required_skills_json TEXT');
  }
  _requiredSkillsColumnEnsured = true;
}

/**
 * All active non-duplicate jobs that already have a non-empty
 * required_skills_json. Used by the embed-skills sweep to collect the
 * universe of skill names for global embedding.
 */
function getAllJobsWithRequiredSkills() {
  const db = getDbInstance();
  ensureRequiredSkillsColumn(db);
  return db
    .prepare(
      `SELECT id, required_skills_json
         FROM jobs
        WHERE is_active = 1
          AND canonical_job_id IS NULL
          AND required_skills_json IS NOT NULL
          AND required_skills_json != ''`
    )
    .all();
}

function getJobsMissingRequiredSkills(limit = 200) {
  const db = getDbInstance();
  ensureRequiredSkillsColumn(db);
  return db
    .prepare(
      `SELECT id, title, description
         FROM jobs
        WHERE is_active = 1
          AND canonical_job_id IS NULL
          AND (required_skills_json IS NULL OR required_skills_json = '')
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(limit);
}

function updateJobRequiredSkills(id, requiredSkillsJson) {
  const db = getDbInstance();
  ensureRequiredSkillsColumn(db);
  return db
    .prepare('UPDATE jobs SET required_skills_json = ? WHERE id = ?')
    .run(requiredSkillsJson, id);
}

function markInactive(id) {
  const db = getDbInstance();
  return db
    .prepare(
      'UPDATE jobs SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    .run(id).changes;
}

function clearRawJsonOlderThan(days) {
  const db = getDbInstance();
  return db
    .prepare(
      `UPDATE jobs SET raw_json = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE raw_json IS NOT NULL AND created_at < datetime('now', '-' || ? || ' days')`
    )
    .run(days).changes;
}

/**
 * Count total jobs matching filters (for pagination).
 * Mirrors getJobsWithScore filter logic but returns only the count.
 */
function countJobs(filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  if (filters.source) {
    const sources = filters.source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push('j.source = @source');
      params.source = sources[0];
    } else if (sources.length > 1) {
      const placeholders = sources.map((s, i) => {
        params[`source_${i}`] = s;
        return `@source_${i}`;
      });
      conditions.push(`j.source IN (${placeholders.join(', ')})`);
    }
  }
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }
  if (typeof filters.min_salary === 'number') {
    conditions.push('j.salary_min IS NOT NULL AND j.salary_min >= @min_salary');
    params.min_salary = filters.min_salary;
  }
  if (typeof filters.max_salary === 'number') {
    conditions.push('j.salary_min IS NOT NULL AND j.salary_min <= @max_salary');
    params.max_salary = filters.max_salary;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const needsScoreJoin = typeof filters.minScore === 'number';
  const scoreJoin = needsScoreJoin ? 'LEFT JOIN job_fit_scores fs ON fs.job_id = j.id' : '';

  const sql = `SELECT COUNT(*) AS total FROM jobs j ${scoreJoin} ${where}`;
  return db.prepare(sql).get(params).total;
}

/**
 * Count total FTS search results matching filters.
 */
function countSearchJobs(ftsQuery, filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = { ftsQuery };

  if (filters.source) {
    const sources = filters.source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push('j.source = @source');
      params.source = sources[0];
    } else if (sources.length > 1) {
      const placeholders = sources.map((s, i) => {
        params[`source_${i}`] = s;
        return `@source_${i}`;
      });
      conditions.push(`j.source IN (${placeholders.join(', ')})`);
    }
  }
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT COUNT(*) AS total
    FROM jobs j
    JOIN jobs_fts ON jobs_fts.rowid = j.id
    WHERE jobs_fts MATCH @ftsQuery
    ${where}
  `;
  return db.prepare(sql).get(params).total;
}

function countJobsByIdentifier(rawKeyword, filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  applySourceFilter(conditions, params, filters.source);
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const identifierClause = buildIdentifierMatchClause(params, rawKeyword);
  if (!identifierClause) return 0;

  conditions.push(identifierClause);
  const where = `WHERE ${conditions.join(' AND ')}`;
  const scoreJoin = typeof filters.minScore === 'number'
    ? 'LEFT JOIN job_fit_scores fs ON fs.job_id = j.id'
    : 'LEFT JOIN job_fit_scores fs ON fs.job_id = j.id';
  const sql = `SELECT COUNT(*) AS total FROM jobs j ${scoreJoin} ${where}`;
  return db.prepare(sql).get(params).total;
}

/**
 * API-ready job listing with comma-separated source filter, salary filters,
 * and sort options including salary (nulls last).
 */
function getJobsApi(filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = {};

  if (filters.source) {
    const sources = filters.source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push('j.source = @source');
      params.source = sources[0];
    } else if (sources.length > 1) {
      const placeholders = sources.map((s, i) => {
        params[`source_${i}`] = s;
        return `@source_${i}`;
      });
      conditions.push(`j.source IN (${placeholders.join(', ')})`);
    }
  }
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (typeof filters.minScore === 'number') {
    conditions.push('fs.overall_score >= @minScore');
    params.minScore = filters.minScore;
  }
  if (typeof filters.min_salary === 'number') {
    conditions.push('j.salary_min IS NOT NULL AND j.salary_min >= @min_salary');
    params.min_salary = filters.min_salary;
  }
  if (typeof filters.max_salary === 'number') {
    conditions.push('j.salary_min IS NOT NULL AND j.salary_min <= @max_salary');
    params.max_salary = filters.max_salary;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  let sort;
  if (filters.sort === 'salary') {
    sort = `CASE WHEN j.salary_min IS NULL THEN 1 ELSE 0 END, j.salary_min ${order}`;
  } else if (filters.sort === 'score') {
    sort = `COALESCE(fs.overall_score, 0) ${order}, j.posted_at DESC`;
  } else {
    sort = `j.posted_at ${order}`;
  }

  const limit = filters.limit || 20;
  const offset = filters.offset || 0;

  const sql = `
    SELECT
      j.id, j.title, j.company_name, j.location, j.work_type,
      j.salary, j.salary_min, j.salary_max, j.source, j.posted_at,
      j.closes_at, j.visa_eligibility, j.security_clearance,
      j.aps_classification, j.is_active, j.url,
      fs.overall_score AS fs_overall_score,
      fs.visa_match AS fs_visa_match,
      fs.breakdown_json AS fs_breakdown_json
    FROM jobs j
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id AND fs.resume_id = @resume_id
    ${where}
    ORDER BY ${sort}
    LIMIT @limit OFFSET @offset
  `;

  params.limit = limit;
  params.offset = offset;
  params.resume_id = filters.resume_id || -1;

  return db.prepare(sql).all(params);
}

/**
 * API-ready FTS5 search with total count support.
 */
function searchJobsApi(ftsQuery, filters = {}) {
  const db = getDbInstance();
  const conditions = ['j.is_active = 1'];
  const params = { ftsQuery };

  if (filters.source) {
    const sources = filters.source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push('j.source = @source');
      params.source = sources[0];
    } else if (sources.length > 1) {
      const placeholders = sources.map((s, i) => {
        params[`source_${i}`] = s;
        return `@source_${i}`;
      });
      conditions.push(`j.source IN (${placeholders.join(', ')})`);
    }
  }
  if (filters.location) {
    conditions.push('j.location LIKE @location');
    params.location = `%${filters.location}%`;
  }
  if (filters.work_type) {
    conditions.push('j.work_type = @work_type');
    params.work_type = filters.work_type;
  }
  if (filters.visa_eligibility) {
    conditions.push('j.visa_eligibility = @visa_eligibility');
    params.visa_eligibility = filters.visa_eligibility;
  }
  if (filters.aps_classification) {
    conditions.push('j.aps_classification = @aps_classification');
    params.aps_classification = filters.aps_classification;
  }
  if (!filters.includeDuplicates) {
    conditions.push('j.canonical_job_id IS NULL');
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 20;
  const offset = filters.offset || 0;

  params.limit = limit;
  params.offset = offset;
  params.resume_id = filters.resume_id || -1;

  const sql = `
    SELECT
      j.id, j.title, j.company_name, j.location, j.work_type,
      j.salary, j.salary_min, j.salary_max, j.source, j.posted_at,
      j.closes_at, j.visa_eligibility, j.security_clearance,
      j.aps_classification, j.is_active, j.url,
      fs.overall_score AS fs_overall_score,
      fs.visa_match AS fs_visa_match,
      fs.breakdown_json AS fs_breakdown_json
    FROM jobs j
    JOIN jobs_fts ON jobs_fts.rowid = j.id
    LEFT JOIN job_fit_scores fs ON fs.job_id = j.id AND fs.resume_id = @resume_id
    WHERE jobs_fts MATCH @ftsQuery
    ${where}
    ORDER BY rank
    LIMIT @limit OFFSET @offset
  `;

  return db.prepare(sql).all(params);
}

/**
 * Get duplicate sources for a job (from duplicate_group_members).
 */
function getDuplicateSourcesForJob(jobId) {
  const db = getDbInstance();
  return db.prepare(
    `SELECT j.source, j.url, j.external_id
     FROM duplicate_group_members dgm
     JOIN duplicate_groups dg ON dg.id = dgm.group_id
     JOIN jobs j ON j.id = dgm.job_id
     WHERE dg.canonical_job_id = ? AND dgm.job_id != ?`
  ).all(jobId, jobId);
}

/**
 * Get application for a specific user and job.
 */
function getJobApplicationForUser(jobId, userId) {
  const db = getDbInstance();
  return db.prepare(
    'SELECT id, status, notes, applied_at, status_updated_at FROM applications WHERE job_id = ? AND user_id = ?'
  ).get(jobId, userId);
}

/**
 * Update visa eligibility and security clearance for a job.
 */
function updateVisaInfo(jobId, { visa_eligibility, security_clearance }) {
  const db = getDbInstance();
  return db.prepare(
    `UPDATE jobs
     SET visa_eligibility = @visa_eligibility, security_clearance = @security_clearance, updated_at = CURRENT_TIMESTAMP
     WHERE id = @jobId`
  ).run({ visa_eligibility, security_clearance, jobId }).changes;
}

/**
 * Get active jobs that haven't had visa info extracted yet.
 */
function getJobsWithoutVisaInfo() {
  const db = getDbInstance();
  return db.prepare(
    `SELECT id, description FROM jobs
     WHERE is_active = 1
       AND (visa_eligibility IS NULL OR visa_eligibility = 'not_specified')
       AND description IS NOT NULL`
  ).all();
}

function archiveInactive(days) {
  const db = getDbInstance();
  return db.prepare(
    `UPDATE jobs SET is_active = 0, updated_at = CURRENT_TIMESTAMP
     WHERE is_active = 1 AND updated_at < datetime('now', '-' || ? || ' days')`
  ).run(days).changes;
}

function countActiveNonDuplicate() {
  const db = getDbInstance();
  return db.prepare(
    'SELECT COUNT(*) AS c FROM jobs WHERE is_active = 1 AND canonical_job_id IS NULL'
  ).get().c;
}

module.exports = {
  insertJob,
  insertManyJobs,
  upsertManyJobs,
  getJobById,
  getJobByExternalId,
  getJobsWithScore,
  searchJobs,
  searchJobsByIdentifier,
  getJobsApi,
  searchJobsApi,
  countJobs,
  countSearchJobs,
  countJobsByIdentifier,
  findDuplicateCandidates,
  getJobCounts,
  getActiveJobIds,
  getJobsMissingEmbedding,
  updateJobEmbedding,
  getJobsMissingRequiredSkills,
  getAllJobsWithRequiredSkills,
  updateJobRequiredSkills,
  getDuplicateSourcesForJob,
  getJobApplicationForUser,
  markInactive,
  clearRawJsonOlderThan,
  updateVisaInfo,
  getJobsWithoutVisaInfo,
  archiveInactive,
  countActiveNonDuplicate,
  // Exported for testing
  _normalizeSourceFilter: normalizeSourceFilter,
  _applySourceFilter: applySourceFilter,
  _extractIdentifierCandidates: extractIdentifierCandidates,
  _buildIdentifierMatchClause: buildIdentifierMatchClause,
};
