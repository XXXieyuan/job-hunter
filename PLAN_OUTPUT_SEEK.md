1. URL structure  
   - Base URL pattern: `https://www.seek.com.au/{job-title}/in-{location}`  
   - `--keywords` (comma-separated)  
     - For each keyword:  
       - Normalize to URL slug: lowercase, trim, replace non-alphanumeric with `-`, collapse multiple `-`, trim leading/trailing `-`.  
   - `--location`  
     - Normalize to slug with same rules, then plug into `in-{location}` segment.  
     - If no location provided: `https://www.seek.com.au/{job-title}` (no `in-` suffix).  
   - Add query params for paging and tuning:  
     - `?page=1` (1-based page index for pagination)  
     - Potential additional params (optional, as plan): `&where={location}`, `&keywords={keyword}`, but core navigation should work via path segments.  

2. Selectors for job cards (approximate using `data-automation`)  
   - Job card container:  
     - Primary: `div[data-automation="normalJob"]`  
     - Fallbacks:  
       - `article[data-automation="job-card"]`  
       - `div[data-automation*="job-card"]`  
   - Within each card (run via `$$eval` inside page context):  
     - Title:  
       - `a[data-automation="jobTitle"]` or `h3[data-automation="jobTitle"]`  
     - Company name:  
       - `span[data-automation="jobCompany"]` or `a[data-automation="jobCompany"]`  
     - Location:  
       - `span[data-automation="jobLocation"]`  
     - Salary:  
       - `span[data-automation="jobSalary"]`  
     - Short description / teaser:  
       - `span[data-automation="jobShortDescription"]` or `p[data-automation="jobShortDescription"]`  
     - Card link / URL:  
       - Prefer the same anchor as title: `a[data-automation="jobTitle"]` and read `href`.  

   Note: exact attribute values may need verification against live Seek HTML; code should be written to be resilient (multiple fallbacks + text normalization).  

3. Data fields to extract  
   For each job card, extract and normalize:  
   - `title`  
     - Text from job title element.  
   - `company_name`  
     - Text from job company element; null if missing.  
   - `location`  
     - Text from job location element; normalize whitespace.  
   - `salary`  
     - Text from job salary element; null if missing.  
   - `description`  
     - Short teaser from description element; null if missing.  
   - `url`  
     - Absolute URL: if `href` starts with `/`, prefix `https://www.seek.com.au`, otherwise use as-is.  
   - `posted_at`  
     - Seek often shows “Listed x days ago”; store raw label (e.g., `"Listed 3 days ago"`) or null. If a reliable `data-automation="jobListingDate"` style element exists, extract that.  
   - Internal fields aligned with DB schema (mirroring APSJobs):  
     - `external_id`:  
       - Derive from job URL, e.g. `seek-{jobId}` where `jobId` is last path segment or number inside slug.  
     - `source`: literal `"seek"`.  
     - `role`: duplicate of `title` for consistency.  

