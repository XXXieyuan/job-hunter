-- ============================================================
-- Migration 005_schema_alignment.sql
-- Ensure all 14 tables match SYSTEM_DESIGN.md Section 2
-- Adds missing columns, constraints, and indexes
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Ensure duplicate_group_members has source column
-- ============================================================
ALTER TABLE duplicate_group_members ADD COLUMN source TEXT NOT NULL DEFAULT '';

-- ============================================================
-- 2. Ensure job_fit_scores has all required columns
-- ============================================================
ALTER TABLE job_fit_scores ADD COLUMN values_international_experience INTEGER;
ALTER TABLE job_fit_scores ADD COLUMN breakdown_json TEXT;

-- Create unique index on (job_id, resume_id) if not exists
CREATE UNIQUE INDEX IF NOT EXISTS idx_fit_scores_job_resume
  ON job_fit_scores(job_id, resume_id);

-- ============================================================
-- 3. Ensure cover_letters has unique constraint
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_cover_letters_unique_tuple
  ON cover_letters(job_id, resume_id, language, mode);

-- ============================================================
-- 4. Ensure resumes has updated_at column
-- ============================================================
ALTER TABLE resumes ADD COLUMN updated_at DATETIME;

-- ============================================================
-- 5. Additional performance indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_jobs_salary_min ON jobs(salary_min) WHERE salary_min IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_score_feedback_job ON score_feedback(job_id);
CREATE INDEX IF NOT EXISTS idx_score_feedback_user ON score_feedback(user_id);
