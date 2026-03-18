'use strict';

const crypto = require('crypto');
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
  return {
    port: Number(process.env.PORT || 3001),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    adminToken: process.env.ADMIN_TOKEN || getDefaultAdminToken(),
    databasePath: process.env.DATABASE_PATH
      ? process.env.DATABASE_PATH
      : path.join('data', 'jobhunter.db')
  };
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
  validateConfig
};

Object.assign(globalThis, { getConfig });
