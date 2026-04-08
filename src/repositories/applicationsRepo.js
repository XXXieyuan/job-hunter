const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function create({ user_id, job_id, status, notes, applied_at }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO applications (user_id, job_id, status, notes, applied_at)
     VALUES (@user_id, @job_id, @status, @notes, @applied_at)`
  );
  const info = stmt.run({
    user_id,
    job_id,
    status: status || 'saved',
    notes: notes || null,
    applied_at: applied_at || null,
  });
  return info.lastInsertRowid;
}

function findByUser(user_id, { status } = {}) {
  const db = getDbInstance();
  const conditions = ['a.user_id = @user_id'];
  const params = { user_id };

  if (status) {
    conditions.push('a.status = @status');
    params.status = status;
  }

  const where = conditions.join(' AND ');
  const sql = `
    SELECT a.*, j.title, j.company_name, j.location, j.source, j.url
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    WHERE ${where}
    ORDER BY a.status_updated_at DESC
  `;
  return db.prepare(sql).all(params);
}

function findByUserAndJob(user_id, job_id) {
  const db = getDbInstance();
  return db
    .prepare(
      'SELECT * FROM applications WHERE user_id = ? AND job_id = ?'
    )
    .get(user_id, job_id);
}

function findById(id, user_id) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?')
    .get(id, user_id);
}

function updateStatus(id, user_id, status) {
  const db = getDbInstance();
  const info = db
    .prepare(
      `UPDATE applications
       SET status = ?, status_updated_at = CURRENT_TIMESTAMP,
           applied_at = CASE WHEN ? = 'applied' AND applied_at IS NULL THEN CURRENT_TIMESTAMP ELSE applied_at END
       WHERE id = ? AND user_id = ?`
    )
    .run(status, status, id, user_id);
  return info.changes;
}

function updateNotes(id, user_id, notes) {
  const db = getDbInstance();
  const info = db
    .prepare(
      'UPDATE applications SET notes = ? WHERE id = ? AND user_id = ?'
    )
    .run(notes, id, user_id);
  return info.changes;
}

function deleteApplication(id, user_id) {
  const db = getDbInstance();
  const info = db
    .prepare('DELETE FROM applications WHERE id = ? AND user_id = ?')
    .run(id, user_id);
  return info.changes;
}

function countByStatus(user_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM applications
       WHERE user_id = ?
       GROUP BY status`
    )
    .all(user_id);
}

/**
 * Create application idempotently using INSERT OR IGNORE on UNIQUE(user_id, job_id).
 * Returns { id, created } where created indicates if a new row was inserted.
 */
function createIdempotent({ user_id, job_id, status }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO applications (user_id, job_id, status, status_updated_at)
     VALUES (@user_id, @job_id, @status, CURRENT_TIMESTAMP)`
  );
  const info = stmt.run({
    user_id,
    job_id,
    status: status || 'saved',
  });
  if (info.changes > 0) {
    return { id: info.lastInsertRowid, created: true };
  }
  // Already exists, return existing
  const existing = findByUserAndJob(user_id, job_id);
  return { id: existing.id, created: false };
}

/**
 * Update status and/or notes on an application. Ownership enforced.
 * Auto-sets applied_at on transition to 'applied'.
 */
function updateStatusAndNotes(id, user_id, { status, notes }) {
  const db = getDbInstance();
  const sets = ['status_updated_at = CURRENT_TIMESTAMP'];
  const params = { id, user_id };

  if (status !== undefined) {
    sets.push('status = @status');
    sets.push("applied_at = CASE WHEN @status = 'applied' AND applied_at IS NULL THEN CURRENT_TIMESTAMP ELSE applied_at END");
    params.status = status;
  }
  if (notes !== undefined) {
    sets.push('notes = @notes');
    params.notes = notes;
  }

  const sql = `UPDATE applications SET ${sets.join(', ')} WHERE id = @id AND user_id = @user_id`;
  const info = db.prepare(sql).run(params);
  return info.changes;
}

/**
 * Get applications for a user with pagination, nested job data, and optional fit_score.
 */
function findByUserPaginated(user_id, { status, sort, resumeId, limit, offset } = {}) {
  const db = getDbInstance();
  const conditions = ['a.user_id = @user_id'];
  const params = { user_id, resume_id: resumeId || -1 };

  if (status) {
    conditions.push('a.status = @status');
    params.status = status;
  }

  const where = conditions.join(' AND ');

  let orderBy;
  if (sort === 'score') {
    orderBy = 'COALESCE(fs.overall_score, 0) DESC';
  } else if (sort === 'company_name') {
    orderBy = 'j.company_name ASC';
  } else {
    orderBy = 'a.status_updated_at DESC';
  }

  params.limit = limit || 20;
  params.offset = offset || 0;

  const sql = `
    SELECT a.id, a.user_id, a.job_id, a.status, a.notes,
           a.applied_at, a.status_updated_at, a.created_at,
           j.title AS job_title, j.company_name AS job_company_name,
           j.location AS job_location, j.source AS job_source,
           j.url AS job_url, j.is_active AS job_is_active,
           fs.overall_score AS fs_overall_score
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    LEFT JOIN job_fit_scores fs ON fs.job_id = a.job_id AND fs.resume_id = @resume_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `;
  return db.prepare(sql).all(params);
}

/**
 * Count total applications for a user with optional status filter.
 */
function countForUser(user_id, status) {
  const db = getDbInstance();
  if (status) {
    return db.prepare(
      'SELECT COUNT(*) AS total FROM applications WHERE user_id = ? AND status = ?'
    ).get(user_id, status).total;
  }
  return db.prepare(
    'SELECT COUNT(*) AS total FROM applications WHERE user_id = ?'
  ).get(user_id).total;
}

/**
 * Get counts by status as an object with all 7 keys guaranteed.
 */
function countAllStatuses(user_id) {
  const db = getDbInstance();
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM applications
     WHERE user_id = ?
     GROUP BY status`
  ).all(user_id);

  const counts = {
    all: 0,
    saved: 0,
    applied: 0,
    interviewing: 0,
    offered: 0,
    rejected: 0,
    withdrawn: 0,
  };

  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status] = row.count;
    }
    counts.all += row.count;
  }

  return counts;
}

module.exports = {
  create,
  createIdempotent,
  findByUser,
  findByUserAndJob,
  findById,
  findByUserPaginated,
  updateStatus,
  updateNotes,
  updateStatusAndNotes,
  deleteApplication,
  countByStatus,
  countAllStatuses,
  countForUser,
};
