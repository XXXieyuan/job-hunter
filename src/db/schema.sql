CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  parsed_data TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_currency TEXT DEFAULT 'AUD',
  job_description TEXT NOT NULL,
  job_url TEXT NOT NULL,
  posted_date TEXT,
  classification TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
  total_score REAL NOT NULL,
  skill_score REAL,
  semantic_score REAL,
  keyword_score REAL,
  gap_analysis TEXT,
  analyzed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, resume_id)
);

CREATE TABLE IF NOT EXISTS cover_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unread',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id)
);

CREATE TABLE IF NOT EXISTS scrape_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id),
  keywords TEXT,
  pages INTEGER,
  jobs_found INTEGER,
  status TEXT NOT NULL,
  error_msg TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_job ON matches(job_id);
CREATE INDEX IF NOT EXISTS idx_matches_resume ON matches(resume_id);
CREATE INDEX IF NOT EXISTS idx_matches_score ON matches(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_cl_job ON cover_letters(job_id);
CREATE INDEX IF NOT EXISTS idx_cl_resume ON cover_letters(resume_id);
CREATE INDEX IF NOT EXISTS idx_scrape_history_source ON scrape_history(source_id);
CREATE INDEX IF NOT EXISTS idx_scrape_history_started ON scrape_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_level ON operation_logs(level);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at DESC);
