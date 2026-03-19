#!/usr/bin/env python
import re
import sys
from urllib.parse import quote_plus, urljoin

from .base_scraper import BaseScraper, main


class APSJobsScraper(BaseScraper):
    BASE_URL = "https://www.apsjobs.gov.au"

    def build_url(self, page_number):
        return (
            f"{self.BASE_URL}/s/search-jobs?keywords={quote_plus(self.keywords)}"
            f"&page={page_number}"
        )

    def extract_rows(self, html):
        patterns = [
            re.compile(r"(<tr[^>]*>.*?</tr>)", re.I | re.S),
            re.compile(r"(<article[^>]*>.*?</article>)", re.I | re.S),
        ]

        for pattern in patterns:
            rows = pattern.findall(html)
            if rows:
                return rows

        return []

    def extract_job(self, row_html):
        link_match = re.search(r'href="([^"]+)"[^>]*>(.*?)</a>', row_html, re.I | re.S)
        if not link_match:
            return None

        href = urljoin(self.BASE_URL, link_match.group(1))
        title = self.clean_text(link_match.group(2))
        cells = [self.clean_text(cell) for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, re.I | re.S)]
        classification = next((cell for cell in cells if re.search(r"\bAPS\b|\bEL\b|\bSES\b", cell, re.I)), "")
        location = next((cell for cell in cells if any(marker in cell for marker in ["ACT", "NSW", "VIC", "QLD", "WA", "SA", "TAS", "NT"])), "")
        salary_text = next((cell for cell in cells if "$" in cell), "")
        posted_date = next((cell for cell in cells if re.search(r"\d{1,2}\s+\w+\s+\d{4}", cell)), "")
        salary_min, salary_max = self.parse_salary(salary_text)
        description = self.fetch_job_detail(href) or title
        external_id = href.rstrip("/").split("/")[-1]

        return {
            "external_id": external_id,
            "title": title,
            "company": "APSJobs",
            "location": location or None,
            "salary_min": salary_min,
            "salary_max": salary_max,
            "salary_currency": "AUD",
            "job_description": description,
            "job_url": href,
            "posted_date": posted_date or None,
            "classification": classification or None,
        }

    def fetch_job_detail(self, job_url):
        try:
            response = self.http_get(job_url, timeout=30)
        except Exception:
            return ""

        if response.status_code >= 400:
            return ""

        detail_match = re.search(
            r'(<div[^>]+class="[^"]*(?:job-description|rich-text|details)[^"]*"[^>]*>.*?</div>)',
            response.text,
            re.I | re.S,
        )
        if detail_match:
            return self.clean_text(detail_match.group(1))

        paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", response.text, re.I | re.S)
        return self.clean_text(" ".join(paragraphs[:8]))

    def scrape(self):
        session = self.get_session()
        total_found = 0

        for page_number in range(1, max(self.max_pages, 1) + 1):
            self.rate_limit(1.0)
            try:
                response = self.session_get(session, self.build_url(page_number), timeout=30)
            except Exception as error:
                self.sse_emit("warning", {"message": f"APSJobs request failed: {error}"})
                break

            if response.status_code >= 400:
                self.sse_emit("warning", {"message": f"APSJobs returned HTTP {response.status_code}"})
                break

            rows = self.extract_rows(response.text)
            if not rows:
                break

            for row in rows:
                job = self.extract_job(row)
                if not job or not self.validate_job(job):
                    continue
                self.jobs.append(job)
                total_found += 1
                self.sse_emit("job_found", {"job": job, "page": page_number})

            self.sse_emit("page_done", {"page": page_number, "total_found": total_found})

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": self.max_pages})


if __name__ == "__main__":
    sys.exit(main(APSJobsScraper))
