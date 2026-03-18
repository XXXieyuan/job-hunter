'use strict';

const { log } = require('../utils/logger');

function errorHandler(err, req, res, next) {
  void next;

  const statusCode = err && err.statusCode ? err.statusCode : 500;
  const code = err && err.code ? err.code : 'SERVER_ERROR';
  const message = err && err.message ? err.message : 'Unexpected server error';

  log('error', 'ERROR', message);

  res.status(statusCode).json({
    error: true,
    code,
    message
  });
}

module.exports = errorHandler;
