'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const usersRepo = require('../repositories/usersRepo');
const { getConfirmedResumeForUser } = require('../repositories/resumesRepo');
const unsubscribeTokensRepo = require('../repositories/unsubscribeTokensRepo');
const { AppError } = require('../utils/errors');
const { getLogger } = require('../logger');

const logger = getLogger('settingsRoutes');
const router = express.Router();

const DEFAULT_PREFS = {
  alerts_enabled: false,
  score_threshold: 70,
  frequency: 'immediate',
  digest_hour_utc: 22,
};

const notificationPrefsSchema = z.object({
  alerts_enabled: z.boolean(),
  score_threshold: z.number().int().min(50).max(100),
  frequency: z.enum(['immediate', 'digest']),
  digest_hour_utc: z.number().int().min(0).max(23),
});

/**
 * GET /settings — Render settings page
 */
router.get('/settings', requireAuth, (req, res) => {
  res.render('pages/settings', {
    user: req.user,
    currentPath: '/settings',
  });
});

/**
 * GET /api/settings/notifications — Return current notification preferences
 */
router.get('/api/settings/notifications', requireAuth, (req, res) => {
  const user = usersRepo.findById(req.user.id);
  let preferences = DEFAULT_PREFS;

  if (user && user.notification_prefs_json) {
    try {
      preferences = { ...DEFAULT_PREFS, ...JSON.parse(user.notification_prefs_json) };
    } catch {
      // Use defaults on parse error
    }
  }

  res.json({ preferences });
});

/**
 * PUT /api/settings/notifications — Update notification preferences
 */
router.put(
  '/api/settings/notifications',
  requireAuth,
  rateLimiter({ windowMs: 60 * 1000, max: 10, scope: 'user', prefix: 'settings:notifications' }),
  (req, res, next) => {
    const result = notificationPrefsSchema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(new AppError('VALIDATION_ERROR', 'Invalid notification preferences', details));
    }

    const prefs = result.data;

    // Guard: alerts_enabled=true requires a confirmed resume
    if (prefs.alerts_enabled) {
      const confirmedResume = getConfirmedResumeForUser(req.user.id);
      if (!confirmedResume) {
        return next(new AppError('RESUME_NOT_CONFIRMED', 'Upload and confirm a resume before enabling alerts'));
      }
    }

    // Check if transitioning false→true for unsubscribe token generation
    const user = usersRepo.findById(req.user.id);
    let currentEnabled = false;
    if (user && user.notification_prefs_json) {
      try {
        const current = JSON.parse(user.notification_prefs_json);
        currentEnabled = current.alerts_enabled === true;
      } catch {
        // treat as false
      }
    }

    if (prefs.alerts_enabled && !currentEnabled) {
      unsubscribeTokensRepo.getOrCreate(req.user.id);
      logger.info('Unsubscribe token generated on alert enable', { userId: req.user.id });
    }

    usersRepo.updateNotificationPrefs(req.user.id, prefs);

    res.json({ preferences: prefs });
  }
);

module.exports = router;
