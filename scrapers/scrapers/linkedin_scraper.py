#!/usr/bin/env python
import random
import re
import sys
from urllib.parse import quote_plus

from .base_scraper import BaseScraper, main


def _extract_div_cards(html):
    """Extract job cards from LinkedIn HTML using depth-counting for nested divs.

    LinkedIn uses <div class="...base-card..."> elements (not <li>).
    Non-greedy .*? breaks on nested divs, so we use explicit depth counting.
    """
    cards = []
    for m in re.finditer(r'<div\s+class="[^"]*base-card[^"]*"[^>]*>', html, re.I):
        start = m.start()
        depth = 1
        pos = html.find('>', start) + 1
        while depth > 0 and pos < len(html):
            snippet = html[pos:pos+5]
            if snippet in ('<div ', '<div>'):
                depth += 1
                pos = html.find('>', pos) + 1
            elif html[pos:pos+6] == '</div>':
                depth -= 1
                pos += 6
            else:
                pos += 1
        cards.append(html[start:pos])
    return cards


class LinkedInScraper(BaseScraper):
    BASE_URL = "https://www.linkedin.com/jobs/search/"
    LISTING_DELAY_SECONDS = (3.0, 7.0)
    DETAIL_DELAY_SECONDS = (3.0, 7.0)
    RETRY_BACKOFF_SECONDS = (5.0, 10.0)

    def build_url(self, page_number):
        start = max(page_number - 1, 0) * 25
        return (
            f"{self.BASE_URL}?keywords={quote_plus(self.keywords)}"
            f"&location=Australia&start={start}"
        )

    def get_retry_after_seconds(self, response):
        retry_after = response.headers.get("Retry-After") if response else None
        if not retry_after:
            return None

        try:
            return max(float(retry_after), 0.0)
        except (TypeError, ValueError):
            return None

    def session_get_with_backoff(self, session, url, timeout, delay, label):
        wait_seconds = random.uniform(*delay) if isinstance(delay, tuple) else delay
        response = None

        for attempt in range(len(self.RETRY_BACKOFF_SECONDS) + 1):
            if wait_seconds:
                self.rate_limit(wait_seconds)

            response = self.session_get(session, url, timeout=timeout)
            if response.status_code != 429:
                return response

            if attempt >= len(self.RETRY_BACKOFF_SECONDS):
                return response

            wait_seconds = (
                self.get_retry_after_seconds(response)
                or self.RETRY_BACKOFF_SECONDS[attempt]
            )
            self.sse_emit(
                "progress",
                {
                    "message": (
                        f"LinkedIn {label} hit HTTP 429; "
                        f"retrying in {int(wait_seconds)}s"
                    )
                },
            )

        return response

    def extract_cards(self, html):
        return _extract_div_cards(html)

    def extract_job(self, session, card_html):
        # Job ID from data-entity-urn="urn:li:jobPosting:123456789"
        job_id_m = re.search(r'data-entity-urn="urn:li:jobPosting:(\d+)"', card_html)
        external_id = job_id_m.group(1) if job_id_m else ""

        # Title: <h3 class="...base-search-card__title...">text</h3>
        title_m = re.search(
            r'<h3[^>]+class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)</h3>',
            card_html,
        )
        title = self.clean_text(title_m.group(1)) if title_m else ""

        # Company: <h4 class="...base-search-card__subtitle...">text</h4>
        company_m = re.search(
            r'<h4[^>]+class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)</h4>',
            card_html,
        )
        company = self.clean_text(company_m.group(1)) if company_m else None

        # Location: <span class="...job-search-card__location...">text</span>
        loc_m = re.search(
            r'<span[^>]+class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]{0,300}?)</span>',
            card_html,
        )
        location = self.clean_text(loc_m.group(1)) if loc_m else None

        # Posted date: <time datetime="2026-03-17">
        posted_m = re.search(r'<time[^>]*datetime="([^"]+)"', card_html)
        posted_date = posted_m.group(1) if posted_m else None

        # Job URL: href on the base-card__full-link anchor
        url_m = re.search(r'href="(https://au\.linkedin\.com/jobs/view/[^"]+)"', card_html)
        if not url_m:
            url_m = re.search(r'href="(/jobs/view/[^"]+)"', card_html)
        job_url = url_m.group(1).replace("&amp;", "&") if url_m else ""
        if job_url.startswith("/"):
            job_url = "https://au.linkedin.com" + job_url

        if not title:
            return None

        # Description: fetch detail page, but don't let it break the whole card
        description = self.fetch_job_detail(session, job_url) if job_url else ""

        return {
            "external_id": external_id or (
                job_url.rstrip("/").split("/")[-1].split("?")[0]
                if job_url else ""
            ),
            "title": title,
            "company": company,
            "location": location,
            "salary_min": None,
            "salary_max": None,
            "salary_currency": "AUD",
            "job_description": description or self.clean_text(card_html),
            "job_url": job_url,
            "posted_date": posted_date,
            "classification": None,
        }

    def fetch_job_detail(self, session, job_url):
        try:
            response = self.session_get_with_backoff(
                session,
                job_url,
                timeout=30,
                delay=self.DETAIL_DELAY_SECONDS,
                label="detail request",
            )
        except Exception as error:
            self.sse_emit("warning", {"message": f"LinkedIn detail fetch failed: {error}"})
            return ""

        if response.status_code >= 400:
            self.sse_emit(
                "warning",
                {"message": f"LinkedIn detail returned HTTP {response.status_code}"},
            )
            return ""

        # LinkedIn always has a sign-in modal overlay on public pages - ignore it.
        # Only block on genuine captcha challenges (not just the word in data attributes).
        captcha_blocks = [
            "g-recaptcha-response",
            "recaptcha-challenge",
            "captcha-form",
        ]
        if any(block in response.text for block in captcha_blocks):
            self.sse_emit("warning", {"message": "LinkedIn blocked with captcha challenge"})
            return ""

        # Try to extract description from structured HTML
        detail_match = re.search(
            r'(<div[^>]+class="[^"]*(?:show-more-less-html__markup|description__text)[^"]*"[^>]*>.*?</div>)',
            response.text,
            re.I | re.S,
        )
        if detail_match:
            return self.clean_text(detail_match.group(1))

        return ""

    def scrape(self):
        session = self.get_session()
        total_found = 0

        for page_number in range(1, max(self.max_pages, 1) + 1):
            try:
                response = self.session_get_with_backoff(
                    session,
                    self.build_url(page_number),
                    timeout=30,
                    delay=self.LISTING_DELAY_SECONDS,
                    label="listing request",
                )
            except Exception as error:
                self.sse_emit("warning", {"message": f"LinkedIn request failed: {error}"})
                break

            if response.status_code >= 400:
                self.sse_emit(
                    "warning",
                    {"message": f"LinkedIn listing returned HTTP {response.status_code}"},
                )
                break

            cards = self.extract_cards(response.text)
            if not cards:
                # Check for real captcha (not the sign-in modal)
                if any(b in response.text for b in ["g-recaptcha", "captcha-form"]):
                    self.sse_emit("warning", {"message": "LinkedIn blocked with captcha; returning partial results"})
                break

            for card in cards:
                job = self.extract_job(session, card)
                if not job or not self.validate_job(job):
                    continue
                self.jobs.append(job)
                total_found += 1
                self.sse_emit("job_found", {"job": job, "page": page_number})

            self.sse_emit("page_done", {"page": page_number, "total_found": total_found})

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": self.max_pages})


if __name__ == "__main__":
    sys.exit(main(LinkedInScraper))
