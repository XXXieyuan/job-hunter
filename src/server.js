'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const { initDatabase } = require('./db/database');
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

function createServer() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.static('public'));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/resumes', apiResumes);
  app.use('/api/jobs', apiJobs);
  app.use('/api/scrape', apiScrape);
  app.use('/api/match', apiMatch);
  app.use('/api/cover-letters', apiCoverLetter);
  app.use('/api/admin', apiAdmin);

  app.use((req, res, next) => {
    void next;
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
  const server = app.listen(config.port, () => {
    log('info', 'SERVER_LISTENING', `Job Hunter server listening on ${config.port}`);
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
