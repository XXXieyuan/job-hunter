'use strict';

const express = require('express');
const { getDb, TABLES } = require('../db/database');
const { getConfig } = require('../services/configService');
const { createAppError } = require('../utils/appError');

const router = express.Router();

function getLang(request) {
  return request.query.lang === 'en' ? 'en' : 'zh';
}

function buildQuery(baseParams, changes) {
  const params = new URLSearchParams(baseParams);

  Object.entries(changes).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      params.delete(key);
      return;
    }

    params.set(key, value);
  });

  return params.toString();
}

function renderPage(response, options) {
  return response.render('layout', {
    title: options.title || 'Job Hunter',
    lang: options.lang,
    activePage: options.activePage,
    bodyPartial: options.bodyPartial,
    pageStyles: options.pageStyles || [],
    pageScripts: options.pageScripts || [],
    ...options.locals
  });
}

function getPrimaryResume() {
  const row = getDb()
    .prepare(`SELECT * FROM ${TABLES.RESUMES} WHERE is_primary = 1 ORDER BY id DESC LIMIT 1`)
    .get();

  if (!row) {
    return null;
  }

  return {
    ...row,
    parsed_data: JSON.parse(row.parsed_data || '{}')
  };
}

function getJobList(filters, page, limit) {
  const db = getDb();
  const primaryResume = getPrimaryResume();
  const where = [];
  const params = [];

  if (filters.source) {
    where.push('sources.name = ?');
    params.push(filters.source);
  }

  if (filters.keyword) {
    const pattern = `%${filters.keyword}%`;
    where.push('(jobs.title LIKE ? OR jobs.company LIKE ? OR jobs.job_description LIKE ?)');
    params.push(pattern, pattern, pattern);
  }

  if (filters.minScore) {
    where.push('COALESCE(matches.total_score, 0) >= ?');
    params.push(Number(filters.minScore));
  }

  if (filters.maxScore) {
    where.push('COALESCE(matches.total_score, 0) <= ?');
    params.push(Number(filters.maxScore));
  }

  if (filters.status) {
    where.push("COALESCE(job_status.status, 'unread') = ?");
    params.push(filters.status);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const matchJoin = primaryResume
    ? `LEFT JOIN ${TABLES.MATCHES} matches ON matches.job_id = jobs.id AND matches.resume_id = ${primaryResume.id}`
    : `LEFT JOIN ${TABLES.MATCHES} matches ON matches.job_id = jobs.id`;
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${TABLES.JOBS} jobs
    JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
    ${matchJoin}
    LEFT JOIN ${TABLES.JOB_STATUS} job_status ON job_status.job_id = jobs.id
    ${whereClause}
  `).get(...params).count;
  const jobs = db.prepare(`
    SELECT
      jobs.*,
      sources.name AS source,
      sources.label AS source_label,
      COALESCE(job_status.status, 'unread') AS status,
      matches.total_score,
      matches.skill_score,
      matches.semantic_score,
      matches.keyword_score
    FROM ${TABLES.JOBS} jobs
    JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
    ${matchJoin}
    LEFT JOIN ${TABLES.JOB_STATUS} job_status ON job_status.job_id = jobs.id
    ${whereClause}
    ORDER BY COALESCE(matches.total_score, -1) DESC, jobs.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { jobs, total };
}

router.use((req, res, next) => {
  res.locals.lang = getLang(req);
  res.locals.primaryResume = getPrimaryResume();
  res.locals.config = getConfig();
  next();
});

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const stats = {
      jobs_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.JOBS}`).get().count,
      matched_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.MATCHES}`).get().count,
      resumes_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.RESUMES}`).get().count,
      cl_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.COVER_LETTERS}`).get().count,
      high_match_jobs: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.MATCHES} WHERE total_score >= 70`).get().count
    };
    const recentJobs = db.prepare(`
      SELECT
        jobs.*,
        sources.name AS source,
        sources.label AS source_label,
        COALESCE(job_status.status, 'unread') AS status,
        matches.total_score
      FROM ${TABLES.JOBS} jobs
      JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
      LEFT JOIN ${TABLES.MATCHES} matches ON matches.job_id = jobs.id
      LEFT JOIN ${TABLES.JOB_STATUS} job_status ON job_status.job_id = jobs.id
      ORDER BY jobs.created_at DESC
      LIMIT 4
    `).all();
    const sourceRows = db.prepare(`
      SELECT sources.name, sources.label, COUNT(jobs.id) AS count
      FROM ${TABLES.SOURCES} sources
      LEFT JOIN ${TABLES.JOBS} jobs ON jobs.source_id = sources.id
      GROUP BY sources.id
    `).all();
    const totalJobs = sourceRows.reduce((sum, row) => sum + row.count, 0) || 1;
    const sourceStats = sourceRows.map((row) => ({
      ...row,
      percentage: Math.round((row.count / totalJobs) * 100)
    }));

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'home',
      bodyPartial: 'home',
      pageStyles: ['/css/home.css'],
      pageScripts: [],
      locals: { stats, recentJobs, sourceStats }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs', (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const filters = {
      source: req.query.source || '',
      keyword: req.query.keyword || '',
      minScore: req.query.minScore || '',
      maxScore: req.query.maxScore || '',
      status: req.query.status || ''
    };
    const limit = 12;
    const { jobs, total } = getJobList(filters, page, limit);
    const sources = getDb().prepare(`
      SELECT id, name, label
      FROM ${TABLES.SOURCES}
      ORDER BY id ASC
    `).all();
    const queryBase = {
      lang: res.locals.lang,
      source: filters.source,
      keyword: filters.keyword,
      minScore: filters.minScore,
      maxScore: filters.maxScore,
      status: filters.status
    };

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'jobs',
      bodyPartial: 'jobs/list',
      pageStyles: ['/css/jobs.css'],
      pageScripts: ['/js/jobs.js'],
      locals: {
        jobs,
        sources,
        filters,
        pagination: {
          total,
          page,
          hasNext: page * limit < total,
          prevQuery: buildQuery(queryBase, { page: Math.max(page - 1, 1) }),
          nextQuery: buildQuery(queryBase, { page: page + 1 })
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:id', (req, res, next) => {
  try {
    const db = getDb();
    const primaryResume = getPrimaryResume();
    const job = db.prepare(`
      SELECT jobs.*, sources.name AS source, sources.label AS source_label
      FROM ${TABLES.JOBS} jobs
      JOIN ${TABLES.SOURCES} sources ON sources.id = jobs.source_id
      WHERE jobs.id = ?
    `).get(req.params.id);

    if (!job) {
      throw createAppError(404, 'NOT_FOUND', `Job with id ${req.params.id} not found`);
    }

    const match = primaryResume
      ? db.prepare(`
          SELECT *
          FROM ${TABLES.MATCHES}
          WHERE job_id = ? AND resume_id = ?
          ORDER BY analyzed_at DESC
          LIMIT 1
        `).get(req.params.id, primaryResume.id)
      : null;
    const coverLetters = db.prepare(`
      SELECT *
      FROM ${TABLES.COVER_LETTERS}
      WHERE job_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id);
    const status = db.prepare(`
      SELECT status
      FROM ${TABLES.JOB_STATUS}
      WHERE job_id = ?
    `).get(req.params.id);

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'jobs',
      bodyPartial: 'jobs/detail',
      pageStyles: ['/css/jobs.css'],
      pageScripts: ['/js/cover-letter.js', '/js/jobs.js'],
      locals: {
        job,
        match: match ? { ...match, gap_analysis: JSON.parse(match.gap_analysis || '{}') } : null,
        coverLetters,
        status: status ? status.status : 'unread',
        primaryResume
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/resumes', (req, res, next) => {
  try {
    const resumes = getDb().prepare(`
      SELECT *
      FROM ${TABLES.RESUMES}
      ORDER BY is_primary DESC, updated_at DESC
    `).all().map((resume) => ({
      ...resume,
      parsed_data: JSON.parse(resume.parsed_data || '{}')
    }));

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'resumes',
      bodyPartial: 'resumes/list',
      pageStyles: ['/css/admin.css'],
      pageScripts: ['/js/resume.js'],
      locals: { resumes }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/scrape', (req, res, next) => {
  try {
    const db = getDb();
    const sources = db.prepare(`
      SELECT id, name, label, active
      FROM ${TABLES.SOURCES}
      WHERE active = 1
      ORDER BY id ASC
    `).all();
    const history = db.prepare(`
      SELECT
        scrape_history.*,
        sources.name AS source,
        sources.label AS source_label
      FROM ${TABLES.SCRAPE_HISTORY} scrape_history
      LEFT JOIN ${TABLES.SOURCES} sources ON sources.id = scrape_history.source_id
      ORDER BY scrape_history.started_at DESC
      LIMIT 10
    `).all();

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'scrape',
      bodyPartial: 'scrape',
      pageStyles: ['/css/admin.css'],
      pageScripts: ['/js/scrape.js'],
      locals: { sources, history }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/admin', (req, res, next) => {
  try {
    const db = getDb();
    const stats = {
      jobs_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.JOBS}`).get().count,
      resumes_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.RESUMES}`).get().count,
      matched_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.MATCHES}`).get().count,
      cl_total: db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.COVER_LETTERS}`).get().count,
      by_source: {}
    };
    const distribution = db.prepare(`
      SELECT sources.name, COUNT(jobs.id) AS count
      FROM ${TABLES.SOURCES} sources
      LEFT JOIN ${TABLES.JOBS} jobs ON jobs.source_id = sources.id
      GROUP BY sources.id
    `).all();

    distribution.forEach((entry) => {
      stats.by_source[entry.name] = entry.count;
    });

    const logs = db.prepare(`
      SELECT id, level, action, detail, created_at
      FROM ${TABLES.OPERATION_LOGS}
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    renderPage(res, {
      lang: res.locals.lang,
      activePage: 'admin',
      bodyPartial: 'admin/dashboard',
      pageStyles: ['/css/admin.css'],
      pageScripts: ['/js/admin.js'],
      locals: {
        stats,
        logs,
        publicConfig: { openai_base_url: getConfig().openaiBaseUrl || '' },
        totalJobs: stats.jobs_total || 1
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
