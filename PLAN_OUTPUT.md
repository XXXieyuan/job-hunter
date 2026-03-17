# IMPLEMENTATION_PLAN - job-hunter v2 (Enhanced)

## 0. Overview

**Project:** job-hunter - Job scraping and resume matching platform
**Frontend:** React + Vite + TypeScript
**Backend:** Express + SQLite
**Goal:** Multi-user job platform with global jobs, user-specific resumes, and AI-powered matching

---

## 1. Data Model

### 1.1 Jobs (Global - Shared by All Users)

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,              -- Deduplication key
  external_id TEXT,                       -- Source-specific ID (optional)
  source TEXT,                            -- 'apsjobs', 'greenhouse', 'lever', etc.
  scrape_batch_id TEXT,                   -- UUID to group jobs by scrape run
  title TEXT NOT NULL,
  company_name TEXT,
  location TEXT,
  salary TEXT,
  description TEXT,
  skills_json TEXT,                       -- Extracted: {required: [], nice_to_have: []}
  requirements_json TEXT,
  is_active INTEGER DEFAULT 1,            -- 1 = active, 0 = expired
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE INDEX idx_jobs_url ON jobs(url);
CREATE INDEX idx_jobs_source ON jobs(source);
CREATE INDEX idx_jobs_is_active ON jobs(is_active);
```

### 1.2 Users

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1.3 Resumes (User-Specific)

```sql
CREATE TABLE resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT,
  file_path TEXT,
  raw_text TEXT,
  skills_json TEXT,                       -- Extracted: {skills: [], domains: [], seniority: ''}
  metadata_json TEXT,                     -- {original_filename, file_size}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE INDEX idx_resumes_user ON resumes(user_id);
