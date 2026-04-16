"""ACT Government Jobs scraper adapter.

Scrapes jobs.act.gov.au using the site's HTML listing page as the primary
data source, with the RSS feed at /rss/subscribe for supplementary data.
Uses curl_cffi via BaseScraper for HTTP requests.
"""

from __future__ import annotations

import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any

from bs4 import BeautifulSoup

from scrapers.base import BaseScraper
from scrapers.classification_map import extract_classification, map_classification
from scrapers.models import JobRecord

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_ACTGOV_BASE = "https://jobs.act.gov.au"
_RSS_URL = _ACTGOV_BASE + "/rss/subscribe"
_HTML_LISTING_URLS = [
    _ACTGOV_BASE + "/opportunities/all",
    _ACTGOV_BASE + "/opportunities",
    _ACTGOV_BASE + "/jobs",
]

# Hourly rate annualisation factor (40 hrs/week × 52 weeks)
_HOURS_PER_YEAR = 2080

# ---------------------------------------------------------------------------
# Salary parsing
# ---------------------------------------------------------------------------

# Pattern: range with dollar signs "$85,000 - $95,000" or "$85,000 to $95,000"
_SALARY_RANGE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$\s*([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)

# Pattern: single value "$92,000" or "$92,000 pa"
_SALARY_SINGLE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:pa|per\s+annum|p\.a\.)?",
    re.IGNORECASE,
)

# Pattern: hourly rate "$45.50 per hour"
_SALARY_HOURLY_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:per\s+hour|p/?h|/\s*hr)",
    re.IGNORECASE,
)

# Pattern: raw integer (from data-salary attribute, spike-validated)
_SALARY_RAW_INT_RE = re.compile(r"^\s*(\d{4,})\s*$")


def _parse_salary_value(text: str) -> int | None:
    """Parse a salary string to an integer, stripping commas and dollar signs."""
    if not text:
        return None
    cleaned = text.replace(",", "").replace("$", "").strip()
    try:
        return int(float(cleaned))
    except (ValueError, TypeError):
        return None


def parse_salary(raw: str | None) -> tuple[int | None, int | None, str | None]:
    """Parse salary text into (salary_min, salary_max, formatted_string).

    Returns (None, None, None) if the input is unparseable.
    """
    if not raw or not raw.strip():
        return None, None, None

    text = raw.strip()

    # Try raw integer first (primary path for data-salary attribute)
    m = _SALARY_RAW_INT_RE.match(text)
    if m:
        val = int(m.group(1))
        return val, val, f"${val:,}"

    # Try range pattern
    m = _SALARY_RANGE_RE.search(text)
    if m:
        lo = _parse_salary_value(m.group(1))
        hi = _parse_salary_value(m.group(2))
        if lo is not None and hi is not None:
            return lo, hi, f"${lo:,} - ${hi:,}"

    # Try hourly rate (before single value to avoid partial match)
    m = _SALARY_HOURLY_RE.search(text)
    if m:
        cleaned = m.group(1).replace(",", "").strip()
        try:
            hourly_float = float(cleaned)
            annual = int(hourly_float * _HOURS_PER_YEAR)
            hourly_display = f"{hourly_float:,.2f}"
            return annual, annual, f"${hourly_display}/hr (${annual:,} annualised)"
        except (ValueError, TypeError):
            pass

    # Try single value
    m = _SALARY_SINGLE_RE.search(text)
    if m:
        val = _parse_salary_value(m.group(1))
        if val is not None:
            return val, val, f"${val:,}"

    return None, None, None


# ---------------------------------------------------------------------------
# Visa / citizenship detection
# ---------------------------------------------------------------------------

_CITIZENSHIP_PATTERNS = [
    re.compile(r"australian\s+citizen", re.I),
    re.compile(r"must\s+hold\s+australian\s+citizenship", re.I),
    re.compile(r"citizenship\s+is\s+a\s+requirement", re.I),
    re.compile(r"only\s+available\s+to\s+australian\s+citizens", re.I),
    re.compile(r"ACTPS\s+employee", re.I),
]

_PR_PATTERNS = [
    re.compile(r"permanent\s+resident", re.I),
    re.compile(r"australian\s+permanent\s+resident\s+or\s+citizen", re.I),
    re.compile(r"must\s+have\s+the\s+right\s+to\s+work\s+permanently", re.I),
]

_SECURITY_PATTERNS = [
    re.compile(r"security\s+clearance", re.I),
    re.compile(r"baseline\s+clearance", re.I),
    re.compile(r"\bNV[12]\b", re.I),
    re.compile(r"negative\s+vetting", re.I),
]


