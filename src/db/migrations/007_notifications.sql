-- ============================================================
-- Migration 007_notifications.sql
-- Add notifications and unsubscribe_tokens tables for job alerts
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Notifications table
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  top_matched_skills TEXT NOT NULL DEFAULT '[]',
  visa_match INTEGER,
  frequency TEXT NOT NULL CHECK(frequency IN ('immediate', 'digest')),
  email_sent INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, job_id)
);

-- Partial index: fast unread count per user
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, is_read) WHERE is_read = 0;

-- Partial index: pending email dispatch
CREATE INDEX IF NOT EXISTS idx_notifications_pending_email
  ON notifications(email_sent, frequency) WHERE email_sent = 0;

-- Composite index: user's notification history sorted by newest
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- ============================================================
-- 2. Unsubscribe tokens table
-- ============================================================

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unsub_token ON unsubscribe_tokens(token);
