# Work Breakdown Structure

## Dependency Graph

```
Batch 1 (Foundation)
  WBS 1.1 → 1.2 → 1.3 → 1.4 → 1.5
                    ↓
Batch 2 (Core Services)
  WBS 2.1 → 2.2 → 2.3
                    ↓
Batch 3 (Python Scrapers)
  WBS 3.1 → 3.2 → 3.3 → 3.4
                    ↓
Batch 4 (AI Services)
  WBS 4.1 → 4.2
                    ↓
Batch 5 (API Routes)
  WBS 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6
                    ↓
Batch 6 (Frontend)
  WBS 6.1 → 6.2
                    ↓
Batch 7 (Wire & Test)
  WBS 7.1 → 7.2 → 7.3
```

## Execution Order

**Batch 1 (Foundation — no deps):**
- Parallel: 1.1, 1.2, 1.3, 1.4, 1.5

**Batch 2 (Core Services — after 1.1-1.5):**
- Sequential: 2.1 → 2.2 → 2.3

**Batch 3 (Scrapers — after 2.3):**
- Sequential: 3.1 → 3.2 → 3.3 → 3.4

**Batch 4 (AI Services — after 2.2):**
- Sequential: 4.1 → 4.2

**Batch 5 (API Routes — after 2.x and 4.x):**
- Sequential: 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6

**Batch 6 (Frontend — after 5.x):**
- Parallel: 6.1 → 6.2

**Batch 7 (Wire & Test — after 6.x):**
- Sequential: 7.1 → 7.2 → 7.3

---

## WBS Tasks

### WBS 1.1: Environment & Package Setup
**What**: Set up Node.js dependencies and environment variables
**Where**: `package.json`, `.env`, `.env.example`
**Input**: PLAN_OUTPUT.md Dependency Order
**Steps**:
1. Update `package.json` dependencies: add `multer`, `mammoth`, `pdf-parse`, `openai`, `dotenv`, `cookie-parser`, `express-rate-limit`
2. Update `scripts`: `start`, `dev`, `scrape:seek`, `scrape:apsjobs`
3. Create `.env.example` with all required env vars: `PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ADMIN_TOKEN`, `DATABASE_PATH`
4. Create `.env` from example (empty values for user to fill)
5. Run `npm install`
**Output**: package-lock.json updated, .env files created
**Verify**: `node -e "require('./package.json'); require('dotenv').config(); console.log('OK')"`
**Depends on**: None
**Complexity**: S

---

### WBS 1.2: Database Schema
**What**: Create complete SQLite schema with all tables and indexes
**Where**: `src/db/schema.sql`, `src/db/database.js`
**Input**: SYSTEM_DESIGN.md Data Model
**Steps**:
1. Write `src/db/schema.sql` with all 7 tables (resumes, sources, jobs, matches, cover_letters, job_status, scrape_history, config, operation_logs) + all indexes
2. Enable WAL mode and foreign keys
3. Write `src/db/database.js`:
   - `initDatabase()`: create tables if not exist, seed `sources` table
   - `getDb()`: return database connection
   - Export all tables as constant names
4. Create `data/` directory if not exists
**Output**: schema.sql + database.js, data/ directory
**Verify**: `node -e "require('./src/db/database'); console.log('Tables created OK')"`
**Depends on**: None
**Complexity**: S

---

### WBS 1.3: Utility Modules
**What**: Logger and validator utilities
**Where**: `src/utils/logger.js`, `src/utils/validators.js`
**Input**: SYSTEM_DESIGN.md Error Handling
**Steps**:
1. `src/utils/logger.js`:
   - `log(level, action, detail)`: write to operation_logs table
   - Auto-timestamp, sanitize detail (no SQL injection)
   - Levels: info, warn, error
