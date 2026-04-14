'use strict';

const notificationsRepo = require('../repositories/notificationsRepo');

/**
 * Express middleware that sets res.locals.unreadAlertCount.
 * Uses notificationsRepo.getUnreadCount() when req.user exists, or 0 when unauthenticated.
 */
function alertBadge(req, res, next) {
  if (req.user) {
    try {
      res.locals.unreadAlertCount = notificationsRepo.getUnreadCount(req.user.id);
    } catch {
      res.locals.unreadAlertCount = 0;
    }
  } else {
    res.locals.unreadAlertCount = 0;
  }
  next();
}

module.exports = { alertBadge };
