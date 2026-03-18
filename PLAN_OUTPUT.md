# Implementation Plan

## File-by-File Changes

### NEW files to create:

| File | Type | Description |
|------|------|-------------|
| `src/db/schema.sql` | SQL | Full database schema (tables + indexes) |
| `src/db/database.js` | JS | SQLite init, migrations, DB connection |
| `src/routes/index.js` | JS | Main page routes (EJS rendering) |
| `src/routes/apiJobs.js` | JS | Job CRUD API routes |
| `src/routes/apiResumes.js` | JS | Resume upload/manage API |
| `src/routes/apiScrape.js` | JS | Scrape trigger + SSE progress |
| `src/routes/apiMatch.js` | JS | Matching trigger + results API |
| `src/routes/apiCoverLetter.js` | JS | CL generate + history API |
| `src/routes/apiAdmin.js` | JS | Stats + logs + config API |
| `src/services/scraperService.js` | JS | Python subprocess management, SSE |
| `src/services/matchService.js` | JS | Matching logic (skill/semantic/keyword) |
| `src/services/coverLetterService.js` | JS | OpenAI CL generation |
| `src/services/resumeParser.js` | JS | docx/pdf parsing |
| `src/services/configService.js` | JS | Env var reading, config management |
| `src/middleware/errorHandler.js` | JS | Global error middleware |
| `src/utils/logger.js` | JS | operation_logs writing |
| `src/utils/validators.js` | JS | Input validation helpers |
| `src/server.js` | JS | Express app entry point |
| `scrapers/run_scraper.py` | Python | Unified entry: `python run_scraper.py --source SEEK --keywords "AI,ML" --max_pages 5` |
| `scrapers/scrapers/__init__.py` | Python | Package init |
| `scrapers/scrapers/base_scraper.py` | Python | Base class with SSE output |
| `scrapers/scrapers/seek_scraper.py` | Python | SEEK implementation |
| `scrapers/scrapers/linkedin_scraper.py` | Python | LinkedIn implementation |
| `scrapers/scrapers/apsjobs_scraper.py` | Python | APSJobs implementation |
| `scrapers/requirements.txt` | TXT | Python deps: playwright, requests |
| `views/layout.ejs` | EJS | Base template |
| `views/home.ejs` | EJS | Landing/Dashboard page |
| `views/jobs/list.ejs` | EJS | Job list page |
| `views/jobs/detail.ejs` | EJS | Job detail page |
| `views/resumes/list.ejs` | EJS | Resume management page |
| `views/admin/dashboard.ejs` | EJS | Admin panel |
| `views/partials/header.ejs` | EJS | Navigation header |
| `views/partials/footer.ejs` | EJS | Footer |
| `views/partials/job-card.ejs` | EJS | Job card partial |
| `public/css/main.css` | CSS | CSS variables, reset, global |
| `public/css/components.css` | CSS | Cards, buttons, badges, forms |
| `public/css/pages/home.css` | CSS | Home page specific |
| `public/css/pages/jobs.css` | CSS | Job pages specific |
| `public/css/pages/admin.css` | CSS | Admin page specific |
| `public/js/main.js` | JS | Global utilities |
| `public/js/jobs.js` | JS | Job list interactions |
| `public/js/scrape.js` | JS | SSE scrape progress |
| `public/js/resume.js` | JS | Upload handling |
| `public/js/cover-letter.js` | JS | CL generate/copy |
| `public/js/admin.js` | JS | Admin interactions |
| `.env.example` | ENV | Template for env vars |
| `package.json` | JSON | Dependencies (update/add needed packages) |

### MODIFY files:

