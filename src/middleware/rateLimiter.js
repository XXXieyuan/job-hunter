/**
 * In-memory sliding window rate limiter middleware.
 *
 * Supports three scoping strategies:
 *   - 'ip'     — keyed by req.ip (default for unauthenticated endpoints)
 *   - 'user'   — keyed by req.user.id (requires auth middleware first)
 *   - 'global' — single global counter (e.g., admin scraper triggers)
 *
 * Usage:
 *   const { rateLimiter } = require('./middleware/rateLimiter');
 *
 *   // Global 120/min per IP (default)
 *   app.use(rateLimiter({ windowMs: 60000, max: 120 }));
 *
 *   // Login: 10/15min per IP
 *   router.post('/auth/login', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, scope: 'ip' }), handler);
 *
 *   // Cover letter: 10/hour per user
 *   router.post('/api/cover-letters', rateLimiter({ windowMs: 3600000, max: 10, scope: 'user' }), handler);
 *
 *   // Scraper: 6/hour global
 *   router.post('/admin/scraper/run', rateLimiter({ windowMs: 3600000, max: 6, scope: 'global', prefix: 'scraper' }), handler);
 */

const { getLogger } = require('../logger');
const logger = getLogger('rateLimiter');

/**
 * In-memory store keyed by scope identifier.
 * Each entry holds an array of request timestamps within the window.
 * @type {Map<string, number[]>}
 */
const store = new Map();

// Periodic cleanup every 5 minutes to prevent unbounded growth.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of store) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - 24 * 60 * 60 * 1000) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Create a rate limiter middleware.
 *
 * @param {object} options
 * @param {number} [options.windowMs=60000]  - Sliding window size in milliseconds.
 * @param {number} [options.max=60]          - Maximum requests allowed within the window.
 * @param {string} [options.scope='ip']      - 'ip', 'user', or 'global'.
 * @param {string} [options.prefix='']       - Optional prefix for key namespacing (avoids collisions between limiters).
 * @param {function} [options.keyGenerator]  - Optional custom function(req) => string for key.
 * @param {string} [options.message]         - Custom 429 response message.
 * @param {string} [options.errorShape='nested'] - Response shape: 'nested' ({error:{code,message}}) or 'flat' ({error:"<string>"}).
 * @returns {function} Express middleware
 */
function rateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 60;
  const scope = options.scope || 'ip';
  const prefix = options.prefix || '';
  const message = options.message || 'Too many requests, please try again later.';
  const errorShape = options.errorShape || 'nested';
  const keyGenerator =
    options.keyGenerator ||
    ((req) => {
      if (scope === 'global') return `${prefix}:global`;
      if (scope === 'user' && req.user && req.user.id) return `${prefix}:user:${req.user.id}`;
      if (scope === 'ip') return `${prefix}:ip:${req.ip}`;
      // Fallback: use IP
      return `${prefix}:ip:${req.ip}`;
    });

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = store.get(key);
    if (!timestamps) {
      timestamps = [];
      store.set(key, timestamps);
    }

    // Remove timestamps outside the window (sliding window).
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      res.set('Retry-After', String(retryAfterSec));
      logger.warn('Rate limit exceeded', { key, count: timestamps.length, max, windowMs });

      return res.status(429).json({
        error: errorShape === 'flat' ? message : { code: 'RATE_LIMITED', message },
      });
    }

    timestamps.push(now);

    // Set informational headers.
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(max - timestamps.length));

    next();
  };
}

// Pre-configured rate limiters for auth endpoints (10 per 15 min per IP)
const authLoginLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: 'ip',
  prefix: 'auth:login',
  message: 'Too many login attempts, please try again later.',
});

const authRegisterLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: 'ip',
  prefix: 'auth:register',
  message: 'Too many registration attempts, please try again later.',
});

// Pre-configured rate limiters for cover letter generation (10 per hour per user)
const coverLetterLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  scope: 'user',
  prefix: 'cover-letter',
  message: 'Too many cover letter requests, please try again later.',
});

// Pre-configured rate limiter for scoring (5 per hour per user)
const scoringLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  scope: 'user',
  prefix: 'scoring',
  message: 'Too many scoring requests, please try again later.',
});

// Pre-configured rate limiter for resume upload (10 per day per user)
const resumeUploadLimiter = rateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  scope: 'user',
  prefix: 'resume-upload',
  message: 'Too many resume uploads, please try again later.',
});

// Pre-configured rate limiter for optimization suggestions (5 per minute per user)
const optimizationLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  scope: 'user',
  prefix: 'optimization',
  message: 'Too many requests — try again in a minute.',
});

// Pre-configured rate limiter for scraper runs (6 per hour global)
const scraperRunLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 6,
  scope: 'global',
  prefix: 'scraper',
  message: 'Too many scraper triggers, please try again later.',
});

// Pre-configured rate limiter for salary API (30 per minute per IP)
const salaryApiLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  scope: 'ip',
  prefix: 'salary-api',
  message: 'Too many requests — try again shortly',
  errorShape: 'flat',
});

// Pre-configured rate limiter for resume override (30 per minute per IP)
const resumeOverrideLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  scope: 'ip',
  prefix: 'resume-override',
  message: 'Too many requests, please try again later.',
});

// Pre-configured rate limiter for company research (10 per minute per IP, flat error)
const companyResearchLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  scope: 'ip',
  prefix: 'company-research',
  message: 'Too many company research requests, please try again later.',
  errorShape: 'flat',
});

// Pre-configured rate limiter for batch company research (2 per hour per IP)
const batchCompanyResearchLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 2,
  scope: 'ip',
  prefix: 'batch-company-research',
  message: 'Too many batch research requests, please try again later.',
});

// Export store for testing purposes
module.exports = {
  rateLimiter,
  authLoginLimiter,
  authRegisterLimiter,
  coverLetterLimiter,
  scoringLimiter,
  resumeUploadLimiter,
  optimizationLimiter,
  scraperRunLimiter,
  salaryApiLimiter,
  resumeOverrideLimiter,
  companyResearchLimiter,
  batchCompanyResearchLimiter,
  _store: store,
};
