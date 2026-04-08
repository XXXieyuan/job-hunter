-- ============================================================
-- Migration 004_rebuild.sql
-- Evolve existing schema to full 13-table Job Hunter schema
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. NEW TABLES (do not exist yet)
-- ============================================================

-- Users table (Tier 1: minimal auth)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  notification_prefs_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Sessions table (token-based auth)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Applications table (Tier 2: lifecycle tracking)
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'saved',
  notes TEXT,
  applied_at DATETIME,
  status_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_user_status ON applications(user_id, status);

-- Duplicate groups (Tier 1: deduplication tracking)
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  match_method TEXT,
  confidence REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Duplicate group members
CREATE TABLE IF NOT EXISTS duplicate_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE(group_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_dup_members_job ON duplicate_group_members(job_id);

-- User feedback on scores
CREATE TABLE IF NOT EXISTS score_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL,
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 2. ALTER existing tables to add new columns
--    Each ALTER is wrapped in a try-safe pattern using
--    CREATE TRIGGER trick -- but since SQLite doesn't support
--    IF NOT EXISTS for ALTER, we rely on the migration system
--    to run this only once.
-- ============================================================

-- resumes: add new columns from SYSTEM_DESIGN.md
-- (file_name, file_type, storage_path, is_main, parsed_data already added by 002)
ALTER TABLE resumes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE resumes ADD COLUMN file_path TEXT;
ALTER TABLE resumes ADD COLUMN certifications_json TEXT;
ALTER TABLE resumes ADD COLUMN embedding BLOB;
ALTER TABLE resumes ADD COLUMN embedding_model TEXT;
ALTER TABLE resumes ADD COLUMN raw_text TEXT;
ALTER TABLE resumes ADD COLUMN is_confirmed INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id);

-- jobs: add new columns
ALTER TABLE jobs ADD COLUMN canonical_job_id INTEGER REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE jobs ADD COLUMN work_type TEXT;
ALTER TABLE jobs ADD COLUMN salary_min INTEGER;
ALTER TABLE jobs ADD COLUMN salary_max INTEGER;
ALTER TABLE jobs ADD COLUMN closes_at TEXT;
ALTER TABLE jobs ADD COLUMN visa_eligibility TEXT;
ALTER TABLE jobs ADD COLUMN security_clearance TEXT;
ALTER TABLE jobs ADD COLUMN aps_classification TEXT;
ALTER TABLE jobs ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE jobs ADD COLUMN embedding BLOB;
ALTER TABLE jobs ADD COLUMN embedding_model TEXT;
ALTER TABLE jobs ADD COLUMN scraped_at DATETIME;
ALTER TABLE jobs ADD COLUMN updated_at DATETIME;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(is_active);
CREATE INDEX IF NOT EXISTS idx_jobs_visa ON jobs(visa_eligibility);
CREATE INDEX IF NOT EXISTS idx_jobs_aps_class ON jobs(aps_classification) WHERE aps_classification IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_canonical ON jobs(canonical_job_id) WHERE canonical_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at);

-- companies: add new columns
ALTER TABLE companies ADD COLUMN logo_url TEXT;
ALTER TABLE companies ADD COLUMN headquarters TEXT;
ALTER TABLE companies ADD COLUMN raw_json TEXT;
ALTER TABLE companies ADD COLUMN updated_at DATETIME;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name ON companies(name);

-- job_fit_scores: add new columns
ALTER TABLE job_fit_scores ADD COLUMN semantic_score REAL;
ALTER TABLE job_fit_scores ADD COLUMN role_alignment_score REAL;
ALTER TABLE job_fit_scores ADD COLUMN location_score REAL;
ALTER TABLE job_fit_scores ADD COLUMN skill_gaps_json TEXT;
ALTER TABLE job_fit_scores ADD COLUMN visa_match INTEGER;

CREATE INDEX IF NOT EXISTS idx_fit_scores_resume ON job_fit_scores(resume_id);
CREATE INDEX IF NOT EXISTS idx_fit_scores_overall ON job_fit_scores(overall_score);

-- cover_letters: add new columns
ALTER TABLE cover_letters ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE cover_letters ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE cover_letters ADD COLUMN user_edited_content TEXT;
ALTER TABLE cover_letters ADD COLUMN prompt_version TEXT;
ALTER TABLE cover_letters ADD COLUMN updated_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_cover_letters_user ON cover_letters(user_id);
CREATE INDEX IF NOT EXISTS idx_cover_letters_job ON cover_letters(job_id);

-- scraper_runs: add new columns (003 schema differs from target)
ALTER TABLE scraper_runs ADD COLUMN config_json TEXT;
ALTER TABLE scraper_runs ADD COLUMN jobs_found INTEGER DEFAULT 0;
ALTER TABLE scraper_runs ADD COLUMN jobs_new INTEGER DEFAULT 0;
ALTER TABLE scraper_runs ADD COLUMN jobs_updated INTEGER DEFAULT 0;
ALTER TABLE scraper_runs ADD COLUMN pages_scraped INTEGER DEFAULT 0;
ALTER TABLE scraper_runs ADD COLUMN error TEXT;
ALTER TABLE scraper_runs ADD COLUMN completed_at DATETIME;
ALTER TABLE scraper_runs ADD COLUMN created_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_scraper_runs_name ON scraper_runs(scraper_name);

-- analysis_runs: add new columns
ALTER TABLE analysis_runs ADD COLUMN type TEXT NOT NULL DEFAULT 'full';
ALTER TABLE analysis_runs ADD COLUMN config_json TEXT;

CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status);

-- ============================================================
-- 3. FTS5 virtual table for jobs full-text search
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title,
  company_name,
  location,
  description,
  content='jobs',
  content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company_name, location, description)
  VALUES (new.id, new.title, new.company_name, new.location, new.description);
END;

CREATE TRIGGER IF NOT EXISTS jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name, location, description)
  VALUES ('delete', old.id, old.title, old.company_name, old.location, old.description);
END;

CREATE TRIGGER IF NOT EXISTS jobs_au AFTER UPDATE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_name, location, description)
  VALUES ('delete', old.id, old.title, old.company_name, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company_name, location, description)
  VALUES (new.id, new.title, new.company_name, new.location, new.description);
END;
