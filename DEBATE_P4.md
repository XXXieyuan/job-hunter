# DEBATE_P4.md — Phase 4: Implementation Plan (curl_cffi fix)

## Scope
Replace all HTTP libraries in Python scrapers with `curl_cffi` for reliable job scraping.

## Changes Required

### File: `scrapers/requirements.txt`
- Remove: `playwright`, `requests`
- Add: `curl_cffi>=0.7.0`

### File: `scrapers/run_scraper.py`
- Change shebang: `python3` → `python`
- Change imports (SEEK uses `from scrapers.` which may need `sys.path` fix)

### File: `scrapers/scrapers/apsjobs_scraper.py`
- Replace `import requests` with `from curl_cffi import requests`
- Replace all `requests.get/post` with `curl_cffi.requests.get/post`
- Set `impersonate="chrome110"` for browser fingerprint
- APSJobs has `from .base_scraper import BaseScraper, main` — keep same

### File: `scrapers/scrapers/linkedin_scraper.py`
- Replace `import requests` with `from curl_cffi import requests`
- Replace all `requests.get/post` with `curl_cffi.requests.get/post`
- Set `impersonate="chrome110"` for browser fingerprint

### File: `scrapers/scrapers/seek_scraper.py`
- Remove dependency on `seek_playwright.cjs` (Node.js helper)
- Replace with `curl_cffi` calls directly
- SEEK may need JavaScript rendering — try `curl_cffi` first, if JD is truncated, add Playwright as fallback
- Set `impersonate="chrome110"`

### File: `scrapers/scrapers/base_scraper.py`
- Keep existing SSE utilities
- May need to add `curl_cffi` session helper

## Test Cases
| ID | Test | Expected |
|----|------|----------|
| T1 | `python scrapers/run_scraper.py --source apsjobs --keywords "AI" --max_pages 1` | SSE output with jobs |
| T2 | `python scrapers/run_scraper.py --source seek --keywords "AI Engineer" --max_pages 1` | SSE output with jobs |
| T3 | `python scrapers/run_scraper.py --source linkedin --keywords "Data Scientist" --max_pages 1` | SSE output with jobs |
| T4 | API scrape trigger works end-to-end | Jobs appear in DB |

## Risks
| Risk | Mitigation |
|------|-----------|
| SEEK blocks curl_cffi | Try impersonation, fallback to Playwright if needed |
| APSJobs URL changed | Check URL structure, update if needed |
| curl_cffi not installed | Add to requirements.txt, `pip install curl_cffi` |
