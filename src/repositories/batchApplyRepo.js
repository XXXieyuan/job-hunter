'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createSession({ userId, totalJobs }) {
  const db = getDbInstance();
  const info = db
    .prepare(
      'INSERT INTO batch_apply_sessions (user_id, total_jobs) VALUES (?, ?)'
    )
    .run(userId, totalJobs);
  return info.lastInsertRowid;
}

function createSessionWithJobs({ userId, totalJobs }, jobIds, resumeId, coverLetterIds) {
  const db = getDbInstance();
  const insertSession = db.prepare(
    'INSERT INTO batch_apply_sessions (user_id, total_jobs) VALUES (?, ?)'
  );
  const insertJob = db.prepare(
    `INSERT INTO batch_apply_jobs (session_id, job_id, resume_id, cover_letter_id, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );

  const createAll = db.transaction(() => {
    const info = insertSession.run(userId, totalJobs);
    const sessionId = info.lastInsertRowid;
    for (let i = 0; i < jobIds.length; i++) {
      const coverLetterId =
        coverLetterIds && coverLetterIds[i] != null ? coverLetterIds[i] : null;
      insertJob.run(sessionId, jobIds[i], resumeId, coverLetterId);
    }
    return sessionId;
  });

  return createAll();
}

function createSessionJobs(sessionId, jobIds, resumeId, coverLetterIds) {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO batch_apply_jobs (session_id, job_id, resume_id, cover_letter_id, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );

  const insertAll = db.transaction(() => {
    for (let i = 0; i < jobIds.length; i++) {
      const coverLetterId =
        coverLetterIds && coverLetterIds[i] != null ? coverLetterIds[i] : null;
      insert.run(sessionId, jobIds[i], resumeId, coverLetterId);
    }
  });

  insertAll();
}

function getActiveSession(userId) {
  const db = getDbInstance();
  return (
    db
      .prepare(
        `SELECT * FROM batch_apply_sessions
       WHERE user_id = ? AND status IN ('pending', 'in-progress')
       ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) || null
  );
}

function getSession(sessionId) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM batch_apply_sessions WHERE id = ?')
    .get(sessionId) || null;
}

function getSessionJobs(sessionId) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT baj.*, j.title, j.company_name
       FROM batch_apply_jobs baj
       JOIN jobs j ON j.id = baj.job_id
       WHERE baj.session_id = ?
       ORDER BY baj.id ASC`
    )
    .all(sessionId);
}

function updateJobStatus(jobId, status, extras) {
  const db = getDbInstance();
  const fields = ['status = ?'];
  const values = [status];

  if (extras) {
    if (extras.error_reason !== undefined) {
      fields.push('error_reason = ?');
      values.push(extras.error_reason);
    }
    if (extras.filled_fields !== undefined) {
      fields.push('filled_fields = ?');
      values.push(extras.filled_fields);
    }
    if (extras.warnings !== undefined) {
      fields.push('warnings = ?');
      values.push(extras.warnings);
    }
    if (extras.applied_at !== undefined) {
      fields.push('applied_at = ?');
      values.push(extras.applied_at);
    }
    if (extras.started_at !== undefined) {
      fields.push('started_at = ?');
      values.push(extras.started_at);
    }
    if (extras.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(extras.completed_at);
    }
  }

  values.push(jobId);
  const sql = `UPDATE batch_apply_jobs SET ${fields.join(', ')} WHERE id = ?`;
  const info = db.prepare(sql).run(...values);
  return info.changes;
}

function incrementSessionCounter(sessionId, counterName) {
  const allowed = ['applied_count', 'failed_count', 'skipped_count'];
  if (!allowed.includes(counterName)) {
    throw new Error(`Invalid counter name: ${counterName}`);
  }
  const db = getDbInstance();
  const sql = `UPDATE batch_apply_sessions SET ${counterName} = ${counterName} + 1 WHERE id = ?`;
  const info = db.prepare(sql).run(sessionId);
  return info.changes;
}

function updateSessionStatus(sessionId, status, extras) {
  const db = getDbInstance();
  const fields = ['status = ?'];
  const values = [status];

  if (extras) {
    if (extras.started_at !== undefined) {
      fields.push('started_at = ?');
      values.push(extras.started_at);
    }
    if (extras.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(extras.completed_at);
    }
  }

  values.push(sessionId);
  const sql = `UPDATE batch_apply_sessions SET ${fields.join(', ')} WHERE id = ?`;
  const info = db.prepare(sql).run(...values);
  return info.changes;
}

function getSessionsByUser(userId, { page = 1, limit = 10 } = {}) {
  const db = getDbInstance();
  const offset = (page - 1) * limit;
  return db
    .prepare(
      `SELECT * FROM batch_apply_sessions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, limit, offset);
}

function countSessionsByUser(userId) {
  const db = getDbInstance();
  const row = db
    .prepare(
      'SELECT COUNT(*) AS c FROM batch_apply_sessions WHERE user_id = ?'
    )
    .get(userId);
  return row.c;
}

function recoverStaleSessions(thresholdMinutes) {
  const db = getDbInstance();

  const recover = db.transaction(() => {
    // Find stale sessions
    const staleSessions = db
      .prepare(
        `SELECT id FROM batch_apply_sessions
         WHERE status IN ('pending', 'in-progress')
         AND created_at < datetime('now', ? || ' minutes')`
      )
      .all(`-${thresholdMinutes}`);

    if (staleSessions.length === 0) return 0;

    const sessionIds = staleSessions.map((s) => s.id);

    for (const sid of sessionIds) {
      // Mark pending jobs as skipped
      db.prepare(
        `UPDATE batch_apply_jobs
         SET status = 'skipped', error_reason = 'Server restarted during batch',
             completed_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND status IN ('pending', 'in-progress')`
      ).run(sid);

      // Mark session as cancelled
      db.prepare(
        `UPDATE batch_apply_sessions
         SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(sid);
    }

    return sessionIds.length;
  });

  return recover();
}

module.exports = {
  createSession,
  createSessionWithJobs,
  createSessionJobs,
  getActiveSession,
  getSession,
  getSessionJobs,
  updateJobStatus,
  incrementSessionCounter,
  updateSessionStatus,
  getSessionsByUser,
  countSessionsByUser,
  recoverStaleSessions,
};
