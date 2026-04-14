-- ============================================================
-- Migration 010_batch_apply.sql
-- Add tables for semi-automated batch apply feature:
-- application_profiles, batch_apply_sessions, batch_apply_jobs
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Application profiles (one per user)
-- ============================================================

CREATE TABLE IF NOT EXISTS application_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  visa_status TEXT NOT NULL,
  work_rights TEXT NOT NULL,
  expected_salary TEXT,
  notice_period TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_profiles_user
  ON application_profiles(user_id);

-- ============================================================
-- 2. Batch apply sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS batch_apply_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  total_jobs INTEGER NOT NULL,
  applied_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_batch_sessions_user
  ON batch_apply_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_batch_sessions_status
  ON batch_apply_sessions(status);

-- ============================================================
-- 3. Batch apply jobs (per-job tracking within a session)
-- ============================================================

CREATE TABLE IF NOT EXISTS batch_apply_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES batch_apply_sessions(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id INTEGER REFERENCES cover_letters(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_reason TEXT,
  filled_fields TEXT,
  warnings TEXT,
  started_at DATETIME,
  applied_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_session
  ON batch_apply_jobs(session_id);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_job
  ON batch_apply_jobs(job_id);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status
  ON batch_apply_jobs(status);
