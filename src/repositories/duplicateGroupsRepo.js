const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function createGroup({ canonical_job_id, match_method, confidence }) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO duplicate_groups (canonical_job_id, match_method, confidence)
     VALUES (@canonical_job_id, @match_method, @confidence)`
  );
  const info = stmt.run({
    canonical_job_id,
    match_method: match_method || null,
    confidence: confidence || null,
  });
  return info.lastInsertRowid;
}

function addMember(group_id, job_id) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO duplicate_group_members (group_id, job_id)
     VALUES (?, ?)`
  );
  const info = stmt.run(group_id, job_id);
  return info.lastInsertRowid;
}

function findAll() {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT dg.*, j.title AS canonical_title, j.company_name AS canonical_company
       FROM duplicate_groups dg
       JOIN jobs j ON j.id = dg.canonical_job_id
       ORDER BY dg.created_at DESC`
    )
    .all();
}

function findById(id) {
  const db = getDbInstance();
  const group = db
    .prepare('SELECT * FROM duplicate_groups WHERE id = ?')
    .get(id);
  if (!group) return null;

  const members = db
    .prepare(
      `SELECT dgm.*, j.title, j.company_name, j.source, j.url
       FROM duplicate_group_members dgm
       JOIN jobs j ON j.id = dgm.job_id
       WHERE dgm.group_id = ?`
    )
    .all(id);

  return { ...group, members };
}

function findByJobId(job_id) {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT dg.*
       FROM duplicate_groups dg
       JOIN duplicate_group_members dgm ON dgm.group_id = dg.id
       WHERE dgm.job_id = ?`
    )
    .all(job_id);
}

function mergeGroup(group_id, canonical_job_id) {
  const db = getDbInstance();
  const merge = db.transaction(() => {
    // Update canonical_job_id on the group
    db.prepare(
      'UPDATE duplicate_groups SET canonical_job_id = ? WHERE id = ?'
    ).run(canonical_job_id, group_id);

    // Mark non-canonical members as duplicates in jobs table
    db.prepare(
      `UPDATE jobs SET canonical_job_id = ?
       WHERE id IN (
         SELECT job_id FROM duplicate_group_members WHERE group_id = ? AND job_id != ?
       )`
    ).run(canonical_job_id, group_id, canonical_job_id);
  });
  merge();
}

function dismissGroup(group_id) {
  const db = getDbInstance();
  const dismiss = db.transaction(() => {
    // Clear canonical_job_id from member jobs
    db.prepare(
      `UPDATE jobs SET canonical_job_id = NULL
       WHERE id IN (
         SELECT job_id FROM duplicate_group_members WHERE group_id = ?
       )`
    ).run(group_id);

    // Remove members and group
    db.prepare('DELETE FROM duplicate_group_members WHERE group_id = ?').run(
      group_id
    );
    db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(group_id);
  });
  dismiss();
}

/**
 * Get paginated duplicate groups with members.
 * @param {number} page - 1-based page number
 * @param {number} perPage - items per page
 * @returns {{ groups: object[], pagination: object }}
 */
function getPaginatedGroups(page = 1, perPage = 20) {
  const db = getDbInstance();
  const total = db.prepare('SELECT COUNT(*) AS c FROM duplicate_groups').get().c;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (Math.max(1, page) - 1) * perPage;

  const groups = db
    .prepare(
      `SELECT dg.*, j.title AS canonical_title, j.company_name AS canonical_company
       FROM duplicate_groups dg
       JOIN jobs j ON j.id = dg.canonical_job_id
       ORDER BY dg.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(perPage, offset);

  // Fetch members for each group
  const memberStmt = db.prepare(
    `SELECT dgm.job_id, j.source, j.title
     FROM duplicate_group_members dgm
     JOIN jobs j ON j.id = dgm.job_id
     WHERE dgm.group_id = ?`
  );

  for (const group of groups) {
    group.members = memberStmt.all(group.id);
  }

  return {
    groups,
    pagination: { page: Math.max(1, page), per_page: perPage, total, total_pages: totalPages },
  };
}

module.exports = {
  createGroup,
  addMember,
  findAll,
  findById,
  findByJobId,
  mergeGroup,
  dismissGroup,
  getPaginatedGroups,
};
