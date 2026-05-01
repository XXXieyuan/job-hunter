'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function parseFilters(filtersJson) {
  if (!filtersJson) return {};
  try {
    const parsed = typeof filtersJson === 'string' ? JSON.parse(filtersJson) : filtersJson;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    filters: parseFilters(row.filters_json),
  };
}

function normalizeName(name) {
  return String(name || '').trim().slice(0, 80);
}

function normalizePosition(position) {
  const n = Number(position);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function serializeFilters(filters) {
  const safe = filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {};
  return JSON.stringify(safe);
}

function create({ user_id, name, filters, position }) {
  const db = getDbInstance();
  const cleanName = normalizeName(name);
  if (!cleanName) {
    const err = new Error('Section name is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const info = db.prepare(
    `INSERT INTO job_search_sections (user_id, name, filters_json, position)
     VALUES (@user_id, @name, @filters_json, @position)`
  ).run({
    user_id,
    name: cleanName,
    filters_json: serializeFilters(filters),
    position: normalizePosition(position),
  });

  return getByIdForUser(info.lastInsertRowid, user_id);
}

function listByUser(user_id) {
  const db = getDbInstance();
  return db.prepare(
    `SELECT *
     FROM job_search_sections
     WHERE user_id = ?
     ORDER BY position ASC, id ASC`
  ).all(user_id).map(hydrate);
}

function getByIdForUser(id, user_id) {
  const db = getDbInstance();
  return hydrate(db.prepare(
    `SELECT *
     FROM job_search_sections
     WHERE id = ? AND user_id = ?`
  ).get(id, user_id));
}

function update(id, user_id, { name, filters, position }) {
  const existing = getByIdForUser(id, user_id);
  if (!existing) return null;

  const nextName = name === undefined ? existing.name : normalizeName(name);
  if (!nextName) {
    const err = new Error('Section name is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const db = getDbInstance();
  db.prepare(
    `UPDATE job_search_sections
     SET name = @name,
         filters_json = @filters_json,
         position = @position,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND user_id = @user_id`
  ).run({
    id,
    user_id,
    name: nextName,
    filters_json: filters === undefined ? existing.filters_json : serializeFilters(filters),
    position: position === undefined ? existing.position : normalizePosition(position),
  });

  return getByIdForUser(id, user_id);
}

function remove(id, user_id) {
  const db = getDbInstance();
  return db.prepare(
    'DELETE FROM job_search_sections WHERE id = ? AND user_id = ?'
  ).run(id, user_id).changes;
}

module.exports = {
  create,
  listByUser,
  getByIdForUser,
  update,
  remove,
  _parseFilters: parseFilters,
};

