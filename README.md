[English](./README.md) | [中文](./README_CN.md)

# Job Hunter

Job Hunter is an AI-powered job search assistant focused on the Australian market. It helps candidates understand how well they match open roles, generates tailored cover letters, and highlights gaps between their resume and job requirements.

## Core Features

### 🎯 Job Matching & Filtering
- **Job list**: Job list with filters for role, source, and minimum fit score
- **Intelligent scoring**: Match scoring that combines keyword overlap and semantic similarity (requires OpenAI API)
- **Real-time filtering**: Quickly filter highly relevant roles based on fit score

### 📊 Detailed Job View
- **Overall fit score**: Aggregate score with detailed breakdown
- **Gap analysis**: Highlights missing or weak skill keywords
- **Cover letter generation**: AI-generated Chinese cover letter (3–5 paragraphs, under 400 Chinese characters)
- **Company research**: Shows company summary and website when available

### ⚙️ Admin Dashboard
- **Batch analysis**: Trigger batch scoring for all stored jobs
- **Data upload**: Upload new job data via JSON
- **Statistics dashboard**: Job counts, average fit score, and high-fit jobs grouped by role

### 🎨 User Experience
- **Dark theme**: Modern glassmorphism-style UI
- **Responsive design**: Optimized for both desktop and mobile
- **No-API mode**: Basic functionality available even without an API key

## Tech Stack

- **Backend**: Node.js, Express
- **Templating**: EJS + ejs-mate layouts
- **Database**: SQLite (better-sqlite3)
- **AI integration**: OpenAI API (semantic scoring and content generation)
- **Scraper**: Puppeteer (APSJobs scraping)
- **Frontend**: Vanilla JavaScript + modern CSS

## Architecture Overview

```
job-hunter/
├── src/
│   ├── server.js              # Server entrypoint
│   ├── app.js                 # Express app configuration
│   ├── config/                # Configuration loading
│   │   └── index.js
│   ├── db/                    # Database layer
│   │   ├── connection.js
│   │   ├── migrate.js
│   │   └── migrations/        # SQL migration files
│   ├── repositories/          # Data access layer
│   │   ├── jobsRepo.js
│   │   ├── fitScoresRepo.js
│   │   ├── coverLettersRepo.js
│   │   ├── companiesRepo.js
│   │   ├── resumesRepo.js
│   │   └── analysisRunsRepo.js
│   ├── services/              # Business logic layer
│   │   ├── openAIClient.js    # OpenAI API wrapper
│   │   ├── scoringService.js  # Fit score calculation
│   │   ├── coverLetterService.js # Cover letter generation
│   │   ├── analysisService.js # Batch analysis
│   │   ├── companyService.js  # Company research
│   │   └── resumeService.js   # Resume management
│   ├── routes/                # Routes
│   │   ├── jobsRoutes.js      # Job-related routes
│   │   └── adminRoutes.js     # Admin dashboard routes
│   └── scrapers/              # Scrapers
│       └── apsjobsScraper.js  # APSJobs scraper
├── public/                    # Static assets
│   ├── css/
│   │   └── main.css
│   └── js/
│       ├── main.js            # General frontend logic
│       └── admin.js           # Admin dashboard logic
├── views/                     # EJS templates
│   ├── layout.ejs
│   ├── jobs/
│   │   ├── list.ejs
│   │   └── detail.ejs
│   └── admin/
│       └── dashboard.ejs
├── data/                      # SQLite database
├── .env                       # Environment variables
└── package.json
```

## Data Model

### Tables

**jobs** – Job information
```sql
id, external_id, source, role, title, company_name, location, salary, 
description, url, posted_at, application_status, raw_json, created_at
```

**resumes** – Resume information
```sql
id, name, summary, skills_json, experience_json, education_json, raw_json
```

**job_fit_scores** – Fit scores
```sql
id, job_id, resume_id, overall_score, keyword_score, embedding_score, 
breakdown_json, created_at
```

**cover_letters** – Generated cover letters
```sql
id, job_id, resume_id, language, content, created_at
```

**companies** – Company research data
```sql
id, name, website, description, raw_html, industry, size, researched_at
```

**analysis_runs** – Batch analysis runs
```sql
id, status, sources_json, stats_json, error, started_at, completed_at
```

## Getting Started

### Prerequisites

- Node.js 18+
- OpenAI API key (required for semantic scoring and cover letter generation)
- Chromium (for scraping; Puppeteer will download it automatically)

### Installation

```bash
git clone <this-repo-url>
cd job-hunter
npm install
```

