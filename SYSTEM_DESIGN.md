# System Design

## 1. Tech Stack & Justification

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 20 LTS | 兼容性好，v1 积累，better-sqlite3 支持 |
| Framework | Express.js | 轻量、成熟、中间件丰富 |
| Database | SQLite (better-sqlite3) | 零配置、文件持久、无需额外进程 |
| Frontend | EJS SSR + vanilla JS | 轻量 SPA 体验，无需构建工具，首屏快 |
| Styling | Custom CSS (CSS Variables) | 设计师友好，Andy 喜欢花哨效果 |
| Scraper Runtime | Python 3 + Playwright | v1 积累，可复用，稳定 |
| AI API | OpenAI SDK (兼容自定义 base URL) | 支持任意 OpenAI 兼容 API |
| File Parsing | mammoth (docx) + pdf-parse (pdf) | Node.js 原生，无需外部依赖 |
| Real-time | Server-Sent Events (SSE) | 轻量推送进度，无需 WebSocket |
| i18n | URL param `?lang=en` + EJS template | 无需 i18n 库，纯模板切换 |

**Alternatives considered and rejected:**
- PostgreSQL → too heavy for self-hosted single user
- React/Vue SPA → 构建复杂，对单用户 app 过度工程
- Puppeteer (Node.js scraper) → Python Playwright 更稳定
- WebSocket → SSE 更简单够用

---

## 2. Data Model

```sql
-- 简历表
CREATE TABLE resumes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  file_type   TEXT NOT NULL,  -- 'docx' | 'pdf'
  parsed_data TEXT NOT NULL,   -- JSON: {skills, experience, education, name}
  is_primary  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- 职位来源表
CREATE TABLE sources (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,  -- 'seek' | 'linkedin' | 'apsjobs'
  label  TEXT NOT NULL,         -- 'SEEK' | 'LinkedIn' | 'APSJobs'
  active INTEGER DEFAULT 1
);

-- 职位表
CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER REFERENCES sources(id),
  external_id     TEXT NOT NULL,          -- 原始网站职位ID
  title           TEXT NOT NULL,
  company         TEXT,
  location        TEXT,
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_currency TEXT DEFAULT 'AUD',
  job_description TEXT NOT NULL,          -- 完整JD文本
  job_url         TEXT NOT NULL,
  posted_date     TEXT,
  classification  TEXT,                    -- APSJobs 专用
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, external_id)
);

-- 匹配分析表
CREATE TABLE matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id      INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
  total_score    REAL NOT NULL,            -- 0-100
  skill_score    REAL,
  semantic_score REAL,
  keyword_score  REAL,
  gap_analysis   TEXT,                     -- JSON: missing/skewed keywords
  analyzed_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, resume_id)
);

-- Cover Letter 表
CREATE TABLE cover_letters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id  INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'en',  -- 'en' | 'zh'
  created_at TEXT DEFAULT (datetime('now'))
);

-- 职位状态表
CREATE TABLE job_status (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id   INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  status   TEXT NOT NULL DEFAULT 'unread',  -- 'unread'|'read'|'applied'|'not_interested'
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id)
);

-- 抓取历史表
CREATE TABLE scrape_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER REFERENCES sources(id),
  keywords    TEXT,
  pages       INTEGER,
  jobs_found  INTEGER,
  status      TEXT NOT NULL,  -- 'success'|'error'|'partial'
  error_msg   TEXT,
  started_at  TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 系统配置表
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 操作日志表
CREATE TABLE operation_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL,  -- 'info'|'warn'|'error'
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_jobs_source ON jobs(source_id);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_matches_job ON matches(job_id);
CREATE INDEX idx_matches_resume ON matches(resume_id);
CREATE INDEX idx_matches_score ON matches(total_score DESC);
CREATE INDEX idx_cl_job ON cover_letters(job_id);
CREATE INDEX idx_cl_resume ON cover_letters(resume_id);
CREATE INDEX idx_scrape_history_source ON scrape_history(source_id);
CREATE INDEX idx_scrape_history_started ON scrape_history(started_at DESC);
```

---

## 3. API Contract

### Resume APIs
```
POST   /api/resumes/upload
  → multipart/form-data: { file }
  ← { id, name, parsed_data: {skills, experience, education, name} }

GET    /api/resumes
  ← [{ id, name, is_primary, created_at, parsed_data }]

PUT    /api/resumes/:id/primary
  ← { success: true }

DELETE /api/resumes/:id
  ← { success: true }
```

