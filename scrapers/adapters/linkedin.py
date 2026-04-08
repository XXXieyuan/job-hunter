"""LinkedIn public job search adapter.

Scrapes LinkedIn's guest/public job search endpoint which does not require
authentication.  Uses curl_cffi with TLS fingerprint impersonation.

This adapter is marked **best-effort with launch-gate** -- LinkedIn is
aggressive with anti-bot detection, so it may be blocked.  When blocked the
adapter emits a ``"blocked"`` status and exits gracefully (exit code 0, zero
jobs returned) rather than crashing.
"""

from __future__ import annotations

import json
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from bs4 import BeautifulSoup

from scrapers.base import BaseScraper
from scrapers.models import JobRecord

# LinkedIn guest API endpoint for paginated job search results.
# Returns HTML fragments (job cards) without requiring login.
_SEARCH_URL = (
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
)

# Public job detail page (guest view).
_DETAIL_URL = "https://www.linkedin.com/jobs/view/{job_id}"

# GeoId for Australia on LinkedIn.
_AUSTRALIA_GEO_ID = "101452733"

# Pagination size used by LinkedIn's guest API.
_PAGE_SIZE = 25


class LinkedInScraper(BaseScraper):
    """Scraper for LinkedIn public job search.

    Config keys
    -----------
    keywords : str
        Search terms (e.g. ``"data analyst"``).
    location : str
        Free-text location (e.g. ``"Canberra"``).  Also sets the ``geoId``
        parameter to Australia.
    max_pages : int
        Maximum search result pages to fetch (default 5).
    """

    # Override base: slower RPM for LinkedIn (per SYSTEM_DESIGN 3.4).
    MAX_RETRIES: int = 3

    def __init__(self, config: dict[str, Any]) -> None:
        # Force conservative rate limiting for LinkedIn.
        config.setdefault("rpm", 6)
        config.setdefault("burst", 2)
        super().__init__(platform="linkedin", config=config)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _request_with_linkedin_delay(
        self, url: str, **kwargs: Any
    ) -> str | None:
        """Wrapper around ``_request`` that handles LinkedIn-specific blocks.

        Returns the response text, or ``None`` if blocked / redirected to
        the auth wall.
        """
        try:
            text = self._request(url, **kwargs)
        except Exception as exc:
            # Treat any terminal failure as a potential block.
            self._emit_status(
                "blocked",
                f"Request failed for {url}: {exc!r}",
            )
            return None

        # LinkedIn sometimes returns a 200 but with an auth-wall redirect
        # embedded in the HTML (or a near-empty body).
        if text and ("authwall" in text or "login" in text.lower()[:500]):
            self._emit_status(
                "blocked",
                "LinkedIn returned auth-wall page; treating as blocked.",
            )
            return None

        # Extra human-like delay on top of the base rate limiter.
        time.sleep(random.uniform(3.0, 5.0))
        return text

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_job_cards(html: str) -> list[dict[str, Any]]:
        """Extract job card data from the search results HTML fragment."""
        soup = BeautifulSoup(html, "html.parser")
        cards: list[dict[str, Any]] = []

        for card in soup.find_all("li"):
            try:
                # Title
                title_tag = card.find(
                    "h3",
                    class_=re.compile(r"base-search-card__title"),
                )
                title = title_tag.get_text(strip=True) if title_tag else None

                # Company
                company_tag = card.find(
                    "h4",
                    class_=re.compile(r"base-search-card__subtitle"),
                )
                company = (
                    company_tag.get_text(strip=True) if company_tag else None
                )

                # Location
                location_tag = card.find(
                    "span",
                    class_=re.compile(r"job-search-card__location"),
                )
                location = (
                    location_tag.get_text(strip=True)
                    if location_tag
                    else None
                )

                # Link / external ID
                link_tag = card.find(
                    "a", class_=re.compile(r"base-card__full-link")
                )
                if link_tag is None:
                    # Fallback: any anchor with an href containing /jobs/view/
                    link_tag = card.find(
                        "a", href=re.compile(r"/jobs/view/")
                    )

                job_url: str | None = None
                external_id: str | None = None
                if link_tag and link_tag.get("href"):
                    job_url = link_tag["href"].split("?")[0]
                    id_match = re.search(r"/jobs/view/(\d+)", job_url)
                    if id_match:
                        external_id = id_match.group(1)

                # Posted date (relative text like "2 days ago")
                time_tag = card.find("time")
                posted_at: str | None = None
                if time_tag and time_tag.get("datetime"):
                    posted_at = time_tag["datetime"]  # ISO date

                if title and external_id:
                    cards.append(
                        {
                            "title": title,
                            "company": company or "",
                            "location": location or "",
                            "url": job_url or "",
                            "external_id": external_id,
                            "posted_at": posted_at,
                        }
                    )
            except Exception:
                # Skip malformed cards silently.
                continue

        return cards

    @staticmethod
    def _parse_description(html: str) -> str:
        """Extract the job description text from a detail page."""
        soup = BeautifulSoup(html, "html.parser")

        # The public detail page wraps the description in a div with a
        # specific class.
        desc_div = soup.find(
            "div", class_=re.compile(r"show-more-less-html__markup")
        )
        if desc_div:
            return desc_div.decode_contents().strip()

        # Fallback: look for the description section.
        desc_section = soup.find(
            "section", class_=re.compile(r"description")
        )
        if desc_section:
            return desc_section.get_text(separator="\n", strip=True)

        return ""

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def scrape(self) -> list[dict]:
        """Scrape LinkedIn public job search and return job dicts.

        If LinkedIn blocks us at any point, we emit a ``"blocked"`` status
        and return whatever jobs we collected so far (which may be zero).
        """
        self._emit_status("starting", "LinkedIn scraper starting")

        all_jobs: list[dict] = []
        blocked = False

        for page in range(self.max_pages):
            if blocked:
                break

            start_offset = page * _PAGE_SIZE
            params: dict[str, Any] = {
                "keywords": self.keywords,
                "location": self.location,
                "geoId": _AUSTRALIA_GEO_ID,
                "start": str(start_offset),
            }

            self._emit_status(
                "scraping",
                f"Fetching search page {page + 1}/{self.max_pages} "
                f"(offset {start_offset})",
            )

            html = self._request_with_linkedin_delay(
                _SEARCH_URL, params=params
            )
            if html is None:
                blocked = True
                break

            cards = self._parse_job_cards(html)
            if not cards:
                self._emit_status(
                    "info",
                    f"No job cards found on page {page + 1}; "
                    "end of results or blocked.",
                )
                break

            self._emit_status(
                "info",
                f"Found {len(cards)} job cards on page {page + 1}",
            )

            # Fetch full descriptions for each card.
            for card in cards:
                description = ""
                detail_url = _DETAIL_URL.format(job_id=card["external_id"])

                detail_html = self._request_with_linkedin_delay(detail_url)
                if detail_html is None:
                    # Blocked mid-run; keep what we have.
                    blocked = True
                    self._emit_status(
                        "blocked",
                        "Blocked while fetching job detail; "
                        "stopping with partial results.",
                    )
                    break

                description = self._parse_description(detail_html)

                job = JobRecord(
                    external_id=f"linkedin-{card['external_id']}",
                    platform="linkedin",
                    title=card["title"],
                    company=card["company"],
                    location=card["location"],
                    description=description,
                    url=card["url"],
                    salary=None,
                    salary_min=None,
                    salary_max=None,
                    work_type=None,
                    visa_requirement=None,
                    classification=None,
                    closes_at=None,
                    posted_at=card.get("posted_at"),
                    raw_json=json.dumps(card, ensure_ascii=False),
                )

                self._emit_job(job)
                all_jobs.append(job.to_dict())

        if blocked and not all_jobs:
            self._emit_status(
                "blocked",
                "LinkedIn blocked all requests. "
                "Zero jobs collected -- exiting gracefully.",
            )
        elif blocked:
            self._emit_status(
                "blocked",
                f"LinkedIn blocked further requests. "
                f"Returning {len(all_jobs)} partial results.",
            )
        else:
            self._emit_status(
                "info",
                f"LinkedIn scrape complete: {len(all_jobs)} jobs collected.",
            )

        return all_jobs
