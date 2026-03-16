const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const { LOG_LEVEL } = require('../config');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const isProduction = process.env.NODE_ENV === 'production';

const baseFormat = isProduction
  ? format.combine(
      format.timestamp(),
      format.errors({ stack: true }),
      format.json(),
    )
  : format.combine(
      format.colorize(),
      format.timestamp(),
      format.errors({ stack: true }),
      format.printf((info) => {
        const { timestamp, level, message, stack, ...meta } = info;
        const metaWithoutPiI = { ...meta };
        // Avoid logging obvious PII keys by convention
        delete metaWithoutPiI.password;
        delete metaWithoutPiI.token;
        delete metaWithoutPiI.accessToken;
        delete metaWithoutPiI.refreshToken;
        delete metaWithoutPiI.authorization;

        const metaString =
          Object.keys(metaWithoutPiI).length > 0
            ? ` ${JSON.stringify(metaWithoutPiI)}`
            : '';

        const baseMsg = `${timestamp} [${level}] ${message}`;
        if (stack) {
          return `${baseMsg} ${stack}${metaString}`;
        }
        return `${baseMsg}${metaString}`;
      }),
    );

const logger = createLogger({
  level: LOG_LEVEL,
  format: baseFormat,
  defaultMeta: { service: 'job-hunter' },
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      dirname: logsDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info',
    }),
    new DailyRotateFile({
      dirname: logsDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
    }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(logsDir, 'exceptions.log') }),
  ],
  rejectionHandlers: [
    new transports.File({ filename: path.join(logsDir, 'rejections.log') }),
  ],
});

/**
 * Create a child logger with module-specific context.
 * @param {string} moduleLabel - Label describing the module (e.g., 'server', 'scraperService').
 */
function getLogger(moduleLabel) {
  if (!moduleLabel) {
    return logger;
  }
  return logger.child({ module: moduleLabel });
}

module.exports = {
  logger,
  getLogger,
};