### Job APIs
```
GET    /api/jobs?source=&minScore=&maxScore=&keyword=&status=&page=&limit=
  ← { jobs: [...], total, page, limit }

GET    /api/jobs/:id
  ← { job, match, cover_letters, status }

PUT    /api/jobs/:id/status
  → { status }
  ← { success: true }

GET    /api/jobs/companies
  ← [{ company, count, latest_job_date }]
```

### Scrape APIs
```
POST   /api/scrape/run
  → { source: 'seek'|'linkedin'|'apsjobs', keywords: string, maxPages: number }
  ← { history_id, status: 'started' }

GET    /api/scrape/progress/:historyId
  ← text/event-stream (SSE)
     data: {"type":"progress","page":3,"jobsFound":47,"totalPages":10}
     data: {"type":"done","jobsFound":120,"duration":"45s"}
     data: {"type":"error","message":"..."}

GET    /api/scrape/history
  ← [{ id, source, keywords, jobs_found, status, started_at, finished_at }]

GET    /api/scrape/sources
  ← [{ id, name, label, active }]
```

### Match APIs
```
POST   /api/match/run
  → { jobIds?: number[] }   // 空数组或不传 = 全部未分析职位
  ← { matched: N, skipped: M }

GET    /api/match/:jobId
  ← { total_score, skill_score, semantic_score, keyword_score, gap_analysis }
```

### Cover Letter APIs
```
POST   /api/cover-letters/generate
  → { job_id, resume_id, language: 'en'|'zh' }
  ← { id, content, language }

GET    /api/cover-letters/:jobId
  ← [{ id, content, language, created_at }]

DELETE /api/cover-letters/:id
  ← { success: true }
```

### Admin APIs
```
GET    /api/admin/stats
  ← { jobs_total, resumes_total, matched_total, cl_total, by_source: {} }

GET    /api/admin/logs?level=&limit=
  ← [{ id, level, action, detail, created_at }]

PUT    /api/admin/config
  → { openai_base_url, openai_api_key }  // stored in env/config, not here for security
  ← { success: true }

GET    /api/admin/config/public
  ← { openai_base_url }  // never returns api_key
```

### Error Response Format
```json
{
  "error": true,
  "code": "RESUME_NOT_FOUND",
  "message": "Resume with id 99 not found"
}
```

Error codes: `VALIDATION_ERROR`, `NOT_FOUND`, `SCRAPE_ERROR`, `MATCH_ERROR`, `CL_ERROR`, `AUTH_ERROR`, `SERVER_ERROR`

---

## 4. Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Browser (EJS SSR)                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  │
│  │ Landing │  │Dashboard│  │ Job List │  │Job Detail│  │  Admin   │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘  │
└───────┼────────────┼────────────┼────────────┼────────────┼────────┘
        │            │            │            │            │
        └────────────┴────────────┴────────────┴────────────┘
                              │ HTTP / SSE
