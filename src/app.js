const path = require('path');
const express = require('express');
const engine = require('ejs-mate');
const cookieParser = require('cookie-parser');
const jobsRoutes = require('./routes/jobsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const resumeRoutes = require('./routes/resumeRoutes');
const { getLogger } = require('./logger');

const appLogger = getLogger('http');
const app = express();

// Simple in-memory locale dictionaries
const locales = {
  en: require('./locales/en.json'),
  zh: require('./locales/zh.json'),
};

function resolveLocale(raw) {
  if (!raw) return 'zh';
  const normalized = String(raw).toLowerCase();
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('zh')) return 'zh';
  return 'zh';
}

function createTranslator(locale) {
  const primary = locales[locale] || locales.zh;
  const fallbackDict = locales.zh;

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

// Inject common locals
app.use((req, res, next) => {
  const cookieLang = req.cookies ? req.cookies.lang : null;
  const locale = resolveLocale(cookieLang);
  res.locals.locale = locale;
  res.locals.t = createTranslator(locale);
  res.locals.currentPath = req.path;
  next();
});

app.use('/', jobsRoutes);
app.use('/', adminRoutes);
app.use('/', resumeRoutes);

app.use((req, res) => {
  res.status(404).send(res.locals.t('errors.404', '未找到页面'));
});

module.exports = app;