| File | Changes |
|------|---------|
| `package.json` | Add: `multer` (file upload), `mammoth`, `pdf-parse`, `openai`, `dotenv`, `better-sqlite3`, `cookie-parser`; Update scripts |
| `.env` | Add: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ADMIN_TOKEN`, `PORT=3001` |

### DELETE files from archive:
- All old `src/`, `views/`, `public/`, `scrapers/` files (already in `_archive_20260318/`)

---

## Dependency Order

```
1. database.js (DB must exist before any API)
2. schema.sql (tables must exist)
3. .env.example + package.json (env/script setup)
4. utils: logger.js, validators.js
5. middleware: errorHandler.js
6. services: configService.js, resumeParser.js
7. services: scraperService.js (Python entry point)
8. scrapers/ (Python files)
9. services: matchService.js, coverLetterService.js
10. routes: apiResumes.js, apiJobs.js, apiScrape.js, apiMatch.js, apiCoverLetter.js, apiAdmin.js
11. routes: index.js (page rendering)
12. server.js (wire everything together)
13. views/ (templates depend on routes)
14. public/css/ + public/js/ (frontend assets)
```

---

## Test Matrix

| ID | Module | Test Description | Expected Result |
|----|--------|-----------------|-----------------|
| T1 | DB | Init database creates all tables | 7 tables exist, indexes created |
| T2 | DB | Insert resume → retrieve | Resume with parsed_data returned |
| T3 | DB | Insert job → unique constraint (same source+external_id) | Second insert ignored |
| T4 | API Jobs | GET /api/jobs returns jobs list | 200, array of jobs |
| T5 | API Jobs | GET /api/jobs?source=seek&minScore=70 | Filtered results |
| T6 | API Jobs | PUT /api/jobs/:id/status | Status updated in DB |
| T7 | API Resume | POST /api/resumes/upload (valid .docx) | 200, resume record created |
| T8 | API Resume | POST /api/resumes/upload (invalid file) | 400, error response |
| T9 | API Resume | PUT /api/resumes/:id/primary | Previous primary unset, new primary set |
| T10 | API Scrape | POST /api/scrape/run starts subprocess | 200, history_id returned |
| T11 | API Scrape | SSE /api/scrape/progress/:id streams | SSE events with progress data |
| T12 | API Match | POST /api/match/run with no API key | Falls back to keyword matching |
| T13 | API Match | GET /api/match/:jobId for analyzed job | Score + gap analysis returned |
| T14 | API Match | Re-run match on already-analyzed job | Skip (cached), return existing |
| T15 | API CL | POST /api/cover-letters/generate | 200, CL content returned |
| T16 | API CL | GET /api/cover-letters/:jobId | All CLs for job returned |
| T17 | API Admin | GET /api/admin/stats | Counts returned for all entities |
| T18 | API Admin | GET /api/admin/logs | Log entries returned, filtered by level |
| T19 | API Admin | GET /api/admin/config/public | Base URL returned, no API key |
| T20 | Error | Invalid API route | 404 with error format |
| T21 | Error | DB connection failure | 500 with error logged |
| T22 | Python | run_scraper.py --source seek --keywords "AI" --max_pages 1 | JSON output with jobs |
| T23 | UI | Home page loads with no data | Shows empty state + upload prompt |
| T24 | UI | Job card hover effect | CSS animation fires |
| T25 | UI | Filter change updates job list | URL changes, new results render |

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Playwright blocked by SEEK/LinkedIn | H | H | Rate limiting (1 req/s), retry logic, graceful degradation to partial results |
| OpenAI API rate limit during batch matching | M | M | Exponential backoff, per-job retry, batch size limit (20 jobs/request) |
| PDF parsing fails on malformed files | M | L | Try/catch with error response, don't crash server |
| Very large JD (>50KB) causes memory issue | L | L | Truncate at 50KB in scraper |
| Python not installed on user's machine | H | L | Clear startup check with error message |
| SQLite file corruption | L | L | SQLite WAL mode for durability, backups via cp |
| SSE disconnect leaks Python process | M | M | Cleanup on disconnect, timeout at 5 min |
| Duplicate jobs from re-scrape | L | H | UNIQUE constraint on source+external_id, skip silently |