### Environment Configuration

Create a `.env` file at the project root:

```bash
# Server configuration
PORT=3001

# Database
DB_PATH=./data/job-hunter.sqlite

# OpenAI configuration (supports custom Base URL)
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.n1n.ai/v1   # Can be changed to https://api.openai.com/v1
OPENAI_CHAT_MODEL=MiniMax-M2.5         # Can be changed to gpt-4o, etc.
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Admin dashboard
ADMIN_TOKEN=job-hunter-admin-2026

# Fit threshold
FIT_THRESHOLD=70
```

**About providers and models**:
- `OPENAI_BASE_URL` points to the AI provider’s API endpoint
- `OPENAI_CHAT_MODEL` specifies the chat model name
- The project is configured for n1n.ai (MiniMax-M2.5) by default but can be switched to OpenAI, Azure, or any compatible API.

### Start the Application

```bash
npm start
```

The server runs at `http://localhost:3001` (or the port configured in `.env`).

### Development Mode

```bash
npm run dev
```

## Usage Guide

### First-Time Setup Flow

1. **Configure environment variables**: Set up the `.env` file (especially the API key).
2. **Start the server**: `npm start`
3. **Add resumes**: Add resume data via the database or API.
4. **Import jobs**: Upload JSON via the admin dashboard or run the scraper.
5. **Run analysis**: Click “Run Analysis” in the admin dashboard. The system will:
   - Compute fit scores between each job and resume
   - Generate cover letters
   - Research company information
6. **Browse jobs**: Visit `/jobs` to view match results.

### Job Management

#### View Job List

Visit `http://localhost:3001/jobs`

**Features**:
- Role filter (dropdown)
- Source filter (dropdown)
- Minimum fit score filter (numeric input)
- Job cards showing: title, company, location, source, and fit score

#### View Job Detail

Click a job card to open the detail page.

**Features**:
- **Job description tab**: Full JD, source, posted date, original link
- **Fit analysis tab**: Overall score, keyword overlap, semantic similarity, matched keywords
- **Gap analysis tab**: Missing skill keywords
- **Right sidebar**: Generated cover letter and company research information

### Admin Dashboard

Visit `http://localhost:3001/admin?token=job-hunter-admin-2026`

#### Run Analysis

Click the “Run Analysis” button to trigger the batch process:
- Runs asynchronously and returns a run ID
- Computes fit scores for all job–resume pairs
- Generates cover letters (if missing)
- Researches companies (if missing)
- Refresh the page to see progress and results

**Analysis flow**:
```
1. Load all resumes
2. Load all jobs
3. For each job–resume pair:
   a. Compute keyword match score (40% weight)
   b. Compute semantic similarity (60% weight, requires API)
   c. Generate cover letter (if needed)
   d. Perform company research (if needed)
4. Persist results to the database
5. Update statistics
```

#### Upload Job Data

Bulk-import jobs via a JSON array:

**Example format**:
```json
[
  {
    "title": "Senior AI Engineer",
    "company_name": "TechCorp",
    "description": "Responsible for AI model development and optimization...",
    "role": "AI Engineer",
    "url": "https://example.com/jobs/123",
    "location": "Sydney, NSW",
    "salary": "$120k - $150k",
    "posted_at": "2026-03-15"
  }
]
```

**Bulk import command**:
```bash
curl -X POST http://localhost:3001/admin/upload?token=job-hunter-admin-2026 \
  -H "Content-Type: application/json" \
  -d @jobs.json
```

#### View Statistics

The admin dashboard shows:
- Total jobs / scored jobs
- Total fit records / average fit score
- High-fit jobs grouped by role

### Scraper Tools

#### APSJobs Scraper

```bash
# Basic usage
npm run scrape:apsjobs -- --keywords "data analysis,product management" --maxPages 3

# Export JSON
npm run scrape:apsjobs -- --keywords "AI,software engineering" --mode json --output data/export.json

# Filter by location
npm run scrape:apsjobs -- --keywords "engineering" --location "Canberra" --maxPages 5
```

**Parameters**:
- `--keywords`: Comma-separated keyword list
- `--location`: Location filter (optional)
- `--maxPages`: Max number of pages to scrape (default 3)
- `--mode`: `db` (write directly to DB) or `json` (export file)
- `--output`: JSON output path (only for `json` mode)

**Notes**:
- APSJobs may employ anti-scraping measures
- Scraper uses a headless browser and can take some time
- Results are de-duplicated (based on `external_id`)

