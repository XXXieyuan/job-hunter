const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getCompanyById(id) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function getCompanyByName(name) {
  const db = getDbInstance();
  return db.prepare('SELECT * FROM companies WHERE name = ?').get(name);
}

function upsertCompany(company) {
  const db = getDbInstance();
  const existing = getCompanyByName(company.name);
  if (existing) {
    const stmt = db.prepare(
      `UPDATE companies
       SET website = @website,
           description = @description,
           industry = @industry,
           size = @size,
           logo_url = @logo_url,
           headquarters = @headquarters,
           raw_json = @raw_json,
           researched_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @id`
    );
    stmt.run({
      website: company.website || null,
      description: company.description || null,
      industry: company.industry || null,
      size: company.size || null,
      logo_url: company.logo_url || null,
      headquarters: company.headquarters || null,
      raw_json: company.raw_json || null,
      id: existing.id,
    });
    return existing.id;
  }

  const stmt = db.prepare(
    `INSERT INTO companies (name, website, description, industry, size, logo_url, headquarters, raw_json, researched_at)
     VALUES (@name, @website, @description, @industry, @size, @logo_url, @headquarters, @raw_json, CURRENT_TIMESTAMP)`
  );
  const info = stmt.run({
    name: company.name,
    website: company.website || null,
    description: company.description || null,
    industry: company.industry || null,
    size: company.size || null,
    logo_url: company.logo_url || null,
    headquarters: company.headquarters || null,
    raw_json: company.raw_json || null,
  });
  return info.lastInsertRowid;
}

function getAll() {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM companies ORDER BY name ASC')
    .all();
}

module.exports = {
  getCompanyById,
  getCompanyByName,
  upsertCompany,
  getAll,
};
