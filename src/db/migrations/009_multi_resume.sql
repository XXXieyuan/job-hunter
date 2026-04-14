-- ============================================================
-- Migration 009_multi_resume.sql
-- Add label column to resumes and create resume_overrides table
-- for multiple resume strategy feature
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Add label column to resumes table
-- ============================================================

ALTER TABLE resumes ADD COLUMN label TEXT DEFAULT NULL;

-- ============================================================
-- 2. Resume overrides table (manual resume selection per job)
-- ============================================================

CREATE TABLE IF NOT EXISTS resume_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_resume_overrides_user
  ON resume_overrides(user_id);

CREATE INDEX IF NOT EXISTS idx_resume_overrides_job_user
  ON resume_overrides(job_id, user_id);
