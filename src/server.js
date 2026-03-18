'use strict';

const express = require('express');
const path = require('path');
const { spawnSync } = require('child_process');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { initDatabase } = require('./db/database');
const pageRoutes = require('./routes');
const apiResumes = require('./routes/apiResumes');
const apiJobs = require('./routes/apiJobs');
const apiScrape = require('./routes/apiScrape');
const apiMatch = require('./routes/apiMatch');
const apiCoverLetter = require('./routes/apiCoverLetter');
const apiAdmin = require('./routes/apiAdmin');
const errorHandler = require('./middleware/errorHandler');
const { getConfig } = require('./services/configService');
const { log } = require('./utils/logger');

initDatabase();

function checkPythonAvailability() {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    log('warn', 'PYTHON_CHECK', 'python3 is not available; scraper features will be unavailable');
    return false;
  }

  return true;
}

function createServer() {
  const app = express();
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 240 });

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(process.cwd(), 'views'));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.static('public'));
  app.use('/api', apiLimiter);

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/', pageRoutes);
  app.use('/api/resumes', apiResumes);
  app.use('/api/jobs', apiJobs);
  app.use('/api/scrape', apiScrape);
  app.use('/api/match', apiMatch);
  app.use('/api/cover-letters', apiCoverLetter);
  app.use('/api/admin', apiAdmin);

  app.use((req, res, next) => {
    void next;
    if (!req.originalUrl.startsWith('/api')) {
      return res.status(404).render('layout', {
        title: 'Job Hunter',
        lang: res.locals.lang || 'zh',
        activePage: '',
        bodyPartial: 'error',
        pageStyles: ['/css/admin.css'],
        pageScripts: [],
        errorState: {
          statusCode: 404,
          code: 'NOT_FOUND',
          message: `Page ${req.originalUrl} was not found`
        }
      });
    }

    res.status(404).json({
      error: true,
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`
    });
  });

  app.use(errorHandler);

  return app;
}

function startServer() {
  const config = getConfig();
  const app = createServer();
  checkPythonAvailability();
  const server = app.listen(config.port);

  server.on('listening', () => {
    log('info', 'SERVER_LISTENING', `Job Hunter server listening on ${config.port}`);
  });
  server.on('error', (error) => {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      log('warn', 'SERVER_LISTEN_DENIED', `Port bind blocked in current environment: ${error.message}`);
      return;
    }

    throw error;
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer
};
