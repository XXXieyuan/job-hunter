#!/usr/bin/env python3
import re
import sys
from urllib.parse import quote_plus

from .base_scraper import BaseScraper, main


class LinkedInScraper(BaseScraper):
    BASE_URL = "https://www.linkedin.com/jobs/search/"

    def build_url(self, page_number):
        start = max(page_number - 1, 0) * 25
        return (
            f"{self.BASE_URL}?keywords={quote_plus(self.keywords)}"
            f"&location=Australia&start={start}"
        )

    def extract_cards(self, html):
        return re.findall(r"(<li[^>]+class=\"[^\"]*base-card[^\"]*\"[^>]*>.*?</li>)", html, re.I | re.S)

    def extract_job(self, card_html):
        link_match = re.search(r'href="([^"]+/jobs/view/[^"]+)"', card_html, re.I)
        title_match = re.search(r'class="[^"]*base-search-card__title[^"]*"[^>]*>(.*?)<', card_html, re.I | re.S)
        company_match = re.search(r'class="[^"]*base-search-card__subtitle[^"]*"[^>]*>(.*?)<', card_html, re.I | re.S)
        location_match = re.search(r'class="[^"]*job-search-card__location[^"]*"[^>]*>(.*?)<', card_html, re.I | re.S)
        posted_match = re.search(r'<time[^>]*datetime="([^"]+)"', card_html, re.I)

        if not link_match or not title_match:
            return None

        description = self.fetch_job_detail(link_match.group(1))

        return {
            "external_id": link_match.group(1).rstrip("/").split("/")[-1],
            "title": self.clean_text(title_match.group(1)),
            "company": self.clean_text(company_match.group(1)) if company_match else None,
            "location": self.clean_text(location_match.group(1)) if location_match else None,
            "salary_min": None,
            "salary_max": None,
            "salary_currency": "AUD",
            "job_description": description or self.clean_text(card_html),
            "job_url": link_match.group(1),
            "posted_date": posted_match.group(1) if posted_match else None,
            "classification": None,
        }

    def fetch_job_detail(self, job_url):
        try:
            response = self.http_get(job_url, timeout=30)
        except Exception as error:
            self.sse_emit("warning", {"message": f"LinkedIn detail fetch failed: {error}"})
            return ""

        if response.status_code >= 400:
            self.sse_emit("warning", {"message": f"LinkedIn returned HTTP {response.status_code}"})
            return ""

        if "sign in" in response.text.lower() or "captcha" in response.text.lower():
            self.sse_emit("warning", {"message": "LinkedIn may require login cookies for full job descriptions"})
            return ""

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
            self.rate_limit(2.0)

            try:
                response = self.session_get(session, self.build_url(page_number), timeout=30)
            except Exception as error:
                self.sse_emit("warning", {"message": f"LinkedIn request failed: {error}"})
                break

            if response.status_code >= 400:
                self.sse_emit("warning", {"message": f"LinkedIn returned HTTP {response.status_code}"})
                break

            cards = self.extract_cards(response.text)
            if not cards:
                if "captcha" in response.text.lower():
                    self.sse_emit("warning", {"message": "LinkedIn blocked the request; returning partial results"})
                break

            for card in cards:
                job = self.extract_job(card)
                if not job or not self.validate_job(job):
                    continue
                self.jobs.append(job)
                total_found += 1
                self.sse_emit("job_found", {"job": job, "page": page_number})

            self.sse_emit("page_done", {"page": page_number, "total_found": total_found})

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": self.max_pages})


if __name__ == "__main__":
    sys.exit(main(LinkedInScraper))
