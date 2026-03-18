'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TABLES = Object.freeze({
  RESUMES: 'resumes',
  SOURCES: 'sources',
  JOBS: 'jobs',
  MATCHES: 'matches',
  COVER_LETTERS: 'cover_letters',
  JOB_STATUS: 'job_status',
  SCRAPE_HISTORY: 'scrape_history',
  CONFIG: 'config',
  OPERATION_LOGS: 'operation_logs'
});

const SOURCE_SEEDS = Object.freeze([
  { name: 'seek', label: 'SEEK' },
  { name: 'linkedin', label: 'LinkedIn' },
  { name: 'apsjobs', label: 'APSJobs' }
]);

let database;

function resolveDatabasePath() {
  const configuredPath = process.env.DATABASE_PATH || 'data/jobhunter.db';
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function ensureDataDirectory(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function applySchema(db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
}

function seedSources(db) {
  const statement = db.prepare(
    `INSERT OR IGNORE INTO ${TABLES.SOURCES} (name, label, active) VALUES (?, ?, 1)`
  );

  for (const source of SOURCE_SEEDS) {
    statement.run(source.name, source.label);
  }
}

function initDatabase() {
  if (database) {
    return database;
  }

  const databasePath = resolveDatabasePath();
  ensureDataDirectory(databasePath);
  database = new Database(databasePath, { timeout: 5000 });
  database.pragma('busy_timeout = 5000');
  try {
    database.pragma('journal_mode = WAL');
  } catch (error) {
    if (error.code !== 'SQLITE_BUSY') {
      throw error;
    }
  }
  database.pragma('foreign_keys = ON');

  applySchema(database);
  seedSources(database);

  return database;
}

function getDb() {
  return initDatabase();
}

module.exports = {
  TABLES,
  getDb,
  initDatabase
};

initDatabase();
