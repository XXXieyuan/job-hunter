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

module.exports = {
  PORT,
  DB_PATH,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_CHAT_MODEL,
  ADMIN_TOKEN,
};

