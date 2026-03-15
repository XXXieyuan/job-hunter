# Autopilot Work Log — 2026-03-15 (Job Hunter)

## Task
Build a standalone web service "Job Hunter" (职位猎手) that scrapes job posts from seek.com.au, scores them against a sample resume, researches high-fit companies, and generates tailored cover letters.

## Timeline

### [17:10] Research — Amy (Coordinator)
- Attempted to fetch seek.com.au directly → **403 bot protection** (Cloudflare)
- Tested internal API endpoints → 404
- **Conclusion:** Direct scraping blocked. Informed Planner.

### [17:12] Planner: `kind-zephyr` (gpt-5.4, read-only) ✅
- Produced comprehensive architecture:
  - File structure (25+ files)
  - Database schema (6 tables + indexes)
  - Scoring algorithm (keyword 40% + embedding 60%)
  - Cover letter generation via OpenAI
  - Company research pipeline
  - Admin dashboard with manual trigger + CSV upload
  - Bonus: gap analysis, application tracking

### [17:20] Executor Phase 1: `ember-pine` (gpt-5.3-codex-xhigh, full-auto) ✅
- Created 25 files: full app structure
- 81,706 tokens used
- All syntax checks passed

### [17:30] Executor Phase 2: `neat-shell` (gpt-5.3-codex-xhigh, full-auto) ✅
- Fixed EJS layout system (ejs-mate integration)

### [17:35] Verification ✅
- ✅ All syntax checks pass
- ✅ Server starts on port 3001
- ✅ Job upload (JSON multipart) works — 5 test jobs imported
- ✅ Analysis pipeline runs successfully (keyword scoring working)
- ✅ Cover letters generated for 3 high-fit jobs
- ✅ Company research completed for 3 companies
- ✅ Web UI renders job list with scores
- ✅ Job detail page shows description + cover letter + company info
- ✅ Admin dashboard renders with all controls
- ✅ Dark neon glassmorphism theme applied

### [17:40] Git Commit ✅
- Commit: local only (no remote repo configured yet)
- 26 files committed

## Known Limitations
- OpenAI text-embedding-3-small not available at current API → embedding scores are 0, keyword-only scoring works
- Seek.com.au scraping not implemented (bot protection) → manual JSON/CSV upload only
- No GitHub repo created yet (needs Andy to set up)

## Architecture

### Database Tables
| Table | Purpose |
|-------|---------|
| resumes | Sample resume storage |
| jobs | Job postings (imported or scraped) |
| companies | Company research results |
| job_fit_scores | Resume-job matching scores |
| cover_letters | Generated cover letters |
| analysis_runs | Pipeline execution history |

### Scoring
- Keyword matching: extracts skills/tools from JD, matches against resume → 0-100
- Embedding (disabled): OpenAI text-embedding-3-small cosine similarity
- Weighted: keyword 40% + embedding 60% (keyword 100% when embedding unavailable)

### UI Pages
- `/jobs` — Job listing with filters (role, score threshold)
- `/jobs/:id` — Detail with JD, score breakdown, cover letter, company info, gap analysis
- `/admin` — Dashboard with "运行分析" button, upload form, run history

### Test Results (5 sample jobs)
| Job | Company | Score |
|-----|---------|-------|
| Senior AI Engineer | Canva | 57% |
| ML Engineer - CV | Nearmap | 51% |
| PM - AI Platform | Atlassian | 51% |
| Head of Product | SafetyCulture | 22% |
| Junior Data Scientist | CBA | 19% |

## Files Created (26 total)
- `src/app.js`, `src/server.js`
- `src/config/index.js`
- `src/db/connection.js`, `src/db/migrate.js`, `src/db/migrations/001_init.sql`
- `src/repositories/` (6 files)
- `src/services/` (6 files)
- `src/routes/` (2 files)
- `views/` (4 ejs templates)
- `public/css/main.css`, `public/js/main.js`, `public/js/admin.js`
- `data/sample-resume.json`
- `.env`, `.gitignore`, `package.json`
