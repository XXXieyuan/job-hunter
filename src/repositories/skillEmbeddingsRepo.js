/**
 * Global skill embedding cache. Stores one Float64 BLOB per unique skill
 * string (lowercased, trimmed). Used by the keyword matcher's semantic
 * tier to avoid re-embedding the same skill for every scoring run.
 *
 * Lifecycle:
 *   - Populated lazily by the embed-skills background task, which sweeps
 *     every unique skill name appearing in jobs.required_skills_json or
 *     resumes.skills_json.
 *   - Never expires automatically — skills don't change meaning over time.
 *     A manual CLEAR is fine if the embedding model is swapped.
 */
const { getDb: getDbInstance } = require('../db/connection');

let _tableEnsured = false;
function ensureTable(db) {
  if (_tableEnsured) return;
  db.exec(
    `CREATE TABLE IF NOT EXISTS skill_embeddings (
       skill           TEXT PRIMARY KEY,
       embedding       BLOB NOT NULL,
       embedding_model TEXT,
       created_at      TEXT DEFAULT CURRENT_TIMESTAMP
     )`
  );
  _tableEnsured = true;
}

function getEmbedding(skill) {
  if (!skill || typeof skill !== 'string') return null;
  const db = getDbInstance();
  ensureTable(db);
  const row = db
    .prepare('SELECT embedding FROM skill_embeddings WHERE skill = ?')
    .get(skill.toLowerCase().trim());
  return row ? row.embedding : null;
}

/**
 * Fetch many skill embeddings at once. Returns Map<skillNormalized, Buffer>
 * containing only the entries that exist. Caller decides how to handle misses.
 */
function getEmbeddingsBulk(skills) {
  const out = new Map();
  if (!Array.isArray(skills) || skills.length === 0) return out;
  const db = getDbInstance();
  ensureTable(db);
  const norm = [...new Set(skills.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))];
  if (norm.length === 0) return out;
  const placeholders = norm.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT skill, embedding FROM skill_embeddings WHERE skill IN (${placeholders})`)
    .all(...norm);
  for (const r of rows) out.set(r.skill, r.embedding);
  return out;
}

function setEmbedding(skill, buffer, model) {
  if (!skill || !buffer) return;
  const db = getDbInstance();
  ensureTable(db);
  db.prepare(
    `INSERT INTO skill_embeddings (skill, embedding, embedding_model)
     VALUES (?, ?, ?)
     ON CONFLICT(skill) DO UPDATE SET
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model`
  ).run(skill.toLowerCase().trim(), buffer, model || null);
}

/**
 * Returns the subset of `skills` that have no cached embedding yet.
 * Normalizes inputs, dedupes, and filters empties so the caller can feed
 * back into bulk-embed logic without worrying about the cache state.
 */
function getMissing(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return [];
  const db = getDbInstance();
  ensureTable(db);
  const norm = [
    ...new Set(skills.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean)),
  ];
  if (norm.length === 0) return [];
  const placeholders = norm.map(() => '?').join(',');
  const found = new Set(
    db
      .prepare(`SELECT skill FROM skill_embeddings WHERE skill IN (${placeholders})`)
      .all(...norm)
      .map((r) => r.skill)
  );
  return norm.filter((s) => !found.has(s));
}

function getCachedCount() {
  const db = getDbInstance();
  ensureTable(db);
  return db.prepare('SELECT COUNT(*) AS c FROM skill_embeddings').get().c;
}

module.exports = {
  getEmbedding,
  getEmbeddingsBulk,
  setEmbedding,
  getMissing,
  getCachedCount,
};
