const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { ADMIN_TOKEN } = require('../config');
const {
  triggerFullAnalysis,
  getLastAnalysisRun,
} = require('../services/analysisService');
const { getJobCounts, upsertManyJobs } = require('../repositories/jobsRepo');
const { getStats: getFitStats } = require('../repositories/fitScoresRepo');
const {
  triggerScrape,
  getScraperRuns,
} = require('../services/scraperService');
const { upsertCompany } = require('../repositories/companiesRepo');
const { getLogger } = require('../logger');

const logger = getLogger('adminRoutes');

const router = express.Router();

// Multer storage for uploaded job JSON files under data/uploads/jobs
const jobsUploadRoot = path.join(__dirname, '..', '..', 'data', 'uploads', 'jobs');

if (!fs.existsSync(jobsUploadRoot)) {
  fs.mkdirSync(jobsUploadRoot, { recursive: true });
}

const jobsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, jobsUploadRoot);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '';
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, `${base}-${timestamp}${ext}`);
  },
});

const jobsUpload = multer({
  storage: jobsStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

function extractToken(req) {
  if (req.query.token) return req.query.token;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

function requireAdmin(req, res, next) {
  const rawPath = req.path || req.originalUrl || '';
  const pathLower = rawPath.toLowerCase();

  // Only enforce admin token on /admin paths; everything else is public
  if (!pathLower.startsWith('/admin')) {
    return next();
  }

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
   const scraperRuns = getScraperRuns(20);

  res.render('admin/dashboard', {
    lastRun,
    jobCounts,
    fitStats,
    scraperRuns,
    adminToken: ADMIN_TOKEN,
  });
});

router.post('/admin/run', async (req, res) => {
  const runId = triggerFullAnalysis({ source: 'admin_manual' });
  logger.info('Admin triggered full analysis run', { runId });
  res.json({ runId });
});

router.post('/admin/scraper/run', express.json({ limit: '1mb' }), (req, res) => {
  const payload = req.body || {};
  const name = payload.name || 'apsjobs';
  const options = payload.options || {};

  try {
    const runId = triggerScrape(name, options);
    logger.info('Admin triggered scraper run', {
      runId,
      scraperName: name,
    });
    res.json({ runId });
  } catch (err) {
    if (err && err.code === 'INVALID_SCRAPER_OPTIONS') {
      return res
        .status(400)
        .json({ error: err.message || '无效的抓取参数。' });
    }
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.get('/admin/scraper/runs', (req, res) => {
  const runs = getScraperRuns(50);
  res.json({ runs });
});

function mapJobsPayload(payload) {
  const jobsArray = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.jobs)
      ? payload.jobs
      : null;

  if (!jobsArray) {
    return null;
  }

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

  return mapped;
}

router.post('/admin/upload', express.json({ limit: '2mb' }), (req, res) => {
  const payload = req.body;
  const mapped = mapJobsPayload(payload);

  if (!mapped) {
    return res.status(400).json({ error: '请求体必须是职位数组或包含 jobs 数组字段的 JSON。' });
  }

  try {
    upsertManyJobs(mapped);
    logger.info('Admin uploaded jobs via JSON body', {
      jobsCount: mapped.length,
    });

    // Lightweight company upsert based on company_name only
    const uniqueCompanyNames = Array.from(
      new Set(mapped.map((j) => j.company_name).filter(Boolean)),
    );
    uniqueCompanyNames.forEach((name) => {
      upsertCompany({
        name,
        website: null,
        description: '信息暂无',
        raw_html: null,
        industry: null,
        size: null,
      });
    });

    res.json({ inserted: mapped.length });
  } catch (err) {
    logger.error('Failed to upsert jobs from JSON body', {
      error: err && err.message,
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.post(
  '/admin/jobs/upload',
  jobsUpload.single('jobFile'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).send('请上传包含职位数据的 JSON 文件。');
    }

    let raw;
    try {
      raw = fs.readFileSync(req.file.path, 'utf8');
    } catch (err) {
      return res.status(500).send('读取上传文件失败，请稍后重试。');
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return res.status(400).send('上传的文件不是有效的 JSON。');
    }

    const mapped = mapJobsPayload(payload);
    if (!mapped) {
      return res
        .status(400)
        .send('JSON 内容必须是职位数组或包含 jobs 数组字段的对象。');
    }

    try {
      upsertManyJobs(mapped);
      logger.info('Admin uploaded jobs via file', {
        jobsCount: mapped.length,
        // Avoid logging file path or name; only counts
      });

      const uniqueCompanyNames = Array.from(
        new Set(mapped.map((j) => j.company_name).filter(Boolean)),
      );
      uniqueCompanyNames.forEach((name) => {
        upsertCompany({
          name,
          website: null,
          description: '信息暂无',
          raw_html: null,
          industry: null,
          size: null,
        });
      });

      const tokenQuery = ADMIN_TOKEN
        ? `?token=${encodeURIComponent(ADMIN_TOKEN)}`
        : '';
      res.send(
        `上传成功，处理职位数量：${mapped.length}。<a href="/admin${tokenQuery}">返回管理面板</a>`,
      );
    } catch (err) {
      logger.error('Failed to upsert jobs from uploaded file', {
        error: err && err.message,
      });
      res
        .status(500)
        .send(`写入数据库失败：${err.message || String(err)}`);
    }
  },
);

module.exports = router;
