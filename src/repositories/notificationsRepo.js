'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

/**
 * Insert a notification. Uses INSERT OR IGNORE to respect UNIQUE(user_id, job_id).
 * Returns the inserted row or null if duplicate.
 */
function create({ user_id, job_id, score, top_matched_skills, visa_match, frequency, read_token }) {
  const db = getDbInstance();
  const info = db.prepare(
    `INSERT OR IGNORE INTO notifications
     (user_id, job_id, score, top_matched_skills, visa_match, frequency, read_token)
     VALUES (@user_id, @job_id, @score, @top_matched_skills, @visa_match, @frequency, @read_token)`
  ).run({
    user_id,
    job_id,
    score,
    top_matched_skills: top_matched_skills || '[]',
    visa_match: visa_match !== undefined ? visa_match : null,
    frequency: frequency || 'immediate',
    read_token: read_token || null,
  });

  if (info.changes === 0) {
    return null;
  }

  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Insert a batch of notifications in a transaction. Max 20 per batch.
 * Returns array of inserted rows (skips duplicates).
 */
function createBatch(notifications) {
  const db = getDbInstance();
  const capped = notifications.slice(0, 20);
  const inserted = [];

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO notifications
     (user_id, job_id, score, top_matched_skills, visa_match, frequency, read_token)
     VALUES (@user_id, @job_id, @score, @top_matched_skills, @visa_match, @frequency, @read_token)`
  );
  const selectStmt = db.prepare('SELECT * FROM notifications WHERE id = ?');

  const tx = db.transaction((items) => {
    for (const item of items) {
      const info = insertStmt.run({
        user_id: item.user_id,
        job_id: item.job_id,
        score: item.score,
        top_matched_skills: item.top_matched_skills || '[]',
        visa_match: item.visa_match !== undefined ? item.visa_match : null,
        frequency: item.frequency || 'immediate',
        read_token: item.read_token || null,
      });
      if (info.changes > 0) {
        inserted.push(selectStmt.get(info.lastInsertRowid));
      }
    }
  });

  tx(capped);
  return inserted;
}

/**
 * Find notifications for a user with pagination and optional is_read filter.
 * JOINs jobs table for job_title, company_name, location, source.
 * Returns { notifications, pagination }.
 */
function findByUser(userId, { page, perPage, isRead } = {}) {
  const db = getDbInstance();
  const currentPage = page || 1;
  const limit = perPage || 20;
  const offset = (currentPage - 1) * limit;

  const conditions = ['n.user_id = @userId'];
  const params = { userId, limit, offset };

  if (isRead !== undefined && isRead !== null) {
    conditions.push('n.is_read = @isRead');
    params.isRead = isRead;
  }

  const where = conditions.join(' AND ');

  const countSql = `SELECT COUNT(*) AS total FROM notifications n WHERE ${where}`;
  const total = db.prepare(countSql).get(params).total;

  const sql = `
    SELECT n.id, n.user_id, n.job_id, n.score, n.top_matched_skills,
           n.visa_match, n.is_read, n.created_at,
           j.title AS job_title, j.company_name, j.location, j.source
    FROM notifications n
    LEFT JOIN jobs j ON j.id = n.job_id
    WHERE ${where}
    ORDER BY n.created_at DESC
    LIMIT @limit OFFSET @offset
  `;
  const notifications = db.prepare(sql).all(params);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    notifications,
    pagination: {
      page: currentPage,
      per_page: limit,
      total,
      total_pages: totalPages,
    },
  };
}

/**
 * Get unread notification count for a user. Uses partial index.
 */
function getUnreadCount(userId) {
  const db = getDbInstance();
  return db.prepare(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(userId).count;
}

/**
 * Mark a single notification as read. Ownership check via userId.
 * Returns the updated row or null if not found / not owned.
 */
function markRead(id, userId) {
  const db = getDbInstance();
  const info = db.prepare(
    `UPDATE notifications
     SET is_read = 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(id, userId);

  if (info.changes === 0) {
    return null;
  }

  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
}

/**
 * Mark all unread notifications as read for a user.
 * Returns the number of notifications changed.
 */
function markAllRead(userId) {
  const db = getDbInstance();
  const info = db.prepare(
    `UPDATE notifications
     SET is_read = 1, updated_at = datetime('now')
     WHERE user_id = ? AND is_read = 0`
  ).run(userId);
  return info.changes;
}

/**
 * Mark a notification as read using its read_token (no user check needed).
 * Returns the updated row or null if token not found.
 */
function markReadByToken(readToken) {
  const db = getDbInstance();
  const info = db.prepare(
    `UPDATE notifications
     SET is_read = 1, updated_at = datetime('now')
     WHERE read_token = ? AND is_read = 0`
  ).run(readToken);

  if (info.changes === 0) {
    return null;
  }

  return db.prepare('SELECT * FROM notifications WHERE read_token = ?').get(readToken);
}

/**
 * Get notifications pending email dispatch for a given frequency.
 * JOINs jobs and users tables.
 */
function getPendingEmails(frequency) {
  const db = getDbInstance();
  return db.prepare(
    `SELECT n.*, j.title AS job_title, j.company_name, j.location, j.source, j.url AS job_url,
            u.email AS user_email, u.display_name AS user_display_name
     FROM notifications n
     JOIN jobs j ON j.id = n.job_id
     JOIN users u ON u.id = n.user_id
     WHERE n.email_sent = 0 AND n.frequency = ?
     ORDER BY n.created_at ASC`
  ).all(frequency);
}

/**
 * Mark a notification's email as sent (status 1) or failed (status 2).
 */
function markEmailSent(id, status) {
  const db = getDbInstance();
  const info = db.prepare(
    `UPDATE notifications
     SET email_sent = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, id);
  return info.changes;
}

/**
 * Delete notifications older than N days.
 * Returns the number of deleted rows.
 */
function deleteOlderThan(days) {
  const db = getDbInstance();
  const info = db.prepare(
    `DELETE FROM notifications
     WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(days);
  return info.changes;
}

module.exports = {
  create,
  createBatch,
  findByUser,
  getUnreadCount,
  markRead,
  markAllRead,
  markReadByToken,
  getPendingEmails,
  markEmailSent,
  deleteOlderThan,
};
