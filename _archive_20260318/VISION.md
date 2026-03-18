# Vision
## Mission Statement
Job Hunter is an AI-powered job search assistant focused on the Australian market, helping job seekers understand how well they match open roles, generate tailored cover letters, and highlight gaps between their resume and job requirements. It replaces spreadsheet-based tracking with a structured, scored, and prioritized pipeline.

## Target Users & Personas
1. **Maya Chen** — Recent software engineering graduate in Melbourne. Has a generic resume and struggles to identify which jobs she is most competitive for. Needs: fast job discovery, honest match feedback, concrete improvement suggestions. Uses the app on a laptop during evenings.

2. **David Okafor** — Experienced data analyst in Sydney, mid-career switcher targeting government and consultancy roles. Needs: filtered shortlists, cover letters tailored per role, gap analysis against specific job criteria. Active job searcher, uses the app daily.

3. **Wei Zhang** — Senior UX designer relocating from China, applying for Australian roles. Needs: bilingual cover letters, Australian-market context, job alerts. High comfort with AI tools but limited knowledge of local job sites.

## Success Metrics
- **Setup completion rate:** >= 95% of first-time users complete setup and reach the search page within 10 minutes (measured via  flag).
- **Weekly active searchers:** >= 3 search runs per week for >= 60% of users who have completed setup.
- **Shortlist rate:** >= 30% of users who complete at least one search run add at least one job to a shortlist within 7 days.
- **Cover letter generation rate:** >= 20% of shortlisted jobs receive at least one cover letter generation attempt.
- **Match quality signal:** Average match score distribution is between 40-85 (uniform spread, not all zeros or all 90s). Measured at the 30-day mark.
- **Bilingual adoption:** >= 20% of cover letter generations use the zh-CN language option within the first 60 days.
- **Technical reliability:** API error rate < 1% for all endpoints over a rolling 7-day window.

## Feature Scope
### In-Scope (P0 = MVP, P1 = should have, P2 = nice to have)
**P0 — MVP (ships in v1.0):**
- First-run setup wizard: BASE_URL + API key validation, single resume upload (.docx or text-based .pdf), language preference (en/zh-CN)
- Manual job search: SEEK and APSJobs job board scraping, configurable page limit (1-5 pages per source), live polling UI for run progress
- Job listing and filtering: filter by source (SEEK/APSJobs), review status (unread/shortlisted/applied/rejected), score state (scored/stale/unranked), free-text search on title/company
- AI job scoring: keyword overlap + semantic similarity (requires OpenAI API), overall score 0-100, per-keyword breakdown
- Job shortlisting: change review status inline, optimistic UI, per-job retry ranking
- Cover letter generation: per-job, per-language (en/zh-CN), generate + save draft, view/edit saved drafts
- Bilingual UI: all labels, buttons, placeholders, and toast messages in both en and zh-CN
- Reduced effects toggle: P0, reduces particles/animations/shimmer when enabled
- Health check: GET /api/v1/health returning status, latency, setup state

**P1 — Post-launch (ships in v1.1+):**
- LinkedIn Easy Apply integration (no-login manual URL import, graceful fallback to manual entry)
- Multiple resume profiles (upload and switch between resumes)
- Job application deadline tracking (manual date field + visual indicator)
- Export shortlisted jobs to PDF/CSV

**P2 — Future:**
- Email integration (send cover letter + resume via SMTP)
- Job alert notifications (polling for new matching jobs)
- Community-sourced job boards (GitHub Jobs, Glassdoor, Indeed via scraping)

### Explicitly Out-of-Scope (v1 hard exclusions)
- Any form of multi-user, team, or shared-account functionality
- Social features, comments, or collaboration tools
- Job application tracking (status beyond shortlisting: submitted, interview, offer)
- Payment processing or subscription management
- Resume parsing by AI vision models (Claude/Vercel AI SDK)
- LinkedIn OAuth login
- Browser extension or mobile app
- Automatic job board account creation or credential storage

### Deferred to Backlog
- Multiple resume profiles (v1.1)
- Job alert notifications (v1.2)
- PDF/CSV export (v1.1)

## User Stories (core flows with acceptance criteria)
1. **First-run setup:** User opens app for the first time → sees setup wizard → enters BASE_URL + API key → validates connection (shows success/error inline with latency) → uploads resume → chooses language → reaches search page. AC: setup completes in <= 3 API calls, error messages are actionable, resume persists across sessions.

2. **Search jobs:** User enters keywords + optional location → selects sources (SEEK, APSJobs) → sets page limit → taps Run Search → sees live polling of run progress → views ranked job list on completion. AC: run completes in <= 2 minutes for 5 pages across 2 sources; polling updates at least every 2s; partial failures show per-source status.

3. **Review and shortlist:** User scans job list → changes review status inline (unread → shortlisted) → sees optimistic UI update → sees corrected pill on API error. AC: status change reflects in < 500ms visually; API error restores previous state with toast.

4. **Cover letter generation:** User opens job detail → taps Generate Cover Letter (en or zh-CN) → sees loading state → views generated draft → edits and saves. AC: generation completes in <= 30s; draft is editable before saving; saving creates a new version; language switch prompts if unsaved edits.

5. **Reduced effects:** User opens Settings → toggles Reduce Effects ON → particles stop, counters snap, shimmer gone. AC: all non-essential animation stops; toggle state persists; OS-level prefers-reduced-motion also respected.

## Key Decisions
1. **Single resume profile for v1** — complexity vs. value trade-off; most job seekers maintain one primary resume during a job search campaign.
2. **SEEK + APSJobs only for v1** — LinkedIn deferred to P1; avoids scraping-API-stability risk on day one.
3. **Manual run triggers only** — no background/cron jobs; user has full control over when scraping happens; simpler reliability model.
4. **SQLite for storage** — zero-infrastructure; file-based backup/restore; sufficient for single-user scale.
5. **Semantic + keyword scoring** — OpenAI API call per job; balances quality and cost; fallback to keyword-only if API fails.
6. **Resume .docx and text-based .pdf only for v1** — binary PDFs deferred; keep parsing pipeline simple.
7. **Bilingual from day one** — zh-CN support is core to the target user base (Wei Zhang persona); not a nice-to-have.
8. **Server-Sent Events (SSE) NOT used** — WebSocket or SSE deferred to future; simple polling suffices for MVP.

## TL;DR
Job Hunter is a local-first, bilingual job search assistant for the Australian market. It scrapes SEEK and APSJobs, scores jobs against the user's resume using AI, and generates cover letters — all on a single machine, with no accounts, no cloud, and no monthly fees. Target: job seekers who want structure and intelligence without the overhead of existing job portals.
