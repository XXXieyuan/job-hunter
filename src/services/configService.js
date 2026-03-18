'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

let generatedAdminToken;
let warningsShown = false;

function getDefaultAdminToken() {
  if (!generatedAdminToken) {
    generatedAdminToken = crypto.randomBytes(24).toString('hex');
  }
  return generatedAdminToken;
}

function getConfig() {
  const overrides = readOverrides();
  return {
    port: Number(overrides.PORT || process.env.PORT || 3001),
    openaiApiKey: overrides.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: overrides.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || '',
    adminToken: process.env.ADMIN_TOKEN || getDefaultAdminToken(),
    databasePath: overrides.DATABASE_PATH || process.env.DATABASE_PATH
      ? (overrides.DATABASE_PATH || process.env.DATABASE_PATH)
      : path.join('data', 'jobhunter.db')
  };
}

function readOverrides() {
  try {
    const { getDb, TABLES } = require('../db/database');
    const rows = getDb()
      .prepare(`SELECT key, value FROM ${TABLES.CONFIG}`)
      .all();

    return rows.reduce((accumulator, row) => {
      accumulator[row.key] = row.value;
      return accumulator;
    }, {});
  } catch (error) {
    return {};
  }
}

function persistEnv(updates) {
  const envPath = path.resolve(process.cwd(), '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  const trackedKeys = new Set(Object.keys(updates));
  const nextLines = [];

  for (const line of existing) {
    if (!line.trim()) {
      nextLines.push(line);
      continue;
    }

    const separatorIndex = line.indexOf('=');
    const key = separatorIndex === -1 ? line.trim() : line.slice(0, separatorIndex).trim();
    if (!trackedKeys.has(key)) {
      nextLines.push(line);
      continue;
    }

    nextLines.push(`${key}=${updates[key] || ''}`);
    trackedKeys.delete(key);
  }

  for (const key of trackedKeys) {
    nextLines.push(`${key}=${updates[key] || ''}`);
  }

  fs.writeFileSync(envPath, `${nextLines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
}

function setConfig(updates = {}) {
  const normalized = {};

  if (Object.prototype.hasOwnProperty.call(updates, 'OPENAI_BASE_URL')) {
    normalized.OPENAI_BASE_URL = updates.OPENAI_BASE_URL || '';
    process.env.OPENAI_BASE_URL = normalized.OPENAI_BASE_URL;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'OPENAI_API_KEY')) {
    normalized.OPENAI_API_KEY = updates.OPENAI_API_KEY || '';
    process.env.OPENAI_API_KEY = normalized.OPENAI_API_KEY;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'DATABASE_PATH')) {
    normalized.DATABASE_PATH = updates.DATABASE_PATH || '';
    process.env.DATABASE_PATH = normalized.DATABASE_PATH;
  }

  if (!Object.keys(normalized).length) {
    return getConfig();
  }

  const { getDb, TABLES } = require('../db/database');
  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO ${TABLES.CONFIG} (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const transaction = db.transaction((entries) => {
    for (const [key, value] of entries) {
      statement.run(key, value);
    }
  });

  transaction(Object.entries(normalized));
  persistEnv(normalized);

  return getConfig();
}

function validateConfig() {
  if (warningsShown) {
    return;
  }

  const config = getConfig();

  if (!config.openaiApiKey) {
    console.warn('[config] OPENAI_API_KEY is not set; semantic match and CL generation will degrade gracefully.');
  }

  if (!config.openaiBaseUrl) {
    console.warn('[config] OPENAI_BASE_URL is not set; semantic match and CL generation will degrade gracefully.');
  }

  warningsShown = true;
}

validateConfig();

module.exports = {
  getConfig,
  setConfig,
  validateConfig
};

Object.assign(globalThis, { getConfig });
