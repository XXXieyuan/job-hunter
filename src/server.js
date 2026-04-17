require('dotenv').config();
const app = require('./app');
const { PORT } = require('./config');
const { runMigrations } = require('./db/migrate');
const { closeDb } = require('./db/connection');
const { ensureSampleResumeSeeded } = require('./services/resumeService');
const backgroundQueue = require('./services/backgroundQueue');
const sessionsRepo = require('./repositories/sessionsRepo');
const emailService = require('./services/emailService');
const digestScheduler = require('./services/digestScheduler');
const alertPoller = require('./services/alertPoller');
const { getLogger } = require('./logger');

const logger = getLogger('server');

async function start() {
  try {
    // Run all pending migrations (includes 004_rebuild.sql, 004a_migrate_data.sql)
    runMigrations();

    // Clean up expired sessions on startup
    const expiredCount = sessionsRepo.deleteExpired();
    if (expiredCount > 0) {
      logger.info(`Cleaned up ${expiredCount} expired sessions on startup`);
    }

    // Reap orphaned scraper and analysis runs left behind by a prior crash
    // or restart. The background queue is in-memory, so any running/pending
    // row at startup is by definition abandoned — mark it as failure so
    // new trigger*() calls aren't blocked by the "already running" guard.
    const { getDb } = require('./db/connection');
    const _db = getDb();
    const reapedScrapers = _db.prepare(
      `UPDATE scraper_runs
         SET status = 'failure',
             error = 'Reaped on server startup (prior run orphaned by restart)',
             finished_at = datetime('now'),
             completed_at = datetime('now')
       WHERE status IN ('running','pending')`
    ).run();
    if (reapedScrapers.changes > 0) {
      logger.warn(`Reaped ${reapedScrapers.changes} orphaned scraper runs on startup`);
    }
    const reapedAnalyses = _db.prepare(
      `UPDATE analysis_runs
         SET status = 'failure',
             error = 'Reaped on server startup (prior run orphaned by restart)',
             completed_at = datetime('now')
       WHERE status IN ('running','pending','queued')`
    ).run();
    if (reapedAnalyses.changes > 0) {
      logger.warn(`Reaped ${reapedAnalyses.changes} orphaned analysis runs on startup`);
    }

    // Seed sample resume if needed
    await ensureSampleResumeSeeded();

    // Register background queue handlers
    // These are self-registering on require (scraperService, analysisService,
    // embeddingService for the 'embed-jobs' handler).
    require('./services/scraperService');
    require('./services/analysisService');
    require('./services/embeddingService');
    logger.info('Background queue handlers registered');

    // Verify SMTP connection (gracefully degrades if unavailable)
    await emailService.verifyConnection();

    // Start background alert services
    digestScheduler.start();
    alertPoller.start();
    logger.info('Alert services started (digest scheduler + alert poller)');

    const server = app.listen(PORT, () => {
      logger.info(`Job Hunter listening on port ${PORT}`);
    });

    // Graceful shutdown
    function shutdown(signal) {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      // Stop background alert services
      digestScheduler.stop();
      alertPoller.stop();
      logger.info('Alert services stopped');

      server.close(() => {
        logger.info('HTTP server closed');
        try {
          closeDb();
          logger.info('Database connection closed');
        } catch (err) {
          // DB may not have been opened
        }
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
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