2. `src/utils/validators.js`:
   - `validateFileType(filename, allowedTypes)`: check extension
   - `validateJobStatus(status)`: enum check
   - `validateLanguage(lang)`: 'en' | 'zh'
   - `validateSource(source)`: 'seek' | 'linkedin' | 'apsjobs'
**Output**: logger.js, validators.js
**Verify**: `node -e "require('./src/utils/logger'); require('./src/utils/validators'); console.log('OK')"`
**Depends on**: WBS 1.2
**Complexity**: S

---

### WBS 1.4: Error Handler Middleware
**What**: Global Express error handling middleware
**Where**: `src/middleware/errorHandler.js`
**Input**: SYSTEM_DESIGN.md Error Handling Strategy
**Steps**:
1. Export function `(err, req, res, next)`:
   - Log error via logger (level: error, action: 'ERROR', detail: err.message)
   - If `err.statusCode`: use it; else 500
   - Return JSON: `{ error: true, code: err.code || 'SERVER_ERROR', message: err.message }`
   - Never leak stack traces to client
**Output**: errorHandler.js
**Verify**: `node -e "require('./src/middleware/errorHandler'); console.log('OK')"`
**Depends on**: WBS 1.3
**Complexity**: S

---

### WBS 1.5: Config Service
**What**: Environment variable reader and config management
**Where**: `src/services/configService.js`
**Input**: SYSTEM_DESIGN.md Tech Stack
**Steps**:
1. Load dotenv at top
2. Export `getConfig()`: returns `{ port, openaiApiKey, openaiBaseUrl, adminToken, databasePath }`
3. Validate required vars at startup: `OPENAI_API_KEY` and `OPENAI_BASE_URL` (warn if missing, don't crash)
4. Admin token defaults to a random string if not set
**Output**: configService.js
**Verify**: `node -e "require('./src/services/configService'); console.log(JSON.stringify(getConfig()))"`
**Depends on**: WBS 1.1
**Complexity**: S

---

### WBS 2.1: Resume Parser Service
**What**: Parse docx/pdf resumes into structured data
**Where**: `src/services/resumeParser.js`
**Input**: SYSTEM_DESIGN.md Resume APIs, DESIGN.md ResumeCard
**Steps**:
1. `parseDocx(filePath)`: use mammoth to extract text, regex for email/phone/education/skills
2. `parsePdf(filePath)`: use pdf-parse to extract text, same regex extraction
3. `parseResume(filePath, fileType)`: dispatch to correct parser
4. Extract: name (first line or email prefix), skills (bullet points, "Skills:" section), experience (job titles, companies), education (degrees, institutions)
5. Return JSON: `{ name, skills: [], experience: [], education: [], rawText }`
6. On parse error: return `{ error: true, message }` (don't crash)
**Output**: resumeParser.js
**Verify**: `node -e "require('./src/services/resumeParser'); parseDocx('test.docx').then(r => console.log(JSON.stringify(r, null, 2)))"`
**Depends on**: WBS 1.1, 1.3, 1.4
**Complexity**: M

---

### WBS 2.2: Scraper Service (Node side)
**What**: Python scraper subprocess management and SSE progress streaming
**Where**: `src/services/scraperService.js`
**Input**: SYSTEM_DESIGN.md Component Architecture, API Contract (Scrape APIs)
**Steps**:
1. `runScraper(source, keywords, maxPages, historyId)`: spawn Python subprocess
   - Command: `python3 scrapers/run_scraper.py --source {source} --keywords "{keywords}" --max_pages {maxPages} --history_id {historyId}`
   - Capture stdout line by line (each line is SSE format: `data: {...}\n\n`)
   - Parse each JSON line → emit to SSE clients
   - Capture stderr → log error
2. `getProgressStream(historyId)`: return Express Response with SSE headers
   - Set `Content-Type: text/event-stream`
   - `Cache-Control: no-cache`
   - `Connection: keep-alive`
   - Send keep-alive ping every 30s
3. Store active SSE connections in Map<historyId, Response[]>
4. Cleanup: when Python exits, close all SSE connections for that historyId
5. Timeout: kill subprocess after 5 minutes
**Output**: scraperService.js
**Verify**: `node -e "require('./src/services/scraperService'); console.log(typeof runScraper, typeof getProgressStream)"`
**Depends on**: WBS 1.4, 1.5, 2.3
**Complexity**: L

---

### WBS 2.3: Database Setup & Seed
**What**: Initialize database and seed source table
**Where**: `src/db/database.js`
**Input**: WBS 1.2 schema
**Steps**:
1. Ensure `data/` directory exists
2. Open SQLite with `data/jobhunter.db`
3. Enable WAL mode: `PRAGMA journal_mode=WAL`
4. Enable foreign keys: `PRAGMA foreign_keys=ON`
5. Run schema.sql
6. Seed `sources` table: INSERT OR IGNORE for 'seek', 'linkedin', 'apsjobs'
7. Log startup: `logger('info', 'SERVER_START', 'Job Hunter v2 started')`
**Output**: data/jobhunter.db created
**Verify**: `ls -la data/jobhunter.db && node -e "const db = require('./src/db/database'); console.log('DB OK')"`
**Depends on**: WBS 1.1, 1.2
**Complexity**: S

---

### WBS 3.1: Python Base Scraper
**What**: Base scraper class with SSE output and common utilities
**Where**: `scrapers/scrapers/base_scraper.py`
**Input**: SYSTEM_DESIGN.md Scraper Architecture
**Steps**:
1. Class `BaseScraper`:
   - `__init__(source, keywords, max_pages, history_id)`: store params
   - `sse_emit(event_type, data)`: print `data: {...}\n\n` to stdout (SSE format)
   - `rate_limit(delay=1.0)`: sleep between requests
   - `parse_salary(text)`: extract min/max from text like "$130k-$160k"
   - `clean_text(text)`: remove HTML, normalize whitespace
   - `get_session()`: return requests.Session with headers (mimic browser)
   - `validate_job(job)`: check required fields (title, job_url, job_description)
2. `main()` function: parse args, instantiate scraper, call `scrape()`, exit(0) or exit(1)
**Output**: base_scraper.py
**Verify**: `python3 scrapers/scrapers/base_scraper.py --help` shows usage
**Depends on**: WBS 2.2
**Complexity**: M

---

### WBS 3.2: SEEK Scraper
**What**: SEEK.com.au scraper implementation
**Where**: `scrapers/scrapers/seek_scraper.py`
**Input**: WBS 3.1 base class
**Steps**:
1. Class `SeekScraper(BaseScraper)`:
   - `scrape()`: main entry
   - Build URL: `seek.com.au/{keyword}/in-{location}?page={N}`
   - Default location: Australia-wide
   - Parse job cards: use `data-automation` selectors or CSS class fallback
   - Extract per job: title, company, location, salary, job_description (click to get full JD), job_url, posted_date
   - Handle pagination: loop until no more pages or max_pages reached
   - On each job found: `sse_emit('job_found', job_data)`
   - On page done: `sse_emit('page_done', {page, total_found})`
2. Use Playwright for JS-rendered content (headless Chrome)
3. Output JSON job objects to stdout for Node.js to parse
**Output**: seek_scraper.py
**Verify**: `python3 scrapers/run_scraper.py --source seek --keywords "AI Engineer" --max_pages 1 2>&1 | head -20`
**Depends on**: WBS 3.1
**Complexity**: L

---

### WBS 3.3: APSJobs Scraper
**What**: APSJobs.gov.au scraper implementation
**Where**: `scrapers/scrapers/apsjobs_scraper.py`
**Input**: WBS 3.1 base class, v1 APS scraper logic
**Steps**:
1. Class `APSJobsScraper(BaseScraper)`:
   - URL: `apsjobs.gov.au/employer/psa/jobs.html?keywords={keyword}&page={N}`
   - Parse job cards: table rows in job listings
   - Extract: title, classification (APS level), location, salary range, job_description, job_url, posted_date
   - No JS rendering needed (static HTML)
2. Reuse parsing logic from v1 archived scraper (adapt to base_scraper SSE format)
**Output**: apsjobs_scraper.py
**Verify**: `python3 scrapers/run_scraper.py --source apsjobs --keywords "AI" --max_pages 1 2>&1 | head -20`
**Depends on**: WBS 3.1
**Complexity**: M

---

### WBS 3.4: LinkedIn Scraper
**What**: LinkedIn scraper (public pages, rate-limited)
**Where**: `scrapers/scrapers/linkedin_scraper.py`
**Input**: WBS 3.1 base class
**Steps**:
1. Class `LinkedInScraper(BaseScraper)`:
   - URL: `linkedin.com/jobs/search/?keywords={keyword}&location=Australia&start={N*25}`
   - Parse job cards: JSON-LD or specific CSS selectors
   - Extract: title, company, location, job_description (may be truncated), job_url, posted_date
   - Rate limit: 2 seconds between requests (LinkedIn is aggressive)
2. Fallback: if blocked, return partial results with warning
3. Note: LinkedIn requires login for full JD — implement with cookie warning
**Output**: linkedin_scraper.py
**Verify**: `python3 scrapers/run_scraper.py --source linkedin --keywords "Data Scientist" --max_pages 1 2>&1 | head -20`
**Depends on**: WBS 3.1
**Complexity**: M

---

### WBS 4.1: Matching Service
**What**: Job-resume matching with skill/semantic/keyword scoring
**Where**: `src/services/matchService.js`
**Input**: SYSTEM_DESIGN.md AI Matching, API Contract Match APIs
**Steps**:
1. `runMatch(jobId, resumeId)`: main matching function
2. `skillMatch(jobDescription, resumeSkills)`: tokenize JD skills vs resume skills, Jaccard similarity × 100
3. `keywordMatch(jobDescription, resumeText)`: 
   - Extract keywords from JD (nouns, technical terms)
   - Count occurrences in resume
   - Normalize to 0-100
4. `semanticMatch(jobDescription, resumeText)` (if API key available):
   - Call OpenAI embeddings API
   - Compute cosine similarity
   - Normalize to 0-100
5. `calculateGapAnalysis(jobDescription, resumeText, resumeSkills)`:
   - Find missing skills from JD not in resume
   - Find weak/skewed skills
   - Return: `{ missing: [], weak: [], strong: [] }`
6. `compositeScore(skill, semantic, keyword)`: weighted average (40% skill, 40% semantic, 20% keyword)
   - If no semantic: weight becomes (50% skill, 50% keyword)
7. Save to `matches` table
8. `batchMatch(jobIds)`: process array, skip already-matched jobs
**Output**: matchService.js
**Verify**: `node -e "require('./src/services/matchService'); console.log(typeof runMatch, typeof batchMatch)"`
**Depends on**: WBS 1.3, 1.5, 2.1
**Complexity**: M

---

### WBS 4.2: Cover Letter Service
**What**: AI-powered cover letter generation
**Where**: `src/services/coverLetterService.js`
**Input**: SYSTEM_DESIGN.md Cover Letter APIs, API Contract CL APIs
**Steps**:
1. `generateCoverLetter(jobId, resumeId, language)`:
   - Fetch job (JD) and primary resume (parsed data)
   - Build prompt: role context + JD highlights + resume highlights + gap analysis + language instruction
   - Call OpenAI chat API
   - Format: 3-5 paragraphs, < 400 chars (zh) or < 400 words (en)
2. `buildPrompt(job, resume, language)`:
   - System prompt: "You are a professional Australian job application writer"
   - User prompt: template with JD, resume data, gap points, language
3. Save to `cover_letters` table
4. `getHistory(jobId)`: return all CLs for job
**Output**: coverLetterService.js
**Verify**: `node -e "require('./src/services/coverLetterService'); console.log(typeof generateCoverLetter)"`
**Depends on**: WBS 1.5, 2.1, 4.1
**Complexity**: M

---

### WBS 5.1: Resume API Routes
**What**: Resume CRUD API endpoints
**Where**: `src/routes/apiResumes.js`
**Input**: SYSTEM_DESIGN.md API Contract (Resume APIs), WBS 2.1
**Steps**:
1. `POST /api/resumes/upload`:
   - Use multer: save to `data/uploads/`, allow .docx/.pdf, max 5MB
   - Call `parseResume()` 
   - Insert to `resumes` table
   - If first resume: auto-set as primary
   - Return: `{ id, name, parsed_data }`
2. `GET /api/resumes`:
   - SELECT all resumes (don't return file_path)
   - Include parsed_data
3. `PUT /api/resumes/:id/primary`:
   - BEGIN transaction
   - UPDATE all resumes SET is_primary=0
   - UPDATE target SET is_primary=1
   - COMMIT
4. `DELETE /api/resumes/:id`:
   - Delete file from disk
   - DELETE from DB (CASCADE)
**Output**: apiResumes.js
**Verify**: `curl -X POST -F "file=@test.docx" http://localhost:3001/api/resumes/upload`
**Depends on**: WBS 2.1, 1.4, 1.3
**Complexity**: M

---

### WBS 5.2: Job API Routes
**What**: Job list, detail, status API endpoints
**Where**: `src/routes/apiJobs.js`
**Input**: SYSTEM_DESIGN.md API Contract (Job APIs)
**Steps**:
1. `GET /api/jobs`:
   - Build query from URL params: source, minScore, maxScore, keyword, status, page, limit
   - JOIN with matches (latest per job) and sources
   - ORDER BY match total_score DESC (or created_at DESC if no match)
   - Paginate: `LIMIT ? OFFSET ?`
   - Return: `{ jobs: [], total, page, limit }`
2. `GET /api/jobs/:id`:
   - Fetch job + match + cover_letters + job_status
   - Include source label
3. `PUT /api/jobs/:id/status`:
   - INSERT OR REPLACE into job_status
   - Log action
4. `GET /api/jobs/companies`:
   - GROUP BY company, COUNT(*), MAX(created_at)
**Output**: apiJobs.js
**Verify**: `curl http://localhost:3001/api/jobs`
**Depends on**: WBS 1.3, 1.4
**Complexity**: M

---

### WBS 5.3: Scrape API Routes
**What**: Scrape trigger and SSE progress endpoints
**Where**: `src/routes/apiScrape.js`
**Input**: SYSTEM_DESIGN.md API Contract (Scrape APIs), WBS 2.2
**Steps**:
1. `POST /api/scrape/run`:
   - Validate source (seek/linkedin/apsjobs), keywords, maxPages
   - INSERT into scrape_history
   - Call `runScraper()` (non-blocking)
   - Return: `{ history_id, status: 'started' }`
2. `GET /api/scrape/progress/:historyId`:
   - Call `getProgressStream(historyId, req, res)`
3. `GET /api/scrape/history`:
   - SELECT from scrape_history ORDER BY started_at DESC LIMIT 50
4. `GET /api/scrape/sources`:
   - SELECT from sources WHERE active=1
**Output**: apiScrape.js
**Verify**: `curl -X POST -H "Content-Type: application/json" -d '{"source":"seek","keywords":"AI","maxPages":1}' http://localhost:3001/api/scrape/run`
**Depends on**: WBS 2.2, 1.4
**Complexity**: M

---

### WBS 5.4: Match API Routes
**What**: Matching trigger and results API
**Where**: `src/routes/apiMatch.js`
**Input**: SYSTEM_DESIGN.md API Contract (Match APIs), WBS 4.1
**Steps**:
1. `POST /api/match/run`:
   - If jobIds provided: filter to those IDs
   - Else: find all jobs without a match for the primary resume
   - Call `batchMatch()`
   - Return: `{ matched: N, skipped: M }`
2. `GET /api/match/:jobId`:
   - SELECT match for job + primary resume
   - Return: `{ total_score, skill_score, semantic_score, keyword_score, gap_analysis }`
   - If no match: return 404
**Output**: apiMatch.js
**Verify**: `curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3001/api/match/run`
**Depends on**: WBS 4.1, 1.4
**Complexity**: S

---

### WBS 5.5: Cover Letter API Routes
**What**: CL generation and history API
**Where**: `src/routes/apiCoverLetter.js`
**Input**: SYSTEM_DESIGN.md API Contract (CL APIs), WBS 4.2
**Steps**:
1. `POST /api/cover-letters/generate`:
   - Validate: job_id, resume_id, language
   - Check primary resume exists
   - Call `generateCoverLetter()`
   - Return: `{ id, content, language }`
2. `GET /api/cover-letters/:jobId`:
   - SELECT all CLs for job
3. `DELETE /api/cover-letters/:id`:
   - DELETE from DB
**Output**: apiCoverLetter.js
**Depends on**: WBS 4.2, 1.4
**Complexity**: S

---

### WBS 5.6: Admin API Routes
**What**: Admin stats, logs, config API
**Where**: `src/routes/apiAdmin.js`
**Input**: SYSTEM_DESIGN.md API Contract (Admin APIs)
**Steps**:
1. `GET /api/admin/stats`:
   - COUNT(*) from jobs, resumes, matches, cover_letters
   - GROUP BY source for job distribution
2. `GET /api/admin/logs`:
   - SELECT from operation_logs ORDER BY created_at DESC LIMIT ?
   - Filter by level if provided
3. `PUT /api/admin/config`:
   - Update .env file with new values (write to .env, don't store in DB)
   - Or: update config table (simpler)
   - Validate base URL format
4. `GET /api/admin/config/public`:
   - Return base_url only (never API key)
**Output**: apiAdmin.js
**Depends on**: WBS 1.3, 1.4, 1.5
**Complexity**: S

---

### WBS 6.1: EJS Views & Templates
**What**: All EJS page templates and partials
**Where**: `views/`, `views/partials/`, `views/jobs/`, `views/resumes/`, `views/admin/`
**Input**: DESIGN.md Page Layouts, Component Tree
**Steps**:
1. `views/layout.ejs`: base HTML, CSS links, header/footer partials, body
2. `views/partials/header.ejs`: nav with active state, settings icon
3. `views/partials/footer.ejs`: copyright, version
4. `views/partials/job-card.ejs`: reusable job card with score badge
5. `views/home.ejs`: dashboard with stats, quick actions, recent jobs, source stats
6. `views/jobs/list.ejs`: filter sidebar + job list + pagination
7. `views/jobs/detail.ejs`: two-column layout (JD + match panel)
8. `views/resumes/list.ejs`: upload zone + resume cards
9. `views/admin/dashboard.ejs`: stats grid + log viewer + config form
10. All pages must set `lang` based on `?lang=` param
**Output**: All .ejs files
**Verify**: All pages render without EJS errors
**Depends on**: WBS 5.x, 7.1
**Complexity**: M

---

### WBS 6.2: CSS & JS Assets
**What**: All CSS styles and JavaScript interactions
**Where**: `public/css/`, `public/js/`
**Input**: DESIGN.md Design Tokens, Interaction States
**Steps**:
1. `public/css/main.css`:
   - CSS custom properties (colors, typography, spacing)
   - CSS reset
   - Global styles (body, links, scrollbar)
2. `public/css/components.css`:
   - .card, .btn, .badge, .form-* components
   - Score badge variants (green/yellow/red)
   - Progress bar
   - Hover effects
3. `public/css/pages/home.css`: welcome card, quick actions grid
4. `public/css/pages/jobs.css`: filter sidebar, job list layout, detail page
5. `public/css/pages/admin.css`: stats grid, log viewer
6. `public/js/main.js`: global utilities (API helper, toast, i18n toggle)
7. `public/js/scrape.js`: EventSource for SSE progress, progress bar update
8. `public/js/jobs.js`: filter form submit, pagination, status update
9. `public/js/resume.js`: drag-drop upload, file type validation
10. `public/js/cover-letter.js`: generate button, copy to clipboard, download
11. `public/js/admin.js`: log filtering, config form
**Output**: All CSS and JS files
**Verify**: `ls public/css/*.css public/js/*.js` shows all files
**Depends on**: WBS 6.1
**Complexity**: M

---

### WBS 7.1: Express Server Entry Point
**What**: Wire everything together in server.js
**Where**: `src/server.js`
**Input**: All routes and services, WBS 5.x
**Steps**:
1. Load dotenv
2. Initialize database (WBS 2.3)
3. Check Python availability
4. Create Express app:
   - `app.use(express.json())`
   - `app.use(express.urlencoded({ extended: true }))`
   - `app.use(cookieParser())`
   - `app.use(express.static('public'))`
   - Mount all route files
   - Mount error handler
5. Check admin token config
6. Start listening on PORT
7. Log startup complete
**Output**: server.js
**Verify**: `node src/server.js` starts without errors
**Depends on**: WBS 5.1-5.6, 6.1, 2.3
**Complexity**: S

---

### WBS 7.2: Page Routes
**What**: EJS page rendering routes
**Where**: `src/routes/index.js`
**Input**: DESIGN.md Page Layouts, WBS 6.1
**Steps**:
1. `GET /`: render home.ejs with stats (job count, match count, recent jobs)
2. `GET /jobs`: render job list, pass filter params to template
3. `GET /jobs/:id`: render job detail, fetch job + match + CL + status
4. `GET /resumes`: render resume list
5. `GET /scrape`: render scrape page with history
6. `GET /admin`: check admin token, render admin dashboard
7. All routes: inject `lang` param into res.locals for EJS
**Output**: index.js
**Verify**: All pages render in browser
**Depends on**: WBS 5.x, 6.1
**Complexity**: S

---

### WBS 7.3: Integration & Final Check
**What**: End-to-end integration test, fix any issues
**Where**: Throughout
**Input**: PLAN_OUTPUT.md Test Matrix (T1-T25)
**Steps**:
1. Start server: `npm start`
2. Test all T1-T25 test cases
3. Fix any issues found
4. Verify: landing page, upload resume, scrape jobs, view list, analyze match, generate CL, admin stats
5. Check all pages render without console errors
6. Test responsive layout at 375px, 768px, 1280px
**Output**: Working application
**Verify**: All 25 test cases pass
**Depends on**: WBS 7.1, 7.2, 6.2
**Complexity**: L

---

## Traceability Matrix

| VISION Feature | API | Component | WBS |
|----------------|-----|-----------|-----|
| Job Scraping | apiScrape | ScrapePage | 3.1-3.4, 2.2, 5.3, 6.1 |
| Resume Management | apiResumes | ResumeListPage | 2.1, 5.1, 6.1 |
| AI Matching | apiMatch | JobDetail MatchPanel | 4.1, 5.4, 6.1 |
| Cover Letter | apiCoverLetter | CLSection | 4.2, 5.5, 6.1 |
| Job Browsing | apiJobs | JobListPage, JobDetailPage | 5.2, 6.1 |
| Admin Panel | apiAdmin | AdminDashboard | 1.4, 5.6, 6.1 |
| Bilingual | — | All templates | 6.1 |
| Progress SSE | apiScrape | ScrapePage | 2.2, 5.3, 6.2 |
