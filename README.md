# Job Hunter

Job Hunter is an AI‑powered job search assistant focused on the Australian market. It helps candidates understand how well they match open roles, generates tailored cover letters, and surfaces gaps between their profile and job requirements.

## Features

- Jobs list with role/source filters and minimum match score.
- Match scoring that combines keyword overlap and semantic similarity (via the OpenAI API).
- Detailed per‑job view with:
  - Overall fit score and breakdown.
  - Gap analysis highlighting missing/weak skills.
  - Generated cover letter content.
  - Company research summary (when available).
- Admin dashboard to:
  - Trigger batch analysis over stored jobs.
  - Upload new job data as JSON.
  - View aggregate stats (job counts, average match score, high‑fit roles).
- Dark, responsive UI optimised for desktop and mobile.

## Tech Stack

- Node.js
- Express
- EJS + ejs-mate layouts
- SQLite (via better-sqlite3)
- OpenAI API (for semantic scoring and content generation)

## Getting Started

### Prerequisites

- Node.js 18+ recommended
- An OpenAI API key (if you want semantic scoring and cover letter generation)

### Installation

```bash
git clone <this-repo-url>
cd job-hunter
npm install
```

### Environment Configuration

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY=sk-...
DATABASE_PATH=./data/job-hunter.db
PORT=3000
```

Adjust `DATABASE_PATH` and `PORT` to match your environment. If `OPENAI_API_KEY` is not set, semantic scores and AI‑generated content will be disabled gracefully.

### Running the App

```bash
npm start
```

The server will start on `http://localhost:3000` by default.

## Usage

### Jobs

1. Navigate to `http://localhost:3000/jobs`.
2. Use the filters at the top to narrow by role, source, and minimum match score.
3. Click on a job card to open the detailed view, where you can:
   - Inspect the full description.
   - Review fit score and scoring breakdown.
   - See gap analysis and matched keywords.
   - Read a generated cover letter (when analysis has been run).

### Admin Dashboard

1. Open `http://localhost:3000/admin?token=job-hunter-admin-2026`.
2. Use **运行分析** (“Run analysis”) to start a batch scoring run across stored jobs.
3. Upload new job data via the JSON uploader; the expected payload is an array of job objects including fields such as `title`, `company_name`, `description`, `role`, `url`, `location`, `salary`, etc.
4. Monitor the latest run status and aggregate statistics in the dashboard cards.

> Note: The admin token is passed via the query string and in the request body when triggering analysis. Keep this value secret in real deployments.

## Screenshots

Screenshots are not included in this repository yet. Suggested set:

- Jobs list view (desktop)
- Job detail view with fit score and tabs
- Admin dashboard with stats and run status

## License

This project is provided as‑is for demo and experimentation purposes. See `LICENSE` if present in this repository for full terms.

