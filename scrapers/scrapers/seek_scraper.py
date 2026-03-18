#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from urllib.parse import quote_plus

from .base_scraper import BaseScraper, main


class SeekScraper(BaseScraper):
    def build_url(self, keyword, page_number):
        slug = quote_plus(keyword.replace(",", " ").strip()).replace("+", "-")
        return f"https://www.seek.com.au/{slug}/jobs?sortmode=ListedDate&page={page_number}"

    def fetch_page_jobs(self, keyword, page_number):
        helper_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "helpers", "seek_playwright.cjs"
        )
        command = [
            "node",
            helper_path,
            "--keyword",
            keyword,
            "--page",
            str(page_number),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)

        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "SEEK helper failed")

        payload = json.loads(result.stdout or "{}")
        if payload.get("warning"):
            self.sse_emit("warning", {"message": payload["warning"]})

        return payload.get("jobs", [])

    def scrape(self):
        total_found = 0

        for page_number in range(1, max(self.max_pages, 1) + 1):
            self.rate_limit(1.0)

            try:
                jobs = self.fetch_page_jobs(self.keywords, page_number)
            except Exception as error:
                self.sse_emit("warning", {"message": str(error)})
                break

            if not jobs:
                break

            for job in jobs:
                if not self.validate_job(job):
                    continue
                self.jobs.append(job)
                total_found += 1
                self.sse_emit("job_found", {"job": job, "page": page_number})

            self.sse_emit("page_done", {"page": page_number, "total_found": total_found})

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": self.max_pages})


if __name__ == "__main__":
    sys.exit(main(SeekScraper))
