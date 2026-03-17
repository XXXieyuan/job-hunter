const express = require('express');
const { getDb } = require('../db/connection');
const { getJobById } = require('../repositories/jobsRepo');
const { getLogger } = require('../logger');

const logger = getLogger('apiJobsRoutes');

const router = express.Router();

function listJobsWithFilters({ page, pageSize, search, location, source }) {
  const db = getDb();

  const conditions = [];
  const params = {};

  if (search) {
    conditions.push(
      '(title LIKE @search OR company_name LIKE @search OR description LIKE @search)',
    );
    params.search = `%${search}%`;
  }
  if (location) {
    conditions.push('location LIKE @location');
    params.location = `%${location}%`;
  }
  if (source) {
    conditions.push('source = @source');
    params.source = source;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM jobs ${where}`)
    .get(params);
  const total = totalRow ? totalRow.c : 0;

  const sql = `
    SELECT id, title, company_name, location, source, description
    FROM jobs
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;

  const limit = pageSize;
  const offset = (page - 1) * pageSize;
  const items = db
    .prepare(sql)
    .all({ ...params, limit, offset })
    .map((row) => ({
      ...row,
      // v1 schema does not have is_active/skills; expose default values
      is_active: 1,
    }));

  return { items, total };
}

router.get('/api/jobs', (req, res) => {
  const pageRaw = req.query.page;
  const pageSizeRaw = req.query.pageSize;
  const search = req.query.search ? String(req.query.search).trim() : '';
  const location = req.query.location
    ? String(req.query.location).trim()
    : '';
  const source = req.query.source ? String(req.query.source).trim() : '';

  let page = Number.parseInt(pageRaw, 10);
  if (!Number.isFinite(page) || page <= 0) {
    page = 1;
  }
  let pageSize = Number.parseInt(pageSizeRaw, 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    pageSize = 20;
  }
  pageSize = Math.min(pageSize, 100);

  try {
    const { items, total } = listJobsWithFilters({
      page,
      pageSize,
      search: search || null,
      location: location || null,
      source: source || null,
    });

    res.json({
      items,
      page,
      pageSize,
      total,
    });
  } catch (err) {
    logger.error('Failed to list jobs via API', { err });
    res
      .status(500)
      .json({ error: err && err.message ? err.message : 'Failed to list jobs' });
  }
});

router.get('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid job id' });
  }

  const job = getJobById(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const payload = {
    id: job.id,
    title: job.title,
    company_name: job.company_name,
    location: job.location,
    source: job.source,
    is_active: 1,
    description: job.description,
  };

  res.json(payload);
});

router.get('/api/jobs/export', (req, res) => {
  const format = (req.query.format || 'json').toString().toLowerCase();
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, external_id, source, role, title, company_name, location,
              salary, description, url, posted_at, application_status, created_at
       FROM jobs
       ORDER BY created_at DESC, id DESC`,
    )
    .all();

  if (format === 'csv') {
    const header = [
      'id',
      'external_id',
      'source',
      'role',
      'title',
      'company_name',
      'location',
      'salary',
      'description',
      'url',
      'posted_at',
      'application_status',
      'created_at',
    ];
    const escape = (value) => {
      if (value == null) return '';
      const str = String(value);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [
      header.join(','),
      ...rows.map((row) =>
        header.map((key) => escape(row[key])).join(','),
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="jobs-export.csv"',
    );
    res.send(lines.join('\n'));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(rows);
});

module.exports = router;

