# TEST_PLAN.md – job-hunter v2

## 1. Scope

Testing implemented features:
- API Routes: /api/scrape/*, /api/jobs/*, /api/resumes/*, /api/match
- Scraper progress tracking
- React frontend (manual verification)

---

## 2. Test Cases

### 2.1 POST /api/scrape/run

| # | Test | Expected |
|---|------|----------|
| 1 | Basic trigger | 200 OK, {scrape_id, status: "queued"/"running"} |
| 2 | Invalid payload | 400 Bad Request |

### 2.2 GET /api/scrape/status/:id

| # | Test | Expected |
|---|------|----------|
| 1 | Running job | 200, status + progress JSON |
| 2 | Completed job | 200, status="completed", jobs_added > 0 |
| 3 | Nonexistent ID | 404 Not Found |

### 2.3 GET /api/scrape/history

| # | Test | Expected |
|---|------|----------|
| 1 | Multiple runs | 200, array of runs |
| 2 | Empty | 200, [] |

### 2.4 GET /api/jobs

| # | Test | Expected |
|---|------|----------|
| 1 | List jobs | 200, jobs array with pagination |
| 2 | With filters | 200, filtered results |
| 3 | Empty | 200, [] |

### 2.5 GET /api/jobs/:id

| # | Test | Expected |
|---|------|----------|
| 1 | Existing job | 200, job details |
| 2 | Nonexistent | 404 |

### 2.6 GET /api/jobs/export

| # | Test | Expected |
|---|------|----------|
| 1 | CSV format | 200, text/csv, download |
| 2 | JSON format | 200, application/json |

### 2.7 GET /api/resumes

| # | Test | Expected |
|---|------|----------|
| 1 | List resumes | 200, resumes array |
| 2 | Empty | 200, [] |

### 2.8 POST /api/resumes/upload

| # | Test | Expected |
|---|------|----------|
| 1 | Valid DOCX | 201, resume details |
| 2 | No file | 400 |
| 3 | Invalid type | 400/415 |

### 2.9 DELETE /api/resumes/:id

| # | Test | Expected |
|---|------|----------|
| 1 | Delete resume | 200, {success: true} |
| 2 | Nonexistent | 404 |

### 2.10 POST /api/match

| # | Test | Expected |
|---|------|----------|
| 1 | Match resume to jobs | 200, matches array with scores |
| 2 | Invalid resume_id | 400/404 |

---

## 3. Execution

### Start Server
```bash
cd /home/node/.openclaw/workspace/job-hunter
npm run dev &
```

### Run Tests (curl)
```bash
# Test scraper run
curl -X POST http://localhost:3000/api/scrape/run
curl http://localhost:3000/api/scrape/status/1
curl http://localhost:3000/api/scrape/history

# Test jobs
curl http://localhost:3000/api/jobs
curl http://localhost:3000/api/jobs/1
curl http://localhost:3000/api/jobs/export?format=json

# Test resumes
curl http://localhost:3000/api/resumes

# Test match
curl -X POST http://localhost:3000/api/match -H "Content-Type: application/json" -d '{"resume_id":1}'
```

---

## 4. Manual UI Tests

1. Scraper page: Run scraper, verify polling progress
2. Jobs page: List, filter, export
3. Resumes page: Upload DOCX
4. Match page: Match resume to jobs
