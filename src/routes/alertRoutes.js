'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const notificationsRepo = require('../repositories/notificationsRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const usersRepo = require('../repositories/usersRepo');
const { AppError } = require('../utils/errors');
const { getLogger } = require('../logger');

const logger = getLogger('alertRoutes');
const router = express.Router();

const VALID_TOKEN_RE = /^[a-f0-9]{64}$/;

const unsubscribeRateLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  scope: 'ip',
  prefix: 'alert:unsubscribe',
});

/**
 * GET /alerts — Render alert history page
 */
router.get('/alerts', requireAuth, (req, res) => {
  res.render('pages/alerts', {
    user: req.user,
    currentPath: '/alerts',
  });
});

/**
 * GET /api/notifications — Paginated notification list with JOIN job data
 */
router.get('/api/notifications', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));

  let isRead;
  if (req.query.is_read === '0') isRead = 0;
  else if (req.query.is_read === '1') isRead = 1;

  const result = notificationsRepo.findByUser(req.user.id, { page, perPage, isRead });
  const unreadCount = notificationsRepo.getUnreadCount(req.user.id);

  // Parse top_matched_skills JSON for each notification
  const notifications = result.notifications.map((n) => {
    let topMatchedSkills = [];
    try {
      topMatchedSkills = JSON.parse(n.top_matched_skills || '[]');
    } catch {
      topMatchedSkills = [];
    }
    return {
      id: n.id,
      job_id: n.job_id,
      job_title: n.job_title,
      company_name: n.company_name,
      location: n.location,
      source: n.source,
      score: n.score,
      top_matched_skills: topMatchedSkills,
      visa_match: n.visa_match,
      is_read: n.is_read,
      created_at: n.created_at,
    };
  });

  res.json({
    notifications,
    unread_count: unreadCount,
    pagination: result.pagination,
  });
});

/**
 * PUT /api/notifications/:id/read — Mark a single notification as read
 */
router.put('/api/notifications/:id/read', requireAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return next(new AppError('NOT_FOUND', 'Notification not found'));
  }

  const updated = notificationsRepo.markRead(id, req.user.id);
  if (!updated) {
    return next(new AppError('NOT_FOUND', 'Notification not found'));
  }

  res.json({ notification: { id: updated.id, is_read: 1 } });
});

/**
 * PUT /api/notifications/read-all — Mark all notifications as read
 */
router.put('/api/notifications/read-all', requireAuth, (req, res) => {
  const count = notificationsRepo.markAllRead(req.user.id);
  res.json({ updated: count });
});

/**
 * GET /api/notifications/unread-count — Lightweight unread count
 */
router.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  const unreadCount = notificationsRepo.getUnreadCount(req.user.id);
  res.json({ unread_count: unreadCount });
});

/**
 * GET /alerts/unsubscribe/:token — Render unsubscribe confirmation page (no state change)
 */
router.get('/alerts/unsubscribe/:token', unsubscribeRateLimiter, (req, res) => {
  const { token } = req.params;

  if (!VALID_TOKEN_RE.test(token)) {
    return res.render('pages/unsubscribe', {
      layout: false,
      valid: false,
      success: false,
      currentPath: '/alerts/unsubscribe',
    });
  }

  const tokenRow = unsubscribeTokensRepo.findByToken(token);
  if (!tokenRow) {
    return res.render('pages/unsubscribe', {
      layout: false,
      valid: false,
      success: false,
      currentPath: '/alerts/unsubscribe',
    });
  }

  res.render('pages/unsubscribe', {
    layout: false,
    valid: true,
    success: false,
    token,
    currentPath: '/alerts/unsubscribe',
  });
});

/**
 * POST /alerts/unsubscribe/:token — Disable alerts for the user (CSRF exempt)
 */
router.post('/alerts/unsubscribe/:token', unsubscribeRateLimiter, (req, res) => {
  const { token } = req.params;

  if (!VALID_TOKEN_RE.test(token)) {
    return res.render('pages/unsubscribe', {
      layout: false,
      valid: false,
      success: false,
      currentPath: '/alerts/unsubscribe',
    });
  }

  const tokenRow = unsubscribeTokensRepo.findByToken(token);
  if (!tokenRow) {
    return res.render('pages/unsubscribe', {
      layout: false,
      valid: false,
      success: false,
      currentPath: '/alerts/unsubscribe',
    });
  }

  // Disable alerts in user's notification prefs
  const user = usersRepo.findById(tokenRow.user_id);
  if (user) {
    let prefs = {
      alerts_enabled: false,
      score_threshold: 70,
      frequency: 'immediate',
      digest_hour_utc: 22,
    };
    if (user.notification_prefs_json) {
      try {
        prefs = { ...prefs, ...JSON.parse(user.notification_prefs_json) };
      } catch {
        // use defaults
      }
    }
    prefs.alerts_enabled = false;
    usersRepo.updateNotificationPrefs(tokenRow.user_id, prefs);
    logger.info('User unsubscribed from alerts via token', { userId: tokenRow.user_id });
  }

  res.render('pages/unsubscribe', {
    layout: false,
    valid: true,
    success: true,
    currentPath: '/alerts/unsubscribe',
  });
});

module.exports = router;