### API Integration

#### OpenAI Configuration

The project uses a configurable Base URL to support multiple AI providers:

```bash
# n1n.ai (default)
OPENAI_BASE_URL=https://api.n1n.ai/v1
OPENAI_CHAT_MODEL=MiniMax-M2.5

# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o

# Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
OPENAI_CHAT_MODEL=gpt-4o

# Custom API
OPENAI_BASE_URL=https://your-api.example.com/v1
OPENAI_CHAT_MODEL=your-model-name
```

**Key points**:
- `OPENAI_BASE_URL` has any trailing `/` removed automatically
- All requests use `Bearer` authentication
- POST `/chat/completions` is used for chat
- POST `/embeddings` is used for embeddings

#### Fit Scoring Algorithm

**Formula**:
```
overall_fit_score = keyword_match_score × 40% + semantic_similarity_score × 60%
```

**Keyword match**:
- Searches the job description for a predefined keyword list
- Computes match ratio (0–100)
- Adds extra weight when title and experience both contain certain keywords (for example, “product”)

**Semantic similarity**:
- Uses `text-embedding-3-small` to generate embeddings
- Computes cosine similarity (0–1)
- Maps similarity to a 0–100 score

**Keyword list**:
python, javascript, node.js, node, react, tensorflow, pytorch, sql, postgresql, aws, docker, kubernetes, agile, scrum, kanban, product, product management, data analysis, machine learning, ml, nlp, natural language processing, computer vision

### Cover Letter Generation

**Generation logic**:
- System prompt: act as a career coach
- User prompt includes:
  - Job title and company
  - Key information from the JD
  - Resume highlights (summary + core skills)
  - Fit score
  - Company research data (if available)
- Requirements: Chinese output, 3–5 paragraphs, <400 Chinese characters, emphasize AI, product thinking, and cross-functional communication

**Example style**:
```
尊敬的招聘经理：

您好！我对贵公司 [职位名称] 深感兴趣。作为一名拥有 [X 年] 经验的 [专业领域] 专家...

在 [公司名称] 担任 [当前职位] 期间，我成功...

我的核心技能包括：[技能 1]、[技能 2]、[技能 3]...

我相信我的 [特定优势] 与贵职位的要求高度匹配...

诚挚的，
[姓名]
```

### Common Workflows

#### Scenario 1: First Deployment

```bash
# 1. Clone the project
git clone <repo>
cd job-hunter

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and fill in API keys, etc.

# 4. Start the server
npm start

# 5. Add resumes (via DB or admin API)
# 6. Upload/import job data
# 7. Run analysis
# 8. View results
```

#### Scenario 2: Day-to-Day Use

```bash
# 1. Start the server
npm start

# 2. Wait for analysis to complete (or trigger it)
curl -X POST "http://localhost:3001/admin/run?token=job-hunter-admin-2026"

# 3. Visit http://localhost:3001/jobs to browse jobs
# 4. Open detail pages to see fit scores and cover letters
```

#### Scenario 3: Updating Data

```bash
# Option A: Scrape new jobs
npm run scrape:apsjobs -- --keywords "AI,data analysis" --maxPages 5

# Option B: Upload JSON
curl -X POST http://localhost:3001/admin/upload \
  -H "Content-Type: application/json" \
  -d @new-jobs.json

# Option C: Re-run analysis
# Click the button in the admin dashboard or call the API
```

## API Reference

### Job Endpoints

**GET /jobs** – Job list
- Query parameters:
  - `role`: role filter
  - `source`: source filter
  - `minScore`: minimum fit score
- Returns: rendered HTML page

**GET /jobs/:id** – Job detail
- Returns: rendered HTML page
- Includes: job information, fit scores, cover letter, and company data

### Admin Endpoints

**GET /admin** – Admin dashboard
- Auth: `?token=` or `Authorization: Bearer <token>`
- Returns: rendered HTML page
- Includes: statistics, run status, upload form

**POST /admin/run** – Trigger analysis
- Auth: same as above
- Body: any (can be empty)
- Returns: `{ runId: <id> }`
- Runs asynchronously; progress visible in the admin dashboard

**POST /admin/upload** – Upload jobs
- Auth: same as above
- Body: array of job objects or `{ jobs: [...] }`
- Returns: `{ inserted: <count> }`
- Field mapping is defined in the code’s `mapped` object

## Development & Extension

### Adding New Columns

1. Modify a migration file in `src/db/migrations/xxx_add_field.sql`
2. Update the relevant repo files
3. Update the service layer
4. Update view templates
5. Run migrations (restart the server to auto-run)

