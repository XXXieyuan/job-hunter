-- ============================================================
-- Migration 008_optimization_suggestions.sql
-- Add optimization_suggestions table for resume optimization feature
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Optimization suggestions table
-- ============================================================

CREATE TABLE IF NOT EXISTS optimization_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_score REAL NOT NULL,
  predicted_score REAL NOT NULL,
  suggestions_json TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, resume_id)
);

CREATE INDEX IF NOT EXISTS idx_optimization_suggestions_user
  ON optimization_suggestions(user_id);

CREATE INDEX IF NOT EXISTS idx_optimization_suggestions_job_resume
  ON optimization_suggestions(job_id, resume_id);