┌─────────────────────────────┴───────────────────────────────────────┐
│                      Express.js (Main Server :3001)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  Routes  │  │ Controllers│ │ Services │  │   DB    │  │  SSE   │ │
│  │ /api/*   │  │ (biz logic)│ │(scraper, │  │(better- │  │Handler │ │
│  │ /admin/* │  │           │  │ match,   │  │ sqlite3)│  │        │ │
│  │ /        │  │           │  │  cl gen) │  │         │  │        │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
└─────────────────────────────────────────────────────────────────────┘
        │                              │
        │ fork()                       │
        ▼                              ▼
┌───────────────────┐       ┌────────────────────────┐
│ Python Scraper    │       │ OpenAI Compatible API   │
│ (Playwright/      │       │ (user-configured        │
│  Requests)        │       │  base_url)              │
│ - seek.py         │       └────────────────────────┘
│ - linkedin.py     │
│ - apsjobs.py      │
└───────────────────┘
```

### File Structure
```
job-hunter/
├── src/
│   ├── server.js              # Express 入口
│   ├── db/
│   │   ├── database.js         # SQLite 初始化 + migrations
│   │   └── schema.sql
│   ├── routes/
│   │   ├── index.js            # 页面路由 (EJS)
│   │   ├── apiJobs.js
│   │   ├── apiResumes.js
│   │   ├── apiScrape.js
│   │   ├── apiMatch.js
│   │   ├── apiCoverLetter.js
│   │   └── apiAdmin.js
│   ├── services/
│   │   ├── scraperService.js   # Python scraper 调用管理
│   │   ├── matchService.js    # 匹配分析逻辑
│   │   ├── coverLetterService.js
│   │   ├── resumeParser.js    # docx/pdf 解析
│   │   └── configService.js   # 配置读写
│   ├── middleware/
│   │   └── errorHandler.js
│   └── utils/
│       ├── logger.js
│       └── validators.js
├── scrapers/
│   ├── run_scraper.py         # 统一入口
│   ├── scrapers/
│   │   ├── __init__.py
│   │   ├── base_scraper.py
│   │   ├── seek_scraper.py
│   │   ├── linkedin_scraper.py
│   │   └── apsjobs_scraper.py
│   └── requirements.txt
├── views/
│   ├── layout.ejs
│   ├── home.ejs               # Landing + 快速操作入口
│   ├── jobs/
│   │   ├── list.ejs
│   │   └── detail.ejs
│   ├── resumes/
│   │   ├── list.ejs
│   │   └── upload.ejs
│   ├── admin/
│   │   └── dashboard.ejs
│   └── partials/
│       ├── header.ejs
│       ├── footer.ejs
│       ├── job-card.ejs
│       └── status-badge.ejs
├── public/
│   ├── css/
│   │   ├── main.css           # 全局样式
│   │   ├── components.css    # 卡片、按钮等
│   │   ├── pages/
│   │   │   ├── home.css
│   │   │   ├── jobs.css
│   │   │   └── admin.css
│   │   └── effects/          # 粒子、动画等花哨效果
│   │       └── particles.css
│   └── js/
│       ├── main.js
│       ├── jobs.js            # 职位列表交互
│       ├── scrape.js          # 抓取触发 + SSE
│       ├── match.js
│       └── admin.js
├── data/                     # SQLite 数据库文件
├── logs/                     # 操作日志
├── .env                      # 环境变量 (API keys)
└── package.json
```

---

## 5. Auth & Security Model

**No user authentication** — single-user self-hosted app.

Security measures:
- API key stored in `.env`, never returned by any API
- `/admin` routes: token-based simple protection via `ADMIN_TOKEN` env var
  - Admin pages check `?token=XXX` or `Authorization: Bearer XXX` header
- File upload: only `.docx` and `.pdf` allowed, size limit 5MB
- SQL injection: all queries use parameterized statements (`?` placeholders)
- XSS: EJS auto-escapes all output; `{{ raw }}` only used with sanitization
- Scraping: rate limiting per source (1 request/second max)

---

## 6. Error Handling Strategy

| Layer | Strategy |
|-------|----------|
| Scraper errors | Catch all, log to `scrape_history.error_msg`, return partial results if possible |
| API errors | Centralized `errorHandler` middleware, always return `{error, code, message}` |
| AI API errors | Retry 2x with exponential backoff (1s, 2s), then return `MATCH_ERROR`/`CL_ERROR` |
| File parse errors | Return `{error: true, code: 'PARSE_ERROR', message}` — don't crash |
| SSE disconnects | Clean up Python subprocess on client disconnect |
| Empty results | Return `[]` with HTTP 200, not 404 |

---

## 7. Failure Modes & Edge Cases

| Scenario | Handling |
|----------|----------|
| Scraper blocked by site | Return 503 from scraper, show "Temporarily blocked" in UI, suggest retry later |
| No API key configured | Matching falls back to keyword-only scoring; CL generation shows warning |
| Resume parse fails | Show error toast, don't create DB record |
| Duplicate job (same source+external_id) | Skip silently, increment scrape count not jobs count |
| Very long JD (>50KB) | Truncate at 50KB before storing, log warning |
| No primary resume set | All matching/CL operations require a primary resume; prompt user to set one |
| Python not installed | `scraperService.js` checks at startup; errors clearly if missing |
| Network timeout during scrape | Python script has 30s/page timeout; partial results saved |

---

## 8. Decision Records

| DR | Decision | Rationale |
|----|----------|-----------|
| DR-1 | EJS SSR over SPA | Single user, SEO irrelevant, faster first paint, simpler stack |
| DR-2 | Python scrapers via Node.js fork() | v1 code reuse, Playwright stability, SSE from Node |
| DR-3 | SQLite better-sqlite3 | Zero-config, single file, perfect for self-hosted |
| DR-4 | SSE for progress | Simpler than WebSocket, HTTP-only, good enough |
| DR-5 | No multi-user auth | Single user app, admin token for admin routes |
| DR-6 | Semantic matching graceful degradation | Keyword-only fallback when no API key |

## TL;DR

Node.js + Express + SQLite + EJS SSR。Python scrapers via fork+SSE。OpenAI API (compatible)。无用户认证（单用户），admin token 保护管理面板。分层架构：routes → services → DB/scrapers。