### Customizing the Scoring Algorithm

Edit `src/services/scoringService.js`:

```javascript
// Adjust weights
const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;

// Add your own keywords
const KNOWN_KEYWORDS = [...your_keywords];

// Customize scoring logic
function scoreJobAgainstResume(job, resume) {
  // Custom implementation
}
```

### Adding a New Scraper

1. Create a new file under `src/scrapers/`
2. Implement `main()` or export a function
3. Add an npm script in `package.json`
4. Use `apsjobsScraper.js` as a reference

### Frontend Customization

**CSS**: edit `public/css/main.css`
- Theme colors are defined under `:root`
- Card styles: `.glass-card`
- Button styles: `.btn`

**JavaScript**: edit `public/js/main.js` or `admin.js`
- Tab switching logic is already encapsulated
- Fit-score color classification helpers are available

### Database Operations

Use the built-in repository helpers:

```javascript
const { getJobById, getJobsWithScore } = require('./src/repositories/jobsRepo');
const { insertManyJobs } = require('./src/repositories/jobsRepo');

// Query
const jobs = getJobsWithScore({ role: 'AI Engineer', minScore: 70 });

// Insert
insertManyJobs([...jobObjects]);
```

**Direct access**:

```javascript
const { getDb } = require('./src/db/connection');
const db = getDb();

const result = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
```

## Troubleshooting

### Common Issues

**Q: Cover letter shows “OpenAI API not configured”**
- Check `OPENAI_API_KEY` in `.env`
- Confirm the API key is valid and has quota
- Verify that `OPENAI_BASE_URL` is reachable

**Q: Fit scores are always 0 or missing**
- Run “Run Analysis” from the admin dashboard
- Confirm at least one resume exists
- Check API configuration in `.env`

**Q: Scraper cannot fetch data**
- APSJobs structure may have changed
- Check network connectivity and firewalls
- Try reducing `--maxPages`
- Manually open the site in a browser to confirm availability

**Q: Database errors**
- Check permissions on the `data/` directory
- Confirm `better-sqlite3` installed correctly
- If necessary: delete the old `.sqlite` file and restart

**Q: Port already in use**
- Change `PORT` in `.env`
- Or run `kill -9 $(lsof -t -i:3001)` to terminate the process

### Debugging Tips

1. **View logs**:
   ```bash
   npm start 2>&1 | tee app.log
   ```

2. **Inspect the database**:
   ```bash
   sqlite3 data/job-hunter.sqlite
   sqlite> SELECT COUNT(*) FROM jobs;
   sqlite> SELECT * FROM job_fit_scores LIMIT 5;
   ```

3. **Test endpoints**:
   ```bash
   curl http://localhost:3001/jobs
   curl http://localhost:3001/admin?token=job-hunter-admin-2026
   ```

4. **Verify environment variables**:
   ```bash
   node -e "console.log(process.env.OPENAI_API_KEY ? 'OK' : 'MISSING')"
   ```

### Performance Tuning

- **DB indexes**: Already created (see migration files)
- **Bulk inserts**: Use `db.transaction()` (already used in scraper)
- **Async analysis**: Uses `setImmediate` to run in the background
- **Caching ideas**: You can add response caching in `openAIClient.js`

## Deployment

### Production Environment Example

```bash
# .env.production
PORT=80
DB_PATH=/var/lib/job-hunter/db.sqlite
OPENAI_API_KEY=<secure-key>
ADMIN_TOKEN=<random-secure-token>
```

### Using PM2

```bash
npm install -g pm2
pm2 start src/server.js --name job-hunter --env production
pm2 save
```

### Docker (Recommended)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p data
EXPOSE 3001
CMD ["npm", "start"]
```

### Security Notes

- **Change `ADMIN_TOKEN`**: Use a strong random string
- **HTTPS**: Required for production
- **Firewall**: Expose only necessary ports
- **API keys**: Never commit them to version control
- **Backups**: Regularly back up the `data/` directory

## Contributing

This project is under active development. Contributions are welcome:

- Share usage feedback
- Report bugs
- Add new scraper adapters
- Improve UI/UX
- Optimize the matching algorithm

## License

MIT License – see LICENSE file (if present).

---

**Note**: This is an experimental project intended for learning and demonstration. Thoroughly test and harden the system before any production use.

## Support

If you run into issues, check:
- Code comments in the project
- Messages and hints in the admin dashboard
- Browser developer tools console
- Server logs

