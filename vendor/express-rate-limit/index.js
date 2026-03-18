'use strict';

function rateLimit(options = {}) {
  const windowMs = Number(options.windowMs || 60_000);
  const max = Number(options.max || 60);
  const keyGenerator = typeof options.keyGenerator === 'function'
    ? options.keyGenerator
    : (request) => request.ip || request.headers['x-forwarded-for'] || 'global';
  const message = options.message || {
    error: true,
    code: 'RATE_LIMITED',
    message: 'Too many requests, please try again later.'
  };
  const store = new Map();

  return function rateLimitMiddleware(request, response, next) {
    const key = keyGenerator(request);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now - entry.startedAt >= windowMs) {
      store.set(key, { count: 1, startedAt: now });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      return response.status(429).json(message);
    }

    return next();
  };
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;