4. Implementation steps  

   4.1. File and CLI scaffold (`src/scrapers/seekScraper.js`)  
   - Copy structure from `apsjobsScraper.js`:  
     - `require('playwright').chromium`, `fs`, `path`, `better-sqlite3`, and `getLogger`.  
     - `emitProgress(progress)` function identical to APS version to keep `[PROGRESS]` JSON format stable.  
   - Implement `parseArgs(argv)` similar to APS but tailored:  
     - Supported flags:  
       - `--mode` (`'db'` | `'json'`), default `'db'`.  
       - `--keywords` (comma-separated string).  
       - `--location` (string).  
       - `--maxPages` / `--max-pages` (int, default 3).  
       - `--output` (for JSON mode).  
     - Reuse same parsing semantics (support `--key value` and `--key=value`).  

   4.2. DB helpers  
   - Reuse `getDb()` and `prepareDbStatement(db)` from APS scraper, as the jobs table is shared:  
     - `external_id`, `source`, `role`, `title`, `company_name`, `location`, `salary`, `description`, `url`, `posted_at`, `raw_json`.  
   - Ensure `INSERT OR REPLACE` semantics so `url` uniqueness is enforced via `external_id`/unique index.  
   - When storing, set `raw_json` to full job object JSON.  

   4.3. URL and navigation helpers  
   - Implement `buildSeekUrl(keyword, location, pageIndex)`  
     - `slugify` helper for keyword and location.  
     - `basePath` =  
       - `/${keywordSlug}` if no location  
       - `/${keywordSlug}/in-${locationSlug}` if location present  
     - `query` = `?page=${pageIndex}`  
     - Full URL: `https://www.seek.com.au${basePath}?page=${pageIndex}`.  
   - Implement `navigateToSearch(page, keyword, location, pageIndex)`  
     - Build URL via `buildSeekUrl`.  
     - `page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 })`.  
     - `page.waitForTimeout(3000)` as a post-load stabilization.  

   4.4. Extraction logic  
   - Implement `async function extractJobsFromPage(page)` using `page.$$eval` on job card selector described above:  
     - For each card:  
       - Helper `normText(el)` to trim and collapse whitespace.  
       - Read title, company, location, salary, description, url.  
       - Derive `jobId` from `url` (e.g., regex capturing the numeric id inside `/job/{id}` or last path segment).  
       - Compute `external_id = 'seek-' + jobId`.  
       - Safely skip cards without `title` or `url`.  
     - Return array of normalized job objects compatible with DB insertion.  

   4.5. Pagination handling  
   - Approach A (URL-based paging; simpler & less brittle):  
     - Scrape each page by explicitly calling `navigateToSearch` for `pageIndex` 1..`maxPages`.  
     - After extraction, if page has zero jobs, break early.  
   - Approach B (optional, DOM “Next” button):  
     - If Seek exposes a `data-automation="search-pagination-next"` button/link, add helper:  
       - `hasNextPage(page)` to detect if “Next” is enabled.  
       - `goToNextPage(page)` to click it and `waitForNavigation`.  
     - Choose A for initial implementation, B as enhancement.  
   - In this plan, prefer Approach A: rely fully on URL `?page=` parameter for deterministic paging.  

   4.6. Keyword-level scraping  
   - Implement `async function scrapeKeyword(page, keyword, location, maxPages, progressCtx)` mirroring APS:  
     - Initialize `allJobs = []`.  
     - Loop `pageIndex` from 1 to `maxPages`:  
       - Increment `progressCtx.current` and call `emitProgress({ total, current, message: \`Scraping Seek "${keyword}" page ${pageIndex} of ${maxPages}\` })`.  
       - `navigateToSearch(page, keyword, location, pageIndex)`.  
       - Wait for either:  
         - Selector `div[data-automation="normalJob"]` or similar, or  
         - “No jobs found” text (e.g., `text=/No jobs found/i`) using `Promise.race`.  
       - `const jobs = await extractJobsFromPage(page);`  
       - Append to `allJobs`.  
       - If `jobs.length === 0`, break (no more results).  
     - Deduplicate by `external_id` before returning.  

   4.7. Main entrypoint and CLI behavior  
   - `async function main()` similar to APS:  
     - Parse args.  
     - Validate `--keywords` (required, comma-split, trim, filter empty).  
     - Read `location`, `maxPages`, `mode`.  
     - Log starting info (`source: "seek"`).  
     - Launch Playwright Chromium in headless mode with `--no-sandbox` flags.  
     - Create `page`.  
     - Initialize `allJobsMap = new Map()` for dedup across keywords.  
     - `maxRetries = 2` per keyword.  
     - `totalSteps = keywords.length * maxPages` for progress.  
     - `progressCtx = { total: totalSteps, current: 0 }`.  
     - For each keyword:  
       - Retry loop similar to APS:  
         - On success, merge job list into `allJobsMap` keyed by `external_id`.  
         - On error, log and retry up to `maxRetries`.  
     - Convert `allJobsMap` to array.  
     - If `mode === 'json'`:  
       - Resolve `outputPath` (default `seek-jobs.json` or similar).  
       - Strip `raw_json` field before writing to file (same pattern as APS).  
     - Else (default `db`):  
       - Open DB via `getDb()`.  
       - Use `prepareDbStatement(db)` from shared helper.  
       - Transactionally upsert all jobs, setting `raw_json` to `JSON.stringify(job)`.  
       - Close DB.  
     - Close browser.  
   - `if (require.main === module) { main().catch(...) }` pattern to allow standalone CLI run.  

5. Test plan  

   5.1. Unit / integration-like tests (manual or automated)  
   - CLI arg parsing:  
     - Run `node src/scrapers/seekScraper.js --keywords="engineer,developer" --location="melbourne" --maxPages=2 --mode=json --output=tmp/seek.json`  
       - Confirm no crashes and JSON file produced.  
   - URL builder:  
     - Verify logs or add temporary debug to check that:  
       - `keywords="Software Engineer"` & `location="Melbourne VIC"` produce URLs like `https://www.seek.com.au/software-engineer/in-melbourne-vic?page=1`.  
   - Selector sanity check:  
     - Run scraper for a small keyword (`--keywords="engineer" --maxPages=1`) and confirm it returns non-empty job list and fields are populated (title, url, etc.).  
   - Pagination behavior:  
     - Run with `--maxPages=3` and check logs show requests for `page=1`, `page=2`, `page=3`.  
     - Confirm pages beyond last results break early.  
   - DB integration:  
     - Run with `--mode=db` and inspect SQLite `jobs` table:  
       - `source` is `"seek"`.  
       - `external_id` is unique per job.  
       - Re-running scraper upserts (no duplicates).  

   5.2. [PROGRESS] JSON format  
   - Run scraper and pipe output:  
     - `node src/scrapers/seekScraper.js --keywords="engineer" --maxPages=2 --mode=json | grep '^\[PROGRESS\]'`  
       - Confirm each line is valid JSON with `total`, `current`, `message` fields and matches APS format.  

6. Integration with `/api/scrape/run`  

   6.1. Process wiring  
   - Existing `/api/scrape/run` likely spawns APS scraper via `child_process.spawn` and listens to STDOUT for `[PROGRESS]` markers.  
   - Add Seek as a new `source` option:  
     - Extend API contract: `/api/scrape/run?source=seek&keywords=...&location=...&maxPages=...&mode=...`.  
     - In the route handler, map `source === 'seek'` to executable: `node src/scrapers/seekScraper.js`.  

   6.2. Arg mapping  
   - From request query/body to CLI:  
     - `--keywords` from `req.body.keywords` or query.  
     - `--location` from `req.body.location`.  
     - `--maxPages` from `req.body.maxPages` (default 3).  
     - `--mode` inferred:  
       - For interactive UI, typically `db` so results show from DB.  
       - Optionally support `json` for exporting.  

   6.3. Progress and completion  
   - Reuse existing APS progress handler:  
     - For each line starting with `[PROGRESS]`, parse JSON and forward via SSE or WebSocket to frontend.  
     - When child process exits:  
       - Respond with summary (e.g., number of jobs scraped) or rely on frontend to read from DB.  

   6.4. Frontend / UX  
   - For UI, add Seek as a source option; when user selects Seek and runs the scraper, backend calls `/api/scrape/run` with `source=seek` and same progress UI can be reused because `[PROGRESS]` format is identical.
