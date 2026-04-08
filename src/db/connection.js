const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../config');

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function getDbSizeMb() {
  const d = getDb();
  const pageCount = d.pragma('page_count', { simple: true });
  const pageSize = d.pragma('page_size', { simple: true });
  return Math.round(((pageCount * pageSize) / (1024 * 1024)) * 10) / 10;
}

module.exports = {
  getDb,
  closeDb,
  getDbSizeMb,
};

