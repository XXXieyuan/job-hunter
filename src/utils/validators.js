'use strict';

const path = require('path');

const JOB_STATUSES = ['unread', 'read', 'applied', 'not_interested'];
const LANGUAGES = ['en', 'zh'];
const SOURCES = ['seek', 'linkedin', 'apsjobs'];

function validateFileType(filename, allowedTypes = []) {
  const extension = path.extname(filename || '').replace('.', '').toLowerCase();
  return allowedTypes.map((type) => type.toLowerCase()).includes(extension);
}

function validateJobStatus(status) {
  return JOB_STATUSES.includes(status);
}

function validateLanguage(language) {
  return LANGUAGES.includes(language);
}

function validateSource(source) {
  return SOURCES.includes(source);
}

module.exports = {
  JOB_STATUSES,
  LANGUAGES,
  SOURCES,
  validateFileType,
  validateJobStatus,
  validateLanguage,
  validateSource
};
