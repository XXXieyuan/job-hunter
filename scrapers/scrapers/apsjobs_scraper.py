#!/usr/bin/env python
"""
APSJobs scraper using Playwright + Salesforce Aura API interception.
APSJobs is a Salesforce Lightning SPA — job data comes via AJAX API calls.
We intercept the API response directly for reliable data extraction.
"""
import json
import re
import sys
import traceback

from .base_scraper import BaseScraper, main


def _clean(text):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


class APSJobsScraper(BaseScraper):
    BASE_URL = "https://www.apsjobs.gov.au"
    SEARCH_URL = BASE_URL + "/s/job-search"

    def build_url(self, page_number):
        keyword = self.keywords.replace(",", " ").strip()
        offset = (page_number - 1) * 24
        return f"{self.SEARCH_URL}?searchString={keyword}&offset={offset}#feed"

    def parse_salary_from_string(self, text):
        """Parse salary from any text string."""
        if not text:
            return None, None
        # Handle $130,369 - $164,925 or similar ranges
        amounts = re.findall(r"\$?([\d,]+)(?:\s*[-–]\s*\$?([\d,]+))?", text)
        if not amounts:
            return None, None
        amounts = [(int(a[0].replace(",", "")),
                    int(a[1].replace(",", "")) if a[1] else int(a[0].replace(",", "")))
                   for a in amounts]
        if len(amounts) == 1:
            return amounts[0][0], amounts[0][0]
        return min(a[0] for a in amounts), max(a[1] for a in amounts)

    def extract_jobs_from_aura_response(self, aura_body, page_number):
        """Extract jobs from Salesforce Aura API response."""
        jobs = []

        try:
            data = json.loads(aura_body)
            actions = data.get("actions", [])
        except (json.JSONDecodeError, TypeError):
            return []

        for action in actions:
            if action.get("state") != "SUCCESS":
                continue
            rv = action.get("returnValue", {})
            if isinstance(rv, str):
                try:
                    rv = json.loads(rv)
                except Exception:
                    continue
            # Navigate to returnValue.returnValue.jobListings
            rv = rv.get("returnValue", {})
            job_listings = rv.get("jobListings", [])
            if not job_listings:
                continue

            for item in job_listings:
                # applicationURL is the link to apply (our job_url)
                job_url = item.get("applicationURL", "")
                if not job_url:
                    job_id = item.get("jobId", "")
                    if job_id:
                        job_url = f"{self.BASE_URL}/job/{job_id}"

                if not job_url:
                    continue

                # jobName = title
                title = _clean(item.get("jobName", "") or item.get("jobTitle", ""))
                if not title:
                    continue

                # departmentName = company
                company = _clean(item.get("departmentName", "") or "Australian Government")

                # jobLocation = location
                location = _clean(item.get("jobLocation", "") or item.get("workLocation", ""))

                # jobSalaryFrom / jobSalaryTo
                salary_min = int(item.get("jobSalaryFrom", 0) or 0) or None
                salary_max = int(item.get("jobSalaryTo", 0) or 0) or None

                # jobClassification = APS level
                classification = _clean(item.get("jobClassification", "") or "")

                # jobPostedDate
                posted_date = item.get("jobPostedDate", "") or item.get("postedDate", "") or None

                # jobDuties = full job description
                job_description = item.get("jobDuties", "") or item.get("jobDescription", "") or title

                # jobId for external_id
                job_id = item.get("jobId", "") or ""
                external_id = job_id or item.get("vacancyNumber", "") or job_url.split("/")[-1]

                job = {
                    "external_id": f"aps-{external_id}"[:60],
                    "title": title[:200],
                    "company": company,
                    "location": location or None,
                    "salary_min": salary_min,
                    "salary_max": salary_max,
                    "salary_currency": "AUD",
                    "job_description": _clean(job_description)[:5000],
                    "job_url": job_url,
                    "posted_date": posted_date,
                    "classification": classification or None,
                }

                if self.validate_job(job):
                    jobs.append(job)

        return jobs

    def scrape(self):
        """Main scraping method using Playwright + API interception."""
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.sse_emit("warning", {
                "message": "Playwright not installed. Run: pip install playwright && python -m playwright install chromium"
            })
            self.sse_emit("done", {"jobsFound": 0, "pages": 0})
            return

        playwright = None
        browser = None
        try:
            playwright = sync_playwright().start()
            browser = playwright.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            page = browser.new_page(viewport={"width": 1280, "height": 800})
        except Exception as e:
            self.sse_emit("warning", {"message": f"Failed to launch browser: {e}"})
            self.sse_emit("done", {"jobsFound": 0, "pages": 0})
            return

        total_found = 0
        pages_scraped = 0
        def handle_response(response):
            """Capture Salesforce Aura API responses containing job data."""
            url = response.url
            if "/s/sfsites/aura" not in url:
                return
            try:
                body = response.text()
                if "jobListingCount" not in body and "jobListings" not in body:
                    return
                aura_job_data.append(body)
            except Exception:
                pass

        page.on("response", handle_response)

        try:
            for page_number in range(1, max(self.max_pages, 1) + 1):
                url = self.build_url(page_number)
                aura_job_data.clear()

                self.sse_emit("progress", {
                    "page": page_number,
                    "jobsFound": total_found,
                    "message": f"Loading page {page_number}..."
                })

                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                except Exception as e:
                    self.sse_emit("warning", {
                        "message": f"Failed to navigate to page {page_number}: {e}"
                    })
                    break

                # Poll for job data to arrive (Salesforce makes async API calls)
                import time
                deadline = time.time() + 30
                while time.time() < deadline:
                    if aura_job_data:
                        break
                    time.sleep(0.5)
                else:
                    self.sse_emit("progress", {
                        "page": page_number,
                        "jobsFound": total_found,
                        "message": "No API response received within timeout"
                    })

                if not aura_job_data:
                    break

                jobs_on_page = self.extract_jobs_from_aura_response(
                    aura_job_data[0], page_number
                )
                pages_scraped += 1

                if not jobs_on_page:
                    self.sse_emit("progress", {
                        "page": page_number,
                        "jobsFound": total_found,
                        "message": f"No jobs found on page {page_number}"
                    })
                    break

                for job in jobs_on_page:
                    self.jobs.append(job)
                    total_found += 1
                    self.sse_emit("job_found", {"job": job, "page": page_number})

                self.sse_emit("page_done", {
                    "page": page_number,
                    "total_found": total_found,
                    "message": f"Page {page_number}: found {len(jobs_on_page)} jobs"
                })

                if page_number >= self.max_pages:
                    break

        except Exception as e:
            tb = traceback.format_exc()
            self.sse_emit("warning", {"message": f"Scraping error: {e}"})
        finally:
            try:
                browser.close()
            except Exception:
                pass
            try:
                playwright.stop()
            except Exception:
                pass

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": pages_scraped})


if __name__ == "__main__":
    sys.exit(main(APSJobsScraper))
