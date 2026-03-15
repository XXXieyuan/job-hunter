CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  summary TEXT,
  skills_json TEXT,
  experience_json TEXT,
  education_json TEXT,
  raw_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,
  source TEXT DEFAULT 'manual',
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  company_name TEXT,
  location TEXT,
  salary TEXT,
  description TEXT,
  url TEXT,
  posted_at TEXT,
  application_status TEXT DEFAULT '未申请',
  raw_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  website TEXT,
  description TEXT,
  raw_html TEXT,
  industry TEXT,
  size TEXT,
  researched_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_fit_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  resume_id INTEGER NOT NULL REFERENCES resumes(id),
  overall_score REAL,
  keyword_score REAL,
  embedding_score REAL,
  breakdown_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, resume_id)
);

CREATE TABLE IF NOT EXISTS cover_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  resume_id INTEGER NOT NULL REFERENCES resumes(id),
  language TEXT DEFAULT 'en',
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, resume_id, language)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'running',
  sources_json TEXT,
  stats_json TEXT,
  error TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_jobs_role ON jobs(role);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_name);
CREATE INDEX IF NOT EXISTS idx_fit_scores_score ON job_fit_scores(overall_score);
CREATE INDEX IF NOT EXISTS idx_fit_scores_job ON job_fit_scores(job_id);