def _detect_visa_requirement(text: str | None) -> str | None:
    """Detect visa/citizenship requirements from description text."""
    if not text:
        return None
    for pat in _CITIZENSHIP_PATTERNS:
        if pat.search(text):
            return "citizens_only"
    for pat in _PR_PATTERNS:
        if pat.search(text):
            return "pr_required"
    return None


def _detect_security_clearance(text: str | None) -> str | None:
    """Detect security clearance requirements from description text."""
    if not text:
        return None
    for pat in _SECURITY_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(0).strip()
    return None


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

def _parse_rss_date(date_str: str | None) -> str | None:
    """Parse an RSS pubDate (RFC 2822) to ISO 8601 date string."""
    if not date_str:
        return None
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return None


def _parse_iso_date(date_str: str | None) -> str | None:
    """Normalise a date string to ISO 8601 (YYYY-MM-DD)."""
    if not date_str or not date_str.strip():
        return None
    text = date_str.strip()
    # Already ISO format
    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    # DD/MM/YYYY format
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if m:
        return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
    return None


# ---------------------------------------------------------------------------
# Work type extraction
# ---------------------------------------------------------------------------

_WORK_TYPE_MAP = {
    "full-time": "full-time",
    "full time": "full-time",
    "fulltime": "full-time",
    "part-time": "part-time",
    "part time": "part-time",
    "parttime": "part-time",
    "casual": "casual",
    "temporary": "temporary",
    "contract": "contract",
    "permanent": "full-time",
}


def _extract_work_type(text: str | None) -> str | None:
    """Extract work type from listing text."""
    if not text:
        return None
    lower = text.lower()
    for key, val in _WORK_TYPE_MAP.items():
        if key in lower:
            return val
    return None


# ---------------------------------------------------------------------------
# ACT Gov Scraper Adapter
# ---------------------------------------------------------------------------