```

### 1.4 Embeddings

```sql
-- Job embeddings (computed once, reused for all users)
CREATE TABLE job_embeddings (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
  embedding BLOB NOT NULL,                -- Serialized float32 array
  model TEXT DEFAULT 'text-embedding-3-small',
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Resume embeddings (per-user)
CREATE TABLE resume_embeddings (
  resume_id INTEGER PRIMARY KEY REFERENCES resumes(id),
  embedding BLOB NOT NULL,
  model TEXT DEFAULT 'text-embedding-3-small',
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1.5 Matches (User-Specific)

```sql
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  resume_id INTEGER NOT NULL REFERENCES resumes(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  similarity_score REAL,                  -- Embedding cosine similarity
  skill_score REAL,                       -- Skill overlap score
  overall_score REAL,                     -- 0.6 * similarity + 0.4 * skill_score
  explanation_json TEXT,                  -- {matched_skills: [], missing_skills: [], highlights: []}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, resume_id, job_id)
);

CREATE INDEX idx_matches_user_resume ON matches(user_id, resume_id);
```

---

## 2. API Endpoints

### 2.1 Scraper APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/scrape/run | Trigger scraper, returns `{scrape_id}` |
| GET | /api/scrape/status/:id | Get scraper status for polling |
| GET | /api/scrape/history | List recent scrape runs |

**Status Response:**
```json
{
  "id": "SCRAPE_UUID",
  "status": "queued|running|completed|failed",
  "progress": {
    "total": 15,
    "current": 3,
    "message": "Processing job 3 of 15: Senior Data Engineer"
  },
  "jobs_added": 12,
  "error": null
}
```

### 2.2 Jobs APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/jobs | List global jobs with filters + pagination |
| GET | /api/jobs/:id | Get job details |
| GET | /api/jobs/export?format=csv\|json | Export jobs |

**Query Params:**
- `page` (default 1)
- `pageSize` (default 20, max 100)
- `search` (full-text on title/description/company)
- `location`
- `source`
- `is_active` (1/0)
- `sort` (recent, title, company)

### 2.3 Resume APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/resumes/upload | Upload DOCX resume (multipart/form-data) |
| GET | /api/resumes | List user's resumes |
| DELETE | /api/resumes/:id | Delete resume |

**Upload Response:**
```json
{
  "id": 5,
  "name": "General",
  "created_at": "...",
  "skills": ["Python", "SQL", "AWS"],
  "domains": ["data engineering"],
  "seniority": "mid",
  "raw_text_preview": "First 300 chars..."
}
```

### 2.4 Match APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/match | Match resume to jobs |
| GET | /api/match/history | Get user's match history |

**Match Request:**
```json
{ "resume_id": 5, "limit": 50 }
```

**Match Response:**
```json
{
  "resume_id": 5,
  "matches": [
    {
      "job_id": 123,
      "overall_score": 0.84,
      "similarity_score": 0.88,
      "skill_score": 0.78,
      "job": { "title": "Senior Data Engineer", "company_name": "Example Corp", "location": "Remote", "source": "apsjobs" },
      "explanation": {
        "matched_skills": ["Python", "SQL", "Airflow"],
        "missing_skills": ["Kubernetes"],
        "highlights": ["5+ years data eng", "Experience with ETL pipelines"]
      }
    }
  ]
}
```

---

## 3. Frontend (React + Vite + TypeScript)

### 3.1 Project Structure

```
frontend/
  src/
    main.tsx
    App.tsx
    router.tsx
    api/
      http.ts           # Base fetch wrapper
      scrape.ts
      jobs.ts
      resumes.ts
      match.ts
    pages/
      JobsPage/
      ScraperPage/
      ResumesPage/
      MatchPage/
    components/
      jobs/            # JobCard, JobList, JobFilters
      scraper/         # ScraperControls, ScraperProgress, ScrapeHistory
      resumes/         # ResumeUploader, ResumeList
      match/           # MatchControls, MatchResults, MatchCard
      layout/          # AppLayout, Sidebar, TopBar
    styles/
      globals.css
      theme.css
```

### 3.2 Pages & Features

#### JobsPage (/jobs)
- Global job listing with filters (search, location, source, is_active)
- Pagination controls
- JobCard: title, company, location, source, is_active badge
- Expandable description + skills

#### ScraperPage (/scraper)
- "Run Scraper" button
- Polling progress display (3s interval, 10min timeout)
- Progress messages: "Searching...", "Found X jobs", "Processing job X of Y: [Title]"
- History table

#### ResumesPage (/resumes)
- DOCX upload (drag & drop, 5MB limit)
- Resume list with skills chips
- Delete with confirmation

#### MatchPage (/match)
- Resume selector dropdown
- "Run Matching" button
- MatchResults sorted by score
- MatchCard: score bar, matched/missing skills chips

---

## 4. Scraper Implementation

### 4.1 Polling Flow

```
1. User clicks "Run Scraper"
2. POST /api/scrape/run → returns {scrape_id, status: 'running'}
3. UI starts polling GET /api/scrape/status/:scrape_id every 3s
4. Status response: {status, progress: {total, current, message}, jobs_added}
5. When status === 'completed' || 'failed', stop polling
```

### 4.2 Polling Specs
- **Interval:** 3000ms
- **Max Duration:** 10 minutes
- **Timeout handling:** Show "Scrape timed out. Check logs."
- **Error handling:** Show non-blocking banner, keep polling

### 4.3 Deduplication
- Normalize URL: trim, lowercase
- Check `SELECT * FROM jobs WHERE url = ?`
- If exists: update fields, `last_seen_at = NOW()`, `is_active = 1`
- If new: insert with `scrape_batch_id`

### 4.4 Progress Events (Enhanced for APS)

```
[PROGRESS] {"type":"searching","message":"Scraping APSJobs... | filters: APS5-APS6, EL1 | locations: ACT+NSW","count":0}
[PROGRESS] {"type":"department","department":"Department of Health and Aged Care","count":15}
[PROGRESS] {"type":"processing","current":1,"total":15,"title":"EL1 Assistant Director","department":"Health and Aged Care","location":"Canberra ACT","salary":"$120k-$135k","closing":"22 Mar 2026"}
[PROGRESS] {"type":"department_done","department":"Health and Aged Care","total":15,"breakdown":"5x APS5, 7x APS6, 3x EL1"}
[PROGRESS] {"type":"checkpoint","current":70,"total":200,"departments":18,"locations":33}
[PROGRESS] {"type":"completed","jobs_added":200,"departments":32,"by_classification":"34x APS4, 62x APS5, 58x APS6, 32x EL1, 10x EL2, 4x SES"}
[PROGRESS] {"type":"error","message":"Network error"}
```

### 4.5 Enhanced Progress Messages (APS-Specific)

For APS jobs, show richer context including department, classification, location, and salary.

**Available APS Fields:**
| Category | Fields |
|----------|--------|
| Core | Title, Department/Agency |
| Classification | APS level (APS4, APS5, APS6, EL1, EL2, SES) |
| Compensation | Salary range |
| Location | City/State (ACT, NSW, VIC, etc.) |
| Metadata | Reference number, Closing date |

**Progress Message Types:**

| Stage | Message Example |
|-------|-----------------|
| Startup | `🔍 Scraping APSJobs... \| filters: APS5-APS6, EL1 \| locations: ACT+NSW` |
| Discovery | `📋 Department of Health and Aged Care: 15 roles detected (ACT, Canberra, Sydney)` |
| Processing | `[05/15] APS6 Senior Data Analyst \| Canberra ACT \| $96k-$108k \| closes 04 Apr` |
| Department Done | `✅ Done: Health and Aged Care \| 15 roles \| 5x APS5, 7x APS6, 3x EL1` |
| Checkpoint | `Checkpoint: 100/200 jobs \| 18 departments \| 33 locations` |
| Complete | `🎉 Complete: 200 jobs from 32 departments \| Top: Services Australia (19), Home Affairs (12)` |

**ASCII UI Mockup:**

```
+======================================================================+
|  🕷️ APSJobs Scraper                                                 |
+======================================================================+
|  Filters: Classification=APS5-APS6 | Location=ACT,NSW | Live only   |
+----------------------------------------------------------------------+
|  📊 Progress                                                         |
|  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  35%  (70/200 jobs)    |
+----------------------------------------------------------------------+
|  Current: Department of Health and Aged Care (job 4 of 11)          |
+----------------------------------------------------------------------+
|  [04/11] EL1 Assistant Director | Data Strategy                     |
|         | Canberra ACT | $120k-$135k | closes 22 Mar 2026          |
+----------------------------------------------------------------------+
|  Recent:                                                              |
|  [03/11] APS6 Data Analyst | Services Australia                     |
|         | Parramatta NSW | $96k-$108k | closes 04 Apr 2026         |
|  [02/11] APS5 Policy Officer | Services Australia                    |
|         | Canberra ACT | $82k-$90k | closes 29 Mar 2026           |
+----------------------------------------------------------------------+
|  Summary: 70 jobs | 12 departments | 8 locations                  |
+======================================================================+
```

**Alternative Compact Log Style:**

```
APSJobs scrape started | filters: APS5-APS6, EL1 | locations=ACT+NSW | live vacancies only

Dept: Services Australia | 19 roles detected (ACT, NSW, VIC)
[01/19] Services Australia | APS5 Policy Officer        | Parramatta NSW | $82k–$90k | closes 29 Mar 2026
[02/19] Services Australia | APS6 Senior Policy Officer | Canberra ACT   | $96k–$108k | closes 04 Apr 2026
...
Done: Services Australia | 19 roles | 6x APS5, 8x APS6, 5x EL1 | salary range $80k–$135k

Checkpoint: 100/200 jobs scraped | 18 departments | 33 locations

Complete: 200 jobs scraped from 32 departments across 43 locations
By classification: 34x APS4, 62x APS5, 58x APS6, 32x EL1, 10x EL2, 4x SES
Top departments: Services Australia (19), Home Affairs (12), Health and Aged Care (11)
```

---

## 5. Matching Algorithm

### 5.1 Pipeline

```
1. Upload DOCX → mammoth.extractRawText → raw_text
2. AI extract skills → skills_json
3. Compute resume embedding (text-embedding-3-small) → resume_embeddings
4. For each active job:
   a. Get/compute job embedding
   b. Cosine similarity → similarity_score
   c. Skill overlap (Jaccard) → skill_score
   d. overall = 0.6 × similarity + 0.4 × skill
5. Sort by overall_score DESC, return top N
```

### 5.2 Skill Score Calculation

```js
// Resume skills: R = set(resumeSkills)
// Job required: J_req = set(required)
// Job nice-to-have: J_nice = set(nice_to_have)

intersectionRequired = |R ∩ J_req|
intersectionNice = |R ∩ J_nice|

numerator = 1.0 * intersectionRequired + 0.5 * intersectionNice
denominator = |J_req| + 0.5 * |J_nice|

skill_score = denominator > 0 ? numerator / denominator : 0
```

### 5.3 Skill Extraction Prompts

**Resume Skills:**
```json
{
  "skills": ["python", "sql", "airflow"],
  "domains": ["data engineering", "fintech"],
  "seniority": "mid"
}
```

**Job Skills:**
```json
{
  "required": ["python", "sql"],
  "nice_to_have": ["kubernetes", "docker"]
}
```

---

## 6. DOCX Validation

### 6.1 Frontend
```tsx
<input
  type="file"
  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
/>
// Validate: extension .docx, MIME type, max 5MB
```

### 6.2 Backend
- Multer for multipart
- Validate MIME: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Validate extension: `.docx`
- Store in `data/resumes/`
- Use mammoth for text extraction

---

## 7. Vite Config

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  }
});
```

---

## 8. Visual/UX Specs

### 8.1 Layout
- Fixed left sidebar: Jobs, Scraper, Resumes, Match
- Top bar: App title "Job Hunter", placeholder user indicator
- Content area: max-width 1200px, centered

### 8.2 Styling
- Background: #f5f5f7
- Card: #ffffff
- Primary: #2563eb (blue)
- Status: green (completed), orange (running), red (failed)

### 8.3 Components
- JobCard: compact, source badge, expand for details
- ScraperProgress: progress bar + status message
- ResumeUploader: dropzone with "Only .docx up to 5MB"
- MatchCard: score bar, matched/missing skill chips

---

## 9. File Changes

### New Files
| File | Description |
|------|-------------|
| `frontend/` | React + Vite + TS project |
| `frontend/vite.config.ts` | Vite proxy config |
| `frontend/src/api/*.ts` | API clients |
| `frontend/src/pages/*/` | Page components |
| `frontend/src/components/*/` | UI components |
| `src/routes/apiScrapeRoutes.js` | Scraper APIs |
| `src/routes/apiJobsRoutes.js` | Job APIs |
| `src/routes/apiResumeRoutes.js` | Resume APIs |
| `src/routes/apiMatchRoutes.js` | Match APIs |
| `src/services/matchingService.js` | Matching logic |
| `src/services/embeddingService.js` | Embedding computation |
| `src/services/skillExtractionService.js` | AI skill extraction |
| `src/db/migrations/004_global_jobs.sql` | Jobs schema |
| `src/db/migrations/005_embeddings.sql` | Embedding tables |
| `src/db/migrations/006_matches.sql` | Matches table |

### Modified Files
| File | Changes |
|------|---------|
| `src/scrapers/apsjobsScraper.js` | Progress output, URL dedup |
| `src/services/scraperService.js` | Parse progress, status endpoint |
| `src/repositories/jobsRepo.js` | Global queries, update-by-url |
| `src/repositories/resumesRepo.js` | CRUD for resumes |
| `src/repositories/embeddingsRepo.js` | Embedding storage |
| `src/repositories/matchesRepo.js` | Match storage |
| `src/app.js` / `src/server.js` | Wire new routes |
| `package.json` | Add mammoth, react, vite |

---

## 10. Test Plan

### 10.1 Unit Tests
- computeSkillScore: Jaccard logic, edge cases
- computeOverallScore: 0.6 + 0.4 formula
- Vector normalization, cosine similarity
- DOCX validation

### 10.2 Integration Tests
- POST /api/resumes/upload (valid DOCX, invalid rejected)
- POST /api/match (sorted results)
- POST /api/scrape/run + GET /api/scrape/status (polling)
- GET /api/jobs (filters + pagination)

### 10.3 Manual Flows
1. Upload DOCX → see skills
2. Run scraper → watch progress
3. Match resume → view scored jobs

---

## 11. V1 Scope

- [x] React frontend (Vite + TS)
- [x] Scraper with polling UI
- [x] Global jobs (url dedup)
- [x] DOCX resume upload
- [x] Embedding + skill-based matching
- [x] Progress messages
- [ ] Auth (TODO - hardcode user_id=1)
