'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { getDb, TABLES } = require('../db/database');
const { log } = require('../utils/logger');

const activeStreams = new Map();
const activeProcesses = new Map();
const SCRAPER_TIMEOUT_MS = 5 * 60 * 1000;

function getSourceId(sourceName) {
  const db = getDb();
  const row = db
    .prepare(`SELECT id FROM ${TABLES.SOURCES} WHERE name = ? LIMIT 1`)
    .get(sourceName);

  return row ? row.id : null;
}

function broadcast(historyId, payload) {
  const clients = activeStreams.get(String(historyId)) || [];
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;

  for (const response of clients) {
    response.write(serialized);
  }
}

function upsertJob(source, job) {
  const sourceId = getSourceId(source);
  if (!sourceId) {
    return;
  }

  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO ${TABLES.JOBS} (
      source_id,
      external_id,
      title,
      company,
      location,
      salary_min,
      salary_max,
      salary_currency,
      job_description,
      job_url,
      posted_date,
      classification
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      salary_currency = excluded.salary_currency,
      job_description = excluded.job_description,
      job_url = excluded.job_url,
      posted_date = excluded.posted_date,
      classification = excluded.classification
  `);

  statement.run(
    sourceId,
    job.external_id || job.job_url,
    job.title,
    job.company || null,
    job.location || null,
    Number.isFinite(job.salary_min) ? job.salary_min : null,
    Number.isFinite(job.salary_max) ? job.salary_max : null,
    job.salary_currency || 'AUD',
    job.job_description || '',
    job.job_url,
    job.posted_date || null,
    job.classification || null
  );
}

function updateHistory(historyId, values) {
  const db = getDb();
  const assignments = [];
  const parameters = [];

  for (const [key, value] of Object.entries(values)) {
    assignments.push(`${key} = ?`);
    parameters.push(value);
  }

  if (!assignments.length) {
    return;
  }

  parameters.push(historyId);
  db.prepare(`UPDATE ${TABLES.SCRAPE_HISTORY} SET ${assignments.join(', ')} WHERE id = ?`).run(...parameters);
}

function handleScraperMessage(source, historyId, message, counters) {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'job_found' && message.job) {
    upsertJob(source, message.job);
    counters.jobsFound += 1;
  }

  if (message.type === 'warning') {
    log('warn', 'SCRAPER_WARNING', message.message || JSON.stringify(message));
  }

  if (message.type === 'error') {
    updateHistory(historyId, {
      status: 'error',
      error_msg: message.message || 'Scraper error',
      finished_at: new Date().toISOString(),
      jobs_found: counters.jobsFound
    });
    log('error', 'SCRAPER_ERROR', message.message || JSON.stringify(message));
  }

  if (message.type === 'done') {
    updateHistory(historyId, {
      status: counters.hadError ? 'partial' : 'success',
      finished_at: new Date().toISOString(),
      jobs_found: message.jobsFound || counters.jobsFound,
      pages: message.pages || counters.pagesCompleted
    });
  }

  if (message.page) {
    counters.pagesCompleted = Math.max(counters.pagesCompleted, Number(message.page) || 0);
  }

  broadcast(historyId, message);
}

function cleanupHistory(historyId, finalPayload) {
  if (finalPayload) {
    broadcast(historyId, finalPayload);
  }

  const responses = activeStreams.get(String(historyId)) || [];
  for (const response of responses) {
    response.end();
  }

  activeStreams.delete(String(historyId));

  const active = activeProcesses.get(String(historyId));
  if (active && active.timeout) {
    clearTimeout(active.timeout);
  }
  activeProcesses.delete(String(historyId));
}

function runScraper(source, keywords, maxPages, historyId) {
  const scriptPath = path.resolve(process.cwd(), 'scrapers', 'run_scraper.py');
  const args = [
    scriptPath,
    '--source',
    String(source),
    '--keywords',
    String(keywords || ''),
    '--max_pages',
    String(maxPages || 1),
    '--history_id',
    String(historyId)
  ];

  const processHandle = spawn('python3', args, {
    cwd: process.cwd(),
    env: process.env
  });
  const counters = { jobsFound: 0, pagesCompleted: 0, hadError: false };
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const timeout = setTimeout(() => {
    counters.hadError = true;
    processHandle.kill('SIGTERM');
    updateHistory(historyId, {
      status: 'error',
      error_msg: 'Scraper timed out after 5 minutes',
      finished_at: new Date().toISOString(),
      jobs_found: counters.jobsFound
    });
    cleanupHistory(historyId, {
      type: 'error',
      message: 'Scraper timed out after 5 minutes'
    });
  }, SCRAPER_TIMEOUT_MS);

  activeProcesses.set(String(historyId), {
    process: processHandle,
    timeout
  });

  processHandle.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const events = stdoutBuffer.split('\n\n');
    stdoutBuffer = events.pop() || '';

    for (const rawEvent of events) {
      const line = rawEvent
        .split('\n')
        .find((entry) => entry.trim().startsWith('data:'));

      if (!line) {
        continue;
      }

      try {
        const payload = JSON.parse(line.replace(/^data:\s*/, ''));
        handleScraperMessage(source, historyId, payload, counters);
      } catch (error) {
        log('warn', 'SCRAPER_PARSE_WARNING', error.message);
      }
    }
  });

  processHandle.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  processHandle.on('close', (code) => {
    if (stderrBuffer.trim()) {
      log('error', 'SCRAPER_STDERR', stderrBuffer.trim().slice(0, 4000));
    }

    if (code !== 0) {
      counters.hadError = true;
      updateHistory(historyId, {
        status: 'error',
        error_msg: stderrBuffer.trim() || `Scraper exited with code ${code}`,
        finished_at: new Date().toISOString(),
        jobs_found: counters.jobsFound,
        pages: counters.pagesCompleted
      });
      cleanupHistory(historyId, {
        type: 'error',
        message: stderrBuffer.trim() || `Scraper exited with code ${code}`
      });
      return;
    }

    updateHistory(historyId, {
      status: counters.hadError ? 'partial' : 'success',
      finished_at: new Date().toISOString(),
      jobs_found: counters.jobsFound,
      pages: counters.pagesCompleted
    });
    cleanupHistory(historyId, {
      type: 'done',
      jobsFound: counters.jobsFound,
      pages: counters.pagesCompleted
    });
  });

  return processHandle;
}

function getProgressStream(historyId, req, res) {
  const key = String(historyId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const clients = activeStreams.get(key) || [];
  clients.push(res);
  activeStreams.set(key, clients);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const remaining = (activeStreams.get(key) || []).filter((client) => client !== res);
    if (remaining.length) {
      activeStreams.set(key, remaining);
    } else {
      activeStreams.delete(key);
    }
  });

  return res;
}

module.exports = {
  getProgressStream,
  runScraper
};

Object.assign(globalThis, { getProgressStream, runScraper });
