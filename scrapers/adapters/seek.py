"""Seek.com.au job search adapter.

Scrapes Seek's server-rendered search pages and JSON-LD structured data
to extract Australian job listings.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any
from urllib.parse import quote_plus, urljoin

from bs4 import BeautifulSoup, Tag

from scrapers.base import BaseScraper
from scrapers.models import JobRecord

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_BASE_URL = "https://www.seek.com.au"
_SEARCH_URL_TEMPLATE = _BASE_URL + "/{keywords}-jobs/in-{location}"
_JOB_DETAIL_URL = _BASE_URL + "/job/{job_id}"

# Salary regex: "$80,000 - $100,000" or "$80k - $100k" etc.
_SALARY_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*[kK]?\s*[-–]\s*\$\s*([\d,]+(?:\.\d+)?)\s*[kK]?",
)


def _parse_salary(text: str | None) -> tuple[int | None, int | None]:
    """Extract min/max salary integers from a salary string."""
    if not text:
        return None, None
    m = _SALARY_RE.search(text)
    if not m:
        return None, None
    raw_min = m.group(1).replace(",", "")
    raw_max = m.group(2).replace(",", "")
    try:
        sal_min = int(float(raw_min))
        sal_max = int(float(raw_max))
        # Handle "80k" shorthand
        if sal_min < 1000 and "k" in text.lower():
            sal_min *= 1000
        if sal_max < 1000 and "k" in text.lower():
            sal_max *= 1000
        return sal_min, sal_max
    except (ValueError, TypeError):
        return None, None


def _normalise_work_type(raw: str | None) -> str | None:
    """Map Seek work-type labels to our enum."""
    if not raw:
        return None
    lower = raw.strip().lower()
    mapping = {
        "full time": "full-time",
        "full-time": "full-time",
        "part time": "part-time",
        "part-time": "part-time",
        "contract": "contract",
        "contract/temp": "contract",
        "casual": "casual",
        "casual/vacation": "casual",
    }
    return mapping.get(lower, lower)


class SeekScraper(BaseScraper):
    """Seek.com.au scraper using SSR HTML and JSON-LD extraction."""

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(platform="seek", config=config)

    # ------------------------------------------------------------------
    # URL construction
    # ------------------------------------------------------------------

    def _build_search_url(self, page: int = 1) -> str:
        """Build a Seek search URL from keywords and location.

        Seek URL pattern: /data-analyst-jobs/in-Sydney-NSW
        Query param pagination: ?page=2
        """
        kw_slug = self.keywords.strip().replace(" ", "-").lower() if self.keywords else "all"
        loc_slug = self.location.strip().replace(" ", "-") if self.location else "All-Australia"

        url = f"{_BASE_URL}/{quote_plus(kw_slug)}-jobs/in-{quote_plus(loc_slug)}"
        if page > 1:
            url += f"?page={page}"
        return url

    # ------------------------------------------------------------------
    # Parsing helpers
    # ------------------------------------------------------------------

    def _extract_jsonld_jobs(self, soup: BeautifulSoup) -> list[dict]:
        """Extract structured job data from JSON-LD script blocks."""
        jobs: list[dict] = []
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
            except (json.JSONDecodeError, TypeError):
                continue

            # Could be a single JobPosting or an itemList
            if isinstance(data, dict):
                if data.get("@type") == "JobPosting":
                    jobs.append(data)
                elif data.get("@type") == "ItemList":
                    for item in data.get("itemListElement", []):
                        if isinstance(item, dict) and item.get("@type") == "JobPosting":
                            jobs.append(item)
                        elif isinstance(item, dict) and "item" in item:
                            jobs.append(item["item"])
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("@type") == "JobPosting":
                        jobs.append(item)
        return jobs

    def _parse_job_cards(self, soup: BeautifulSoup) -> list[dict]:
        """Parse job cards from search result HTML.

        Seek renders job cards as article elements with data attributes.
        We look for common patterns in the SSR markup.
        """
        cards: list[dict] = []

        # Seek typically uses article tags or data-card-type attributes
        articles = soup.find_all("article", attrs={"data-card-type": "JobCard"})
        if not articles:
            # Fallback: look for any article with a job link
            articles = soup.find_all("article")
        if not articles:
            # Second fallback: divs with data-job-id
            articles = soup.find_all(attrs={"data-job-id": True})

        for article in articles:
            card: dict[str, Any] = {}

            # External ID
            job_id = None
            if isinstance(article, Tag):
                job_id = article.get("data-job-id")
            if not job_id:
                # Try to extract from link href
                link = article.find("a", href=re.compile(r"/job/(\d+)"))
                if link and isinstance(link, Tag):
                    href = str(link.get("href", ""))
                    m = re.search(r"/job/(\d+)", href)
                    if m:
                        job_id = m.group(1)

            if not job_id:
                continue

            card["external_id"] = str(job_id)
            card["url"] = f"{_BASE_URL}/job/{job_id}"

            # Title
            title_el = article.find("a", attrs={"data-automation": "jobTitle"})
            if not title_el:
                title_el = article.find("h3") or article.find("h2")
            card["title"] = title_el.get_text(strip=True) if title_el else ""

            # Company
            company_el = article.find("a", attrs={"data-automation": "jobCompany"})
            if not company_el:
                company_el = article.find(attrs={"data-automation": "jobCompany"})
            card["company"] = company_el.get_text(strip=True) if company_el else ""

            # Location
            loc_el = article.find("a", attrs={"data-automation": "jobLocation"})
            if not loc_el:
                loc_el = article.find(attrs={"data-automation": "jobLocation"})
            card["location"] = loc_el.get_text(strip=True) if loc_el else ""

            # Salary
            salary_el = article.find(attrs={"data-automation": "jobSalary"})
            card["salary_text"] = salary_el.get_text(strip=True) if salary_el else None

            # Work type
            wt_el = article.find(attrs={"data-automation": "jobWorkType"})
            card["work_type"] = wt_el.get_text(strip=True) if wt_el else None

            # Posted date
            date_el = article.find("time") or article.find(attrs={"data-automation": "jobListingDate"})
            card["posted_at"] = None
            if date_el:
                card["posted_at"] = date_el.get("datetime") if isinstance(date_el, Tag) and date_el.has_attr("datetime") else None

            cards.append(card)

        return cards

    def _fetch_job_detail(self, job_url: str) -> tuple[str, str]:
        """Fetch a job detail page and return (description_html, raw_json).

        Also attempts to extract JSON-LD from the detail page for richer data.
        """
        try:
            html = self._request(job_url)
        except Exception as exc:
            self._emit_status("error", f"Failed to fetch detail {job_url}: {exc!r}")
            return "", ""

        soup = BeautifulSoup(html, "html.parser")

        # Try JSON-LD first
        raw_json = ""
        jsonld_jobs = self._extract_jsonld_jobs(soup)
        if jsonld_jobs:
            raw_json = json.dumps(jsonld_jobs[0], ensure_ascii=False)

        # Extract description from the detail page
        desc_el = soup.find(attrs={"data-automation": "jobAdDetails"})
        if not desc_el:
            desc_el = soup.find("div", class_=re.compile(r"jobDescription|job-description", re.I))
        if not desc_el:
            # Broader fallback
            desc_el = soup.find("div", attrs={"role": "presentation"})

        description = str(desc_el) if desc_el else ""
        return description, raw_json

    def _has_next_page(self, soup: BeautifulSoup, current_page: int) -> bool:
        """Check if there is a next page of results."""
        # Look for pagination next link
        next_link = soup.find("a", attrs={"data-automation": "page-next"})
        if next_link:
            return True

        # Fallback: look for page links higher than current
        page_links = soup.find_all("a", href=re.compile(r"[?&]page=\d+"))
        for link in page_links:
            href = str(link.get("href", ""))
            m = re.search(r"page=(\d+)", href)
            if m and int(m.group(1)) > current_page:
                return True

        return False

    # ------------------------------------------------------------------
    # Main scrape method
    # ------------------------------------------------------------------

    def scrape(self) -> list[dict]:
        """Scrape Seek search results and return job dicts."""
        all_jobs: list[dict] = []
        jobs_found = 0

        self._emit_status("started", f"Seek scrape: keywords={self.keywords!r}, location={self.location!r}")

        for page in range(1, self.max_pages + 1):
            url = self._build_search_url(page)
            self._emit_status("progress", f"Fetching search page {page}: {url}")

            try:
                html = self._request(url)
            except Exception as exc:
                self._emit_status("error", f"Failed to fetch search page {page}: {exc!r}")
                break

            soup = BeautifulSoup(html, "html.parser")

            # Try JSON-LD extraction first, fall back to HTML cards
            jsonld_jobs = self._extract_jsonld_jobs(soup)
            cards = self._parse_job_cards(soup)

            # Build a lookup of JSON-LD data keyed by URL for merging
            jsonld_by_url: dict[str, dict] = {}
            for jd in jsonld_jobs:
                jd_url = jd.get("url", "")
                if jd_url:
                    jsonld_by_url[jd_url] = jd

            if not cards and not jsonld_jobs:
                self._emit_status("info", f"No jobs found on page {page}, stopping.")
                break

            # Process cards (prefer HTML cards, enrich with JSON-LD)
            page_jobs = cards if cards else []

            # If we only have JSON-LD and no cards, build cards from JSON-LD
            if not page_jobs and jsonld_jobs:
                for jd in jsonld_jobs:
                    jd_url = jd.get("url", "")
                    ext_id = ""
                    if jd_url:
                        m = re.search(r"/job/(\d+)", jd_url)
                        ext_id = m.group(1) if m else jd_url
                    page_jobs.append({
                        "external_id": ext_id,
                        "url": jd_url if jd_url.startswith("http") else f"{_BASE_URL}{jd_url}",
                        "title": jd.get("title", ""),
                        "company": (jd.get("hiringOrganization") or {}).get("name", ""),
                        "location": "",
                        "salary_text": None,
                        "work_type": jd.get("employmentType"),
                        "posted_at": jd.get("datePosted"),
                    })

            for card in page_jobs:
                ext_id = card.get("external_id", "")
                job_url = card.get("url", "")

                if not ext_id:
                    continue

                # Fetch detail page for full description
                description, raw_json = self._fetch_job_detail(job_url)

                # Merge JSON-LD data if available
                jd_data = jsonld_by_url.get(job_url, {})
                if not raw_json and jd_data:
                    raw_json = json.dumps(jd_data, ensure_ascii=False)

                # Parse salary
                salary_text = card.get("salary_text") or ""
                if not salary_text and jd_data:
                    base_salary = jd_data.get("baseSalary", {})
                    if isinstance(base_salary, dict):
                        val = base_salary.get("value", {})
                        if isinstance(val, dict):
                            salary_text = f"${val.get('minValue', '')} - ${val.get('maxValue', '')}"

                sal_min, sal_max = _parse_salary(salary_text)

                # Work type
                work_type = _normalise_work_type(card.get("work_type"))
                if not work_type and jd_data:
                    work_type = _normalise_work_type(jd_data.get("employmentType"))

                # Title, company, location — prefer card data, fall back to JSON-LD
                title = card.get("title") or jd_data.get("title", "")
                company = card.get("company") or (jd_data.get("hiringOrganization") or {}).get("name", "")
                location = card.get("location") or ""
                if not location and jd_data:
                    job_loc = jd_data.get("jobLocation")
                    if isinstance(job_loc, dict):
                        addr = job_loc.get("address", {})
                        if isinstance(addr, dict):
                            location = addr.get("addressLocality", "")

                posted_at = card.get("posted_at") or jd_data.get("datePosted")

                job = JobRecord(
                    external_id=f"seek-{ext_id}",
                    platform="seek",
                    title=title,
                    company=company,
                    location=location,
                    description=description,
                    url=job_url,
                    salary=salary_text or None,
                    salary_min=sal_min,
                    salary_max=sal_max,
                    work_type=work_type,
                    visa_requirement=None,
                    classification=None,
                    closes_at=None,
                    posted_at=posted_at,
                    raw_json=raw_json or "{}",
                )

                try:
                    self._emit_job(job)
                    all_jobs.append(job.to_dict())
                    jobs_found += 1
                except Exception as exc:
                    self._emit_status("error", f"Failed to emit job {ext_id}: {exc!r}")

            self._emit_status("progress", f"Page {page}: found {len(page_jobs)} jobs (total: {jobs_found})")

            # Check for next page
            if not self._has_next_page(soup, page):
                self._emit_status("info", f"No more pages after page {page}.")
                break

        self._emit_status("completed", f"Seek scrape complete: {jobs_found} jobs found.")
        return all_jobs
