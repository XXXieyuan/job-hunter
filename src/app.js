const path = require('path');
const express = require('express');
const engine = require('ejs-mate');
const cookieParser = require('cookie-parser');
const jobsRoutes = require('./routes/jobsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const resumeRoutes = require('./routes/resumeRoutes');
const authRoutes = require('./routes/authRoutes');
const applicationRoutes = require('./routes/applicationRoutes');
const coverLetterRoutes = require('./routes/coverLetterRoutes');
const scoreFeedbackRoutes = require('./routes/scoreFeedbackRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const alertRoutes = require('./routes/alertRoutes');
const salaryRoutes = require('./routes/salaryRoutes');
const batchApplyRoutes = require('./routes/batchApplyRoutes');
const { optionalAuth, csrfProtection } = require('./middleware/auth');
const { alertBadge } = require('./middleware/alertBadge');
const { rateLimiter } = require('./middleware/rateLimiter');
const { AppError, errorRingBuffer } = require('./utils/errors');
const { getLogger } = require('./logger');

const appLogger = getLogger('http');
const errorLogger = getLogger('errorHandler');
const app = express();

// Simple in-memory locale dictionaries
const locales = {
  en: require('./locales/en.json'),
  zh: require('./locales/zh.json'),
};

function resolveLocale(raw) {
  if (!raw) return 'en';
  const normalized = String(raw).toLowerCase();
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('zh')) return 'zh';
  return 'en';
}

function createTranslator(locale) {
  const primary = locales[locale] || locales.en;
  const fallbackDict = locales.en;

  return (key, defaultText) => {
    if (Object.prototype.hasOwnProperty.call(primary, key)) {
      return primary[key];
    }
    if (primary !== fallbackDict && Object.prototype.hasOwnProperty.call(fallbackDict, key)) {
      return fallbackDict[key];
    }
    return defaultText || key;
  };
}

// Use ejs-mate for layout support (needed for layout('layout') in views)
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));

// Global rate limiter: 120 requests per minute per IP
app.use(rateLimiter({ windowMs: 60 * 1000, max: 120 }));

// CSRF protection for state-changing requests (exempt unsubscribe — uses bearer token)
app.use((req, res, next) => {
  if (req.path.startsWith('/alerts/unsubscribe/')) {
    return next();
  }
  return csrfProtection(req, res, next);
});

// Attach req.user from session cookie if present (browse-first)
app.use(optionalAuth);

// Alert badge — injects unread count into res.locals for nav badge
app.use(alertBadge);

// Batch-apply readiness — injects profile/resume flags into res.locals for job listing
app.use(batchApplyRoutes.batchApplyReadiness);

// Basic request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const { method, url } = req;
  const userAgent = req.get('user-agent');

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    appLogger.info('HTTP request completed', {
      method,
      url,
      statusCode: res.statusCode,
      durationMs,
      userAgent,
    });
  });

  next();
});

// Language switch route – sets cookie then redirects back
app.get('/lang/:code', (req, res) => {
  const requested = req.params.code;
  const locale = resolveLocale(requested);

  res.cookie('lang', locale, {
    httpOnly: false,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  const referer = req.get('Referer');
  res.redirect(referer || '/jobs');
});

// Inject common locals (locale data available to all templates including error pages)
app.use((req, res, next) => {
  const cookieLang = req.cookies ? req.cookies.lang : null;
  const locale = resolveLocale(cookieLang);
  res.locals.locale = locale;
  res.locals.localeData = locales[locale] || locales.en;
  res.locals.t = createTranslator(locale);
  res.locals.currentPath = req.path;
  res.locals.user = req.user || null;
  next();
});

app.use('/', authRoutes);
app.use('/', jobsRoutes);
app.use('/', adminRoutes);
app.use('/', resumeRoutes);
app.use('/', applicationRoutes);
app.use('/', coverLetterRoutes);
app.use('/', scoreFeedbackRoutes);
app.use('/', settingsRoutes);
app.use('/', alertRoutes);
app.use('/', salaryRoutes);
app.use('/', batchApplyRoutes);

// 404 handler — must come after all routes
app.use((req, res, next) => {
  const isApiOrAdmin = req.path.startsWith('/api/') || req.path.startsWith('/admin/');
  if (isApiOrAdmin) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found' },
    });
  }
  res.status(404).render('errors/404', {
    statusCode: 404,
    message: res.locals.t('errors.404.body', "The page you're looking for doesn't exist or has been moved."),
  });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isApiOrAdmin = req.path.startsWith('/api/') || req.path.startsWith('/admin/');

  // Store error in ring buffer for admin viewer
  errorRingBuffer.push({
    timestamp: new Date().toISOString(),
    level: err.statusCode && err.statusCode < 500 ? 'warn' : 'error',
    message: err.message,
    stack: err.stack,
    context: {
      path: req.path,
      method: req.method,
      userId: req.user ? req.user.id : null,
    },
  });

  if (err instanceof AppError) {
    // Known application error
    errorLogger.warn('Application error', {
      code: err.code,
      message: err.message,
      path: req.path,
      method: req.method,
    });

    if (isApiOrAdmin) {
      return res.status(err.statusCode).json({ error: err.toJSON() });
    }

    // HTML response for non-API paths
    const statusCode = err.statusCode;
    if (statusCode === 404) {
      return res.status(404).render('errors/404', {
        statusCode: 404,
        message: err.message,
      });
    }
    return res.status(statusCode).render('errors/500', {
      statusCode,
      message: err.message,
    });
  }

  // Unhandled / unexpected error
  const isProduction = process.env.NODE_ENV === 'production';
  errorLogger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  const safeMessage = isProduction ? 'An unexpected error occurred' : (err.message || 'An unexpected error occurred');

  if (isApiOrAdmin) {
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: safeMessage },
    });
  }

  res.status(500).render('errors/500', {
    statusCode: 500,
    message: safeMessage,
  });
});

module.exports = app;
