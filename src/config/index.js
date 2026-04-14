const path = require('path');

const PORT = process.env.PORT || 3001;

const DB_PATH = process.env.DB_PATH ||
  path.join(__dirname, '..', '..', 'data', 'job-hunter.sqlite');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Logging
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (NODE_ENV === 'production' ? 'info' : 'debug');

// Authentication
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE, 10) || 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_MAX_PER_USER = parseInt(process.env.SESSION_MAX_PER_USER, 10) || 5;

// Scraper
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 120000; // 2 minutes
const SCRAPER_RATE_LIMIT_MS = parseInt(process.env.SCRAPER_RATE_LIMIT_MS, 10) || 2000; // 2s between requests
const SCRAPER_MAX_PAGES = parseInt(process.env.SCRAPER_MAX_PAGES, 10) || 5;

// Python path for curl_cffi scrapers
const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';

// Resume upload
const RESUME_MAX_SIZE_BYTES = parseInt(process.env.RESUME_MAX_SIZE_BYTES, 10) || 5 * 1024 * 1024; // 5MB
const RESUME_UPLOAD_DIR = process.env.RESUME_UPLOAD_DIR ||
  path.join(__dirname, '..', '..', 'data', 'resumes');

// SMTP / Email (job alerts)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = process.env.SMTP_SECURE !== undefined
  ? process.env.SMTP_SECURE === 'true'
  : true;
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

module.exports = {
  PORT,
  DB_PATH,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_CHAT_MODEL,
  ADMIN_TOKEN,
  NODE_ENV,
  LOG_LEVEL,
  BCRYPT_ROUNDS,
  SESSION_MAX_AGE,
  SESSION_MAX_PER_USER,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_RATE_LIMIT_MS,
  SCRAPER_MAX_PAGES,
  PYTHON_PATH,
  RESUME_MAX_SIZE_BYTES,
  RESUME_UPLOAD_DIR,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  EMAIL_FROM,
  EMAIL_ENABLED,
  APP_BASE_URL,
};