class ActGovScraper(BaseScraper):
    """ACT Government Jobs scraper (jobs.act.gov.au).

    Uses HTML listing page as primary data source, with RSS feed
    for supplementary data (description, pubDate).
    """

    def __init__(self, config: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if config is None:
            config = {}
        # Forward kwargs (e.g. keywords, location) into config so BaseScraper sees them
        for key, value in kwargs.items():
            config.setdefault(key, value)
        # ACT Gov needs very few requests — conservative rate limiting
        config.setdefault("rpm", 6)
        config.setdefault("burst", 2)
        super().__init__(platform="actgov", config=config)

    def scrape(self) -> list[dict]:
        """Scrape ACT Government jobs and emit via JSON Lines protocol."""
        all_jobs: list[dict] = []
        start_time = time.monotonic()

        self._emit_status("started", "ACT Gov scraper starting")

        # Step 1: Fetch RSS feed for supplementary data
        rss_items = self._fetch_rss()
        rss_by_url: dict[str, dict] = {}
        for item in rss_items:
            url = item.get("url", "")
            if url:
                rss_by_url[url] = item

        self._emit_status(
            "progress",
            f"RSS feed: {len(rss_items)} items",
        )

        # Step 2: Fetch HTML listing page (primary data source)
        html_listings = self._fetch_html_listings()

        self._emit_status(
            "progress",
            f"HTML listings: {len(html_listings)} tiles found",
        )

        # Step 3: RSS truncation detection
        if rss_items and html_listings:
            if len(rss_items) < 0.8 * len(html_listings):
                self._emit_status(
                    "warn",
                    f"RSS feed may be truncated: {len(rss_items)} RSS items "
                    f"vs {len(html_listings)} HTML listings",
                )

        # Step 4: Handle zero listings
        if not html_listings and not rss_items:
            self._emit_status(
                "error",
                "No listings found from either RSS or HTML sources",
            )
            elapsed = time.monotonic() - start_time
            self._emit_status(
                "completed",
                f"0 jobs found in {elapsed:.1f}s",
            )
            return all_jobs

        # Step 5: Process HTML listings as primary, merge RSS data
        jobs_found = 0
        for listing in html_listings:
            try:
                job = self._process_listing(listing, rss_by_url)
                if job is not None:
                    self._emit_job(job)
                    all_jobs.append(job.to_dict())
                    jobs_found += 1
            except Exception as exc:
                ext_id = listing.get("url", "unknown")
                self._emit_status(
                    "error",
                    f"Failed to process listing {ext_id}: {exc!r}",
                )

        # Step 6: Process RSS-only items not found in HTML
        html_urls = {lst.get("url", "") for lst in html_listings}
        for url, rss_item in rss_by_url.items():
            if url not in html_urls:
                try:
                    job = self._process_rss_only(rss_item)
                    if job is not None:
                        self._emit_job(job)
                        all_jobs.append(job.to_dict())
                        jobs_found += 1
                except Exception as exc:
                    self._emit_status(
                        "error",
                        f"Failed to process RSS item {url}: {exc!r}",
                    )

        elapsed = time.monotonic() - start_time
        self._emit_status(
            "completed",
            f"{jobs_found} jobs found in {elapsed:.1f}s",
        )
        return all_jobs

    # ------------------------------------------------------------------
    # RSS parsing
    # ------------------------------------------------------------------

    def _fetch_rss(self) -> list[dict]:
        """Fetch and parse the RSS feed. Returns empty list on failure."""
        try:
            text = self._request(_RSS_URL)
        except Exception as exc:
            self._emit_status(
                "warn",
                f"RSS feed unavailable: {exc!r}. Proceeding with HTML-only mode.",
            )
            return []

        try:
            root = ET.fromstring(text)
        except ET.ParseError as exc:
            self._emit_status(
                "warn",
                f"RSS XML parse error: {exc!r}. Proceeding with HTML-only mode.",
            )
            return []

        items: list[dict] = []
        for item_el in root.iter("item"):
            title_el = item_el.find("title")
            link_el = item_el.find("link")
            desc_el = item_el.find("description")
            pub_el = item_el.find("pubDate")
            guid_el = item_el.find("guid")

            url = link_el.text.strip() if link_el is not None and link_el.text else ""
            items.append({
                "title": title_el.text.strip() if title_el is not None and title_el.text else "",
                "url": url,
                "description": desc_el.text.strip() if desc_el is not None and desc_el.text else "",
                "posted_at": _parse_rss_date(pub_el.text if pub_el is not None else None),
                "guid": guid_el.text.strip() if guid_el is not None and guid_el.text else url,
            })

        return items

    # ------------------------------------------------------------------
    # HTML listing page parsing
    # ------------------------------------------------------------------

    def _fetch_html_listings(self) -> list[dict]:
        """Fetch and parse HTML listing tiles. Tries alternate URLs on failure."""
        for url in _HTML_LISTING_URLS:
            try:
                html = self._request(url)
            except Exception as exc:
                self._emit_status(
                    "warn",
                    f"HTML page {url} unavailable: {exc!r}",
                )
                continue

            listings = self._parse_html_tiles(html, url)
            if listings:
                return listings

            self._emit_status(
                "warn",
                f"HTML page {url} returned 0 listing tiles, trying next URL",
            )

        self._emit_status(
            "warn",
            "All HTML listing URLs returned 0 tiles. Using RSS-only mode.",
        )
        return []

    def _parse_html_tiles(self, html: str, page_url: str) -> list[dict]:
        """Extract listing data from HTML tiles using data-* attributes."""
        soup = BeautifulSoup(html, "lxml")

        # Primary selector: tiles with data-salary attribute (spike-validated)
        tiles = soup.find_all(attrs={"data-salary": True})

        if not tiles:
            # Fallback: look for common job tile patterns
            tiles = soup.find_all("div", class_=re.compile(r"job[-_]?tile|listing", re.I))

        listings: list[dict] = []
        for tile in tiles:
            # Extract URL from link
            link = tile.find("a", href=True)
            href = link["href"] if link else ""
            if href and not href.startswith("http"):
                href = _ACTGOV_BASE + href

            # Extract title from heading
            heading = tile.find(re.compile(r"^h[1-6]$"))
            title = ""
            if heading:
                title = heading.get_text(strip=True)
            elif link:
                title = link.get_text(strip=True)

            if not title and not href:
                continue

            # Extract data attributes
            salary_raw = tile.get("data-salary", "")
            closing_date = tile.get("data-closingdate", tile.get("data-closingDate", ""))
            advertised_date = tile.get("data-advertiseddate", tile.get("data-advertisedDate", ""))
            classification = tile.get("data-classification", "")
            directorate = tile.get("data-directorate", "")

            # If no directorate from data attr, try text content
            if not directorate:
                directorate = self._extract_directorate_from_tile(tile)

            # Extract external_id from URL path
            external_id = self._extract_external_id(href)

            # Get full tile text for work type detection
            tile_text = tile.get_text(" ", strip=True)

            listings.append({
                "title": title,
                "url": href,
                "external_id": external_id,
                "salary_raw": str(salary_raw),
                "closing_date": closing_date,
                "advertised_date": advertised_date,
                "classification_raw": classification,
                "directorate": directorate,
                "tile_text": tile_text,
            })

        return listings

    @staticmethod
    def _extract_directorate_from_tile(tile: Any) -> str:
        """Try to extract directorate/organisation from tile text content."""
        # Look for common pattern elements
        for el in tile.find_all(class_=re.compile(r"directorate|agency|org", re.I)):
            text = el.get_text(strip=True)
            if text:
                return text
        return ""

    @staticmethod
    def _extract_external_id(url: str) -> str:
        """Extract a unique ID from an ACT Gov job URL."""
        if not url:
            return ""
        # Pattern: /opportunities/12345 or /jobs/12345
        m = re.search(r"/(?:opportunities|jobs)/(\d+)", url)
        if m:
            return f"actgov-{m.group(1)}"
        # Fallback: use the full URL path as ID
        from urllib.parse import urlparse
        path = urlparse(url).path.strip("/")
        return f"actgov-{path.replace('/', '-')}" if path else ""

    # ------------------------------------------------------------------
    # Listing processing
    # ------------------------------------------------------------------

    def _process_listing(
        self,
        listing: dict,
        rss_by_url: dict[str, dict],
    ) -> JobRecord | None:
        """Process a single HTML listing tile, merging RSS data if available."""
        title = listing.get("title", "")
        url = listing.get("url", "")
        external_id = listing.get("external_id", "")

        if not title or not url:
            return None

        # Merge RSS data if available
        rss_data = rss_by_url.get(url, {})
        description = rss_data.get("description", "")
        if not description:
            description = listing.get("tile_text", "")

        # Salary parsing (primary: data-salary raw integer)
        salary_raw = listing.get("salary_raw", "")
        salary_min, salary_max, salary_str = parse_salary(salary_raw)

        # Classification
        classification_raw = listing.get("classification_raw", "")
        if not classification_raw:
            classification_raw = extract_classification(title) or ""
        if not classification_raw:
            classification_raw = extract_classification(description) or ""

        classification = map_classification(classification_raw) if classification_raw else None

        # Dates
        closing_date = _parse_iso_date(listing.get("closing_date"))
        posted_at = _parse_iso_date(listing.get("advertised_date"))
        if not posted_at:
            posted_at = rss_data.get("posted_at")

        # Company (directorate)
        company = listing.get("directorate", "")
        if not company:
            company = "ACT Government"

        # Location
        location = "Canberra, ACT"

        # Visa and security clearance detection
        combined_text = f"{title} {description}"
        visa_req = _detect_visa_requirement(combined_text)
        security_clearance = _detect_security_clearance(combined_text)

        # Work type
        work_type = _extract_work_type(listing.get("tile_text", ""))

        # Build raw_json for audit
        raw_data = {
            "html": listing,
            "rss": rss_data if rss_data else None,
            "security_clearance": security_clearance,
        }

        if not external_id:
            external_id = f"actgov-{hash(url) & 0xFFFFFFFF:08x}"

        return JobRecord(
            external_id=external_id,
            platform="actgov",
            title=title,
            company=company,
            location=location,
            description=description,
            url=url,
            salary=salary_str,
            salary_min=salary_min,
            salary_max=salary_max,
            work_type=work_type,
            visa_requirement=visa_req,
            classification=classification,
            closes_at=closing_date,
            posted_at=posted_at,
            raw_json=json.dumps(raw_data, ensure_ascii=False, default=str),
        )

    def _process_rss_only(self, rss_item: dict) -> JobRecord | None:
        """Process an RSS item that has no matching HTML tile."""
        title = rss_item.get("title", "")
        url = rss_item.get("url", "")

        if not title or not url:
            return None

        description = rss_item.get("description", "")
        external_id = self._extract_external_id(url)

        # Classification from title/description
        classification_raw = extract_classification(title) or extract_classification(description)
        classification = map_classification(classification_raw) if classification_raw else None

        # Visa and security clearance
        combined_text = f"{title} {description}"
        visa_req = _detect_visa_requirement(combined_text)
        security_clearance = _detect_security_clearance(combined_text)

        # Work type
        work_type = _extract_work_type(description)

        raw_data = {"rss": rss_item, "html": None, "security_clearance": security_clearance}

        if not external_id:
            external_id = rss_item.get("guid", f"actgov-{hash(url) & 0xFFFFFFFF:08x}")

        return JobRecord(
            external_id=external_id,
            platform="actgov",
            title=title,
            company="ACT Government",
            location="Canberra, ACT",
            description=description,
            url=url,
            salary=None,
            salary_min=None,
            salary_max=None,
            work_type=work_type,
            visa_requirement=visa_req,
            classification=classification,
            closes_at=None,
            posted_at=rss_item.get("posted_at"),
            raw_json=json.dumps(raw_data, ensure_ascii=False, default=str),
        )
