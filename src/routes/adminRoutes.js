const express = require('express');
const { ADMIN_TOKEN } = require('../config');
const { triggerFullAnalysis, getLastAnalysisRun } = require('../services/analysisService');
const { getJobCounts } = require('../repositories/jobsRepo');
const { getStats: getFitStats } = require('../repositories/fitScoresRepo');

const router = express.Router();

function extractToken(req) {
  if (req.query.token) return req.query.token;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) {
    return next();
  }
  return res.status(401).send('未授权，缺少有效的管理令牌。');
}

router.use(requireAdmin);

router.get('/admin', (req, res) => {
  const lastRun = getLastAnalysisRun();
  const jobCounts = getJobCounts();
  const fitStats = getFitStats();

  res.render('admin/dashboard', {
    lastRun,
    jobCounts,
    fitStats,
  });
});

router.post('/admin/run', async (req, res) => {
  const runId = triggerFullAnalysis({ source: 'admin_manual' });
  res.json({ runId });
});

router.post('/admin/upload', express.json({ limit: '2mb' }), (req, res) => {
  const payload = req.body;
  const jobsArray = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.jobs)
    ? payload.jobs
    : null;

  if (!jobsArray) {
    return res.status(400).json({ error: '请求体必须是职位数组或包含 jobs 数组字段的 JSON。' });
  }

  const { insertManyJobs } = require('../repositories/jobsRepo');

  const mapped = jobsArray.map((job) => ({
    external_id: job.external_id || null,
    source: job.source || 'upload',
    role: job.role || '未知角色',
    title: job.title,
    company_name: job.company_name || job.company || null,
    location: job.location || null,
    salary: job.salary || null,
    description: job.description || '',
    url: job.url || null,
    posted_at: job.posted_at || null,
    application_status: job.application_status || '未申请',
    raw_json: JSON.stringify(job),
  }));

  try {
    insertManyJobs(mapped);
    res.json({ inserted: mapped.length });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;

