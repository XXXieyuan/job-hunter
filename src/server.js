require('dotenv').config();
const app = require('./app');
const { PORT } = require('./config');
const { runMigrations } = require('./db/migrate');
const { ensureSampleResumeSeeded } = require('./services/resumeService');
const { getLogger } = require('./logger');

const logger = getLogger('server');

async function start() {
  try {
    runMigrations();
    await ensureSampleResumeSeeded();

    app.listen(PORT, () => {
      logger.info(`Job Hunter listening on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start Job Hunter', { err });
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
  process.exit(1);
});

start();
