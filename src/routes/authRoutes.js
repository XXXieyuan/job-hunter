const express = require('express');
const authService = require('../services/authService');
const { registerSchema, loginSchema } = require('../middleware/validators');
const { authLoginLimiter, authRegisterLimiter } = require('../middleware/rateLimiter');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');
const { NODE_ENV } = require('../config');
const { getLogger } = require('../logger');

const logger = getLogger('authRoutes');
const router = express.Router();

// Body parser for auth routes (form + JSON)
router.use(express.urlencoded({ extended: false }));
router.use(express.json({ limit: '2mb' }));

/**
 * Cookie options for the session token.
 * 7-day max age per INTERFACE_CONTRACT.md Section 3.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  };
}

/**
 * Determine redirect target from query param or form body, defaulting to /jobs.
 * Only allows relative paths to prevent open redirect.
 */
function getRedirectUrl(req) {
  const target = req.query.redirect || req.body.redirect || '/jobs';
  // Only allow relative paths (single leading /) to prevent open redirect via protocol-relative URLs
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }
  return '/jobs';
}

/**
 * GET /auth/login — render the login page.
 */
router.get('/auth/login', (req, res) => {
  if (req.user) {
    return res.redirect('/jobs');
  }
  res.render('auth/login', {
    error: null,
    redirect: req.query.redirect || '',
  });
});

/**
 * GET /auth/register — render the register page.
 */
router.get('/auth/register', (req, res) => {
  if (req.user) {
    return res.redirect('/jobs');
  }
  res.render('auth/register', {
    error: null,
    errors: {},
    redirect: req.query.redirect || '',
  });
});

/**
 * POST /auth/login — verify credentials, set cookie, redirect.
 * Rate limited: 10 per 15 min per IP.
 */
router.post('/auth/login', authLoginLimiter, (req, res) => {
  // Inline Zod validation so form POSTs get re-rendered views (not JSON) on failure
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details },
      });
    }

    return res.status(400).render('auth/login', {
      error: details.map((d) => d.message).join('. '),
      redirect: req.query.redirect || req.body.redirect || '',
    });
  }

  try {
    const { email, password } = parsed.data;
    const result = authService.login(email, password);

    res.cookie(COOKIE_NAME, result.token, cookieOptions());

    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({ user: result.user });
    }

    return res.redirect(getRedirectUrl(req));
  } catch (err) {
    logger.warn('Login failed', { error: err.message });

    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(err.status || 401).json({
        error: {
          code: err.code || 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    return res.status(err.status || 401).render('auth/login', {
      error: 'Invalid email or password',
      redirect: req.query.redirect || req.body.redirect || '',
    });
  }
});

/**
 * POST /auth/register — create account, set cookie, redirect.
 * Rate limited: 10 per 15 min per IP.
 */
router.post('/auth/register', authRegisterLimiter, (req, res) => {
  // Inline Zod validation so form POSTs get re-rendered views (not JSON) on failure
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details },
      });
    }

    const errors = {};
    for (const d of details) {
      errors[d.field] = d.message;
    }
    return res.status(400).render('auth/register', {
      error: 'Validation failed',
      errors,
      redirect: req.query.redirect || req.body.redirect || '',
    });
  }

  try {
    const { email, password, display_name } = parsed.data;
    const result = authService.register(email, password, display_name);

    res.cookie(COOKIE_NAME, result.token, cookieOptions());

    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(201).json({ user: result.user });
    }

    return res.redirect(getRedirectUrl(req));
  } catch (err) {
    logger.warn('Registration failed', { error: err.message });

    // Map EMAIL_EXISTS to VALIDATION_ERROR with details per INTERFACE_CONTRACT.md Section 4
    if (err.code === 'EMAIL_EXISTS') {
      const errorPayload = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: [{ field: 'email', message: 'Email already registered' }],
        },
      };

      if (req.accepts('json') && !req.accepts('html')) {
        return res.status(400).json(errorPayload);
      }

      return res.status(400).render('auth/register', {
        error: 'Email already registered',
        errors: { email: 'Email already registered' },
        redirect: req.query.redirect || req.body.redirect || '',
      });
    }

    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(err.status || 500).json({
        error: {
          code: err.code || 'INTERNAL_ERROR',
          message: err.message,
        },
      });
    }

    return res.status(err.status || 500).render('auth/register', {
      error: err.message,
      errors: {},
      redirect: req.query.redirect || req.body.redirect || '',
    });
  }
});

/**
 * POST /auth/logout — invalidate session, clear cookie.
 * Returns 204 for API, redirect for HTML.
 */
router.post('/auth/logout', requireAuth, (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  authService.logout(token);
  res.clearCookie(COOKIE_NAME);

  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(204).end();
  }

  return res.redirect('/jobs');
});

// Export router as default and helpers for testing
router._cookieOptions = cookieOptions;
router._getRedirectUrl = getRedirectUrl;

module.exports = router;
