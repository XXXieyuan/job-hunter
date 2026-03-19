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
        """Main scraping method using curl_cffi + Salesforce Aura API."""
        try:
            from curl_cffi import requests as curl_requests
            from urllib.parse import quote_plus
        except ImportError as error:
            self.sse_emit("warning", {
                "message": f"curl_cffi not installed: {error}"
            })
            self.sse_emit("done", {"jobsFound": 0, "pages": 0})
            return

        def normalize_aura_body(raw_body):
            body = (raw_body or "").strip()
            for prefix in ("while(1);", "for(;;);"):
                if body.startswith(prefix):
                    body = body[len(prefix):].lstrip()
            return body

        def extract_total_count(aura_body):
            try:
                data = json.loads(aura_body)
            except (json.JSONDecodeError, TypeError):
                return None

            for action in data.get("actions", []):
                if action.get("state") != "SUCCESS":
                    continue

                return_value = action.get("returnValue", {})
                if isinstance(return_value, str):
                    try:
                        return_value = json.loads(return_value)
                    except Exception:
                        continue

                if not isinstance(return_value, dict):
                    continue

                return_value = return_value.get("returnValue", {})
                if not isinstance(return_value, dict):
                    continue

                job_listing_count = return_value.get("jobListingCount")
                if job_listing_count is None:
                    continue

                try:
                    return int(job_listing_count)
                except (TypeError, ValueError):
                    continue

            return None

        keyword = self.keywords.replace(",", " ").strip()
        total_found = 0
        pages_scraped = 0
        known_total = None
        page_size = 24
        aura_url = f"{self.BASE_URL}/s/sfsites/aura?r=5&aura.ApexAction.execute=1"
        session = None

        self.sse_emit("progress", {
            "page": 0,
            "jobsFound": 0,
            "message": "Initializing APSJobs session..."
        })

        try:
            session = curl_requests.Session(impersonate="chrome120")
            session.headers.update(self.get_default_headers())

            main_response = session.get(self.SEARCH_URL, timeout=self.REQUEST_TIMEOUT)
            if main_response.status_code >= 400:
                self.sse_emit("warning", {
                    "message": f"APSJobs main page returned HTTP {main_response.status_code}"
                })
                self.sse_emit("done", {"jobsFound": 0, "pages": 0})
                return

            html = main_response.text
            fwuid_match = re.search(r'"fwuid"\s*:\s*"([^"]+)"', html)
            app_id_match = re.search(
                r'"APPLICATION@markup://siteforce:communityApp"\s*:\s*"([^"]+)"',
                html,
            )

            if not fwuid_match or not app_id_match:
                self.sse_emit("warning", {
                    "message": "Failed to extract APSJobs Aura metadata from main page"
                })
                self.sse_emit("done", {"jobsFound": 0, "pages": 0})
                return

            fwuid = fwuid_match.group(1)
            app_id = app_id_match.group(1)

            self.sse_emit("progress", {
                "page": 0,
                "jobsFound": 0,
                "message": "Aura metadata extracted; fetching job pages..."
            })

            for page_number in range(1, max(self.max_pages, 1) + 1):
                offset = (page_number - 1) * page_size
                if known_total is not None and offset >= known_total:
                    break

                filter_payload = {
                    "searchString": keyword,
                    "salaryFrom": None,
                    "salaryTo": None,
                    "closingDate": None,
                    "positionInitiative": None,
                    "classification": None,
                    "securityClearance": None,
                    "officeArrangement": None,
                    "duration": None,
                    "department": None,
                    "category": None,
                    "opportunityType": None,
                    "employmentStatus": None,
                    "state": None,
                    "sortBy": None,
                    "offset": offset,
                    "offsetIsLimit": False,
                    "lastVisitedId": None,
                    "daysInPast": None,
                    "name": None,
                    "type": None,
                    "notificationsEnabled": None,
                    "savedSearchId": None,
                }
                message_payload = {
                    "actions": [
                        {
                            "id": f"{123 + page_number};a",
                            "descriptor": "aura://ApexActionController/ACTION$execute",
                            "callingDescriptor": "UNKNOWN",
                            "params": {
                                "namespace": "",
                                "classname": "aps_jobSearchController",
                                "method": "retrieveJobListings",
                                "params": {
                                    "filter": json.dumps(filter_payload, separators=(",", ":")),
                                    "cacheable": False,
                                    "isContinuation": False,
                                },
                            },
                        }
                    ]
                }
                aura_context = {
                    "mode": "PROD",
                    "fwuid": fwuid,
                    "app": "siteforce:communityApp",
                    "loaded": {
                        "APPLICATION@markup://siteforce:communityApp": app_id,
                    },
                    "dn": [],
                    "globals": {},
                    "uad": True,
                }
                page_uri = (
                    f"/s/job-search?searchString={quote_plus(keyword)}"
                    f"&offset={offset}#feed"
                )

                self.sse_emit("progress", {
                    "page": page_number,
                    "jobsFound": total_found,
                    "message": f"Fetching APSJobs page {page_number} (offset {offset})..."
                })

                response = session.post(
                    aura_url,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Origin": self.BASE_URL,
                        "Referer": f"{self.SEARCH_URL}?searchString={quote_plus(keyword)}&offset={offset}",
                    },
                    data={
                        "message": json.dumps(message_payload, separators=(",", ":")),
                        "aura.context": json.dumps(aura_context, separators=(",", ":")),
                        "aura.pageURI": page_uri,
                        "aura.token": "null",
                    },
                    timeout=self.REQUEST_TIMEOUT,
                )

                if response.status_code >= 400:
                    self.sse_emit("warning", {
                        "message": f"APSJobs Aura API returned HTTP {response.status_code} on page {page_number}"
                    })
                    break

                aura_body = normalize_aura_body(response.text)
                page_total = extract_total_count(aura_body)
                if page_total is not None:
                    known_total = page_total
                jobs_on_page = self.extract_jobs_from_aura_response(aura_body, page_number)
                pages_scraped += 1

                if known_total == 0 or not jobs_on_page:
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

                total_label = f" of {known_total}" if known_total is not None else ""
                self.sse_emit("page_done", {
                    "page": page_number,
                    "total_found": total_found,
                    "message": f"Page {page_number}: found {len(jobs_on_page)} jobs (total {total_found}{total_label})"
                })

                if known_total is not None and offset + page_size >= known_total:
                    break

                self.rate_limit(0.5)

        except Exception as error:
            traceback.format_exc()
            self.sse_emit("warning", {"message": f"Scraping error: {error}"})
        finally:
            if session is not None:
                try:
                    session.close()
                except Exception:
                    pass

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": pages_scraped})


if __name__ == "__main__":
    sys.exit(main(APSJobsScraper))
