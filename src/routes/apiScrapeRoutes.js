const express = require('express');
const {
  triggerScrape,
  getScraperRuns,
  getRunById,
} = require('../services/scraperService');
const { getLogger } = require('../logger');

const logger = getLogger('apiScrapeRoutes');

const router = express.Router();

function mapStatus(status) {
  if (!status) return 'queued';
  if (status === 'success') return 'completed';
  if (status === 'failure') return 'failed';
  return status;
}

function parseProgress(row) {
  if (!row || !row.progress_json) return undefined;
  try {
    const parsed = JSON.parse(row.progress_json);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const total =
      Number.isFinite(parsed.total) && parsed.total >= 0 ? parsed.total : 0;
    const current =
      Number.isFinite(parsed.current) && parsed.current >= 0
        ? parsed.current
        : 0;
    const message =
      typeof parsed.message === 'string' ? parsed.message : '';
    return { total, current, message };
  } catch {
    return undefined;
  }
}

function serializeRun(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    status: mapStatus(row.status),
    progress: parseProgress(row),
    jobs_added:
      typeof row.jobs_added === 'number' ? row.jobs_added : undefined,
    error: row.error_message || null,
  };
}

router.post('/api/scrape/run', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const runId = triggerScrape('apsjobs', {});
    const row = getRunById(runId);
    const payload = serializeRun(row);
    res.json(payload);
  } catch (err) {
    logger.error('Failed to trigger scraper run via API', {
      error: err && err.message,
    });
    res
      .status(500)
      .json({ error: err && err.message ? err.message : 'Failed to start scrape' });
  }
});

router.get('/api/scrape/status/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid scrape run id' });
  }

  const row = getRunById(id);
  if (!row) {
    return res.status(404).json({ error: 'Scrape run not found' });
  }

  res.json(serializeRun(row));
});

router.get('/api/scrape/history', (req, res) => {
  const runs = getScraperRuns(20) || [];
  res.json(runs.map(serializeRun));
});

module.exports = router;

