const crypto = require('crypto');
const authService = require('../services/authService');
const { ADMIN_TOKEN } = require('../config');
const { getLogger } = require('../logger');

const logger = getLogger('authMiddleware');

const COOKIE_NAME = 'jh_session';
const ADMIN_COOKIE_NAME = 'jh_admin_session';

/**
 * optionalAuth — populates req.user when valid session exists, passes through when absent.
 * Sets res.locals.user for template access.
 */
function optionalAuth(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const result = authService.validateSession(token);
    if (result) {
      req.user = result;
    }
  }
  res.locals.user = req.user;
  next();
}

/**
 * requireAuth — rejects the request if no valid session cookie is present.
 * Returns 401 JSON for /api/* paths; 302 redirect to login for page routes.
 * Returns SESSION_EXPIRED when cookie exists but session is expired/invalid.
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const isApiPath = req.path.startsWith('/api/');

  if (!token) {
    if (isApiPath) {
      return res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
    }
    const redirectUrl = encodeURIComponent(req.originalUrl || req.path);
    return res.redirect(`/auth/login?redirect=${redirectUrl}`);
  }

  const user = authService.validateSession(token);
  if (!user) {
    // Cookie exists but session is expired or invalid
    res.clearCookie(COOKIE_NAME);
    if (isApiPath) {
      return res.status(401).json({
        error: { code: 'SESSION_EXPIRED', message: 'Session expired' },
      });
    }
    const redirectUrl = encodeURIComponent(req.originalUrl || req.path);
    return res.redirect(`/auth/login?redirect=${redirectUrl}`);
  }

  req.user = user;
  res.locals.user = user;
  next();
}

/**
 * requireAdmin — validates jh_admin_session cookie against ADMIN_TOKEN env var
 * with constant-time comparison. Returns 403 FORBIDDEN on failure.
 */
function requireAdmin(req, res, next) {
  const adminToken = req.cookies && req.cookies[ADMIN_COOKIE_NAME];

  if (!adminToken || !ADMIN_TOKEN) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
    });
  }

  // Constant-time comparison to prevent timing attacks
  const tokenBuf = Buffer.from(adminToken);
  const expectedBuf = Buffer.from(ADMIN_TOKEN);

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
    });
  }

  next();
}

/**
 * CSRF protection middleware.
 * Uses Origin header checking for state-changing requests (SameSite=Lax + Origin check).
 */
function csrfProtection(req, res, next) {
  // Only check state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const origin = req.get('Origin');
  const referer = req.get('Referer');

  // If there is an Origin header, validate it
  if (origin) {
    const host = req.get('Host');
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        logger.warn('CSRF check failed: origin mismatch', { origin, host });
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Cross-origin request blocked' },
        });
      }
    } catch (e) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Invalid origin header' },
      });
    }
    return next();
  }

  // If no Origin but Referer exists, validate the referer
  if (referer) {
    const host = req.get('Host');
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) {
        logger.warn('CSRF check failed: referer mismatch', { referer, host });
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Cross-origin request blocked' },
        });
      }
    } catch (e) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Invalid referer header' },
      });
    }
    return next();
  }

  // No Origin or Referer header: reject the request.
  // Modern browsers always send Origin on cross-origin AND same-origin POST/PUT/DELETE.
  // Absence indicates a non-browser client or an unusual configuration.
  logger.warn('CSRF check failed: no Origin or Referer header', {
    method: req.method,
    path: req.path,
  });
  return res.status(403).json({
    error: { code: 'FORBIDDEN', message: 'Missing origin header' },
  });
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth,
  csrfProtection,
  COOKIE_NAME,
  ADMIN_COOKIE_NAME,
};
