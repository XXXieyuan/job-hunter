const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
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
           raw_html = @raw_html,
           industry = @industry,
           size = @size,
           researched_at = CURRENT_TIMESTAMP
       WHERE id = @id`
    );
    stmt.run({
      ...company,
      id: existing.id,
    });
    return existing.id;
  }

  const stmt = db.prepare(
    `INSERT INTO companies (name, website, description, raw_html, industry, size, researched_at)
     VALUES (@name, @website, @description, @raw_html, @industry, @size, CURRENT_TIMESTAMP)`
  );
  const info = stmt.run(company);
  return info.lastInsertRowid;
}

module.exports = {
  getCompanyByName,
  upsertCompany,
};

