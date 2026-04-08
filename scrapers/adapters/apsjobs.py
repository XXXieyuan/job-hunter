"""APSJobs (Australian Public Service) adapter.

Targets the Salesforce Aura REST API that powers the APSJobs
Salesforce Lightning SPA, rather than scraping rendered HTML.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from scrapers.base import BaseScraper
from scrapers.models import JobRecord

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_APSJOBS_BASE = "https://www.apsjobs.gov.au"
_SEARCH_PAGE_URL = _APSJOBS_BASE + "/s/job-search"
_AURA_ENDPOINT = _APSJOBS_BASE + "/s/sfsites/aura"
_JOB_DETAIL_URL = _APSJOBS_BASE + "/s/job-details/{reference}"

# APS classification levels (used for normalisation)
_APS_LEVELS = [
    "APS1", "APS2", "APS3", "APS4", "APS5", "APS6",
    "EL1", "EL2",
    "SES1", "SES2", "SES3",
]

_APS_CLASS_RE = re.compile(
    r"\b(APS\s*[1-6]|EL\s*[12]|SES\s*[1-3]|Executive\s+Level\s+[12]"
    r"|Senior\s+Executive\s+Service)\b",
    re.IGNORECASE,
)

# Visa / citizenship requirement patterns
_VISA_PATTERNS = [
    (re.compile(r"australian\s+citizen(?:s|ship)?\s+only", re.I), "citizens_only"),
    (re.compile(r"must\s+be\s+an?\s+australian\s+citizen", re.I), "citizens_only"),
    (re.compile(r"australian\s+citizenship\s+(?:is\s+)?(?:a\s+)?requirement", re.I), "citizens_only"),
    (re.compile(r"eligible\s+to\s+obtain.*?security\s+clearance", re.I), "citizens_only"),
    (re.compile(r"permanent\s+resident", re.I), "pr_required"),
    (re.compile(r"australian\s+(?:citizen|permanent\s+resident)", re.I), "pr_required"),
    (re.compile(r"visa\s+holders?\s+(?:welcome|encouraged|may\s+apply)", re.I), "visa_holders_welcome"),
]


def _extract_visa_requirement(text: str) -> str | None:
    """Detect visa/citizenship requirements from job description text."""
    if not text:
        return None
    for pattern, category in _VISA_PATTERNS:
        if pattern.search(text):
            return category
    # Most APS jobs require citizenship by default
    if re.search(r"\bAPS\b|\bEL\b|\bSES\b|Australian Public Service", text, re.I):
        return "citizens_only"
    return None


def _normalise_classification(raw: str | None) -> str | None:
    """Normalise an APS classification string to standard format."""
    if not raw:
        return None
    # Try direct match
    m = _APS_CLASS_RE.search(raw)
    if not m:
        return raw.strip() if raw.strip() else None
    matched = m.group(1)
    # Normalise spacing: "APS 4" -> "APS4", "EL 1" -> "EL1"
    normalised = re.sub(r"\s+", "", matched).upper()
    # Handle long-form
    normalised = normalised.replace("EXECUTIVELEVEL", "EL").replace("SENIOREXECUTIVESERVICE", "SES")
    return normalised


class APSJobsScraper(BaseScraper):
    """APSJobs.gov.au scraper using the Salesforce Aura REST API."""

    def __init__(self, config: dict[str, Any]) -> None:
        # APSJobs is rate-limited more conservatively
        config.setdefault("rpm", 8)
        super().__init__(platform="apsjobs", config=config)
        self._aura_token: str | None = None
        self._fwuid: str | None = None

    # ------------------------------------------------------------------
    # Aura context extraction
    # ------------------------------------------------------------------

    def _fetch_aura_context(self) -> bool:
        """Fetch the search page to extract Aura token and framework UID.

        Returns True if context was successfully extracted.
        """
        self._emit_status("progress", "Fetching APSJobs search page for Aura context...")

        try:
            html = self._request(_SEARCH_PAGE_URL)
        except Exception as exc:
            self._emit_status("error", f"Failed to fetch search page: {exc!r}")
            return False

        # Extract Aura token from page source
        # Pattern: "token":"<value>" or auraConfig.token = "<value>"
        token_match = re.search(r'"token"\s*:\s*"([^"]+)"', html)
        if not token_match:
            token_match = re.search(r"auraConfig\.token\s*=\s*['\"]([^'\"]+)", html)
        if token_match:
            self._aura_token = token_match.group(1)

        # Extract framework UID
        fwuid_match = re.search(r'"fwuid"\s*:\s*"([^"]+)"', html)
        if not fwuid_match:
            fwuid_match = re.search(r"auraConfig\.fwuid\s*=\s*['\"]([^'\"]+)", html)
        if fwuid_match:
            self._fwuid = fwuid_match.group(1)

        if not self._aura_token:
            # Public Salesforce Experience Cloud pages accept "undefined" as
            # the Aura token for guest/unauthenticated requests.
            self._aura_token = "undefined"

        self._emit_status("progress", "Aura context extracted successfully.")
        return True

    # ------------------------------------------------------------------
    # Aura API requests
    # ------------------------------------------------------------------

    def _aura_search(self, page_num: int = 0, page_size: int = 25) -> dict | None:
        """Execute an Aura search request for job listings.

        Returns the parsed JSON response or None on failure.
        """
        # Build the Aura action message
        message = {
            "actions": [
                {
                    "id": f"{page_num + 1};a",
                    "descriptor": "apex://APSJobSearchController/ACTION$getJobListings",
                    "callingDescriptor": "UNKNOWN",
                    "params": {
                        "keyword": self.keywords or "",
                        "location": self.location or "",
                        "classification": "",
                        "pageNumber": page_num,
                        "pageSize": page_size,
                    },
                }
            ]
        }

        payload = {
            "message": json.dumps(message, separators=(",", ":")),
            "aura.context": json.dumps(
                {
                    "mode": "PROD",
                    "fwuid": self._fwuid or "",
                    "app": "siteforce:communityApp",
                    "loaded": {},
                    "dn": [],
                    "globals": {},
                    "uad": False,
                },
                separators=(",", ":"),
            ),
            "aura.token": self._aura_token or "",
        }

        try:
            resp_text = self._request(
                _AURA_ENDPOINT,
                method="POST",
                data=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Accept": "*/*",
                    "Referer": _SEARCH_PAGE_URL,
                    "Origin": _APSJOBS_BASE,
                },
            )
        except Exception as exc:
            self._emit_status("error", f"Aura search request failed: {exc!r}")
            return None

        try:
            return json.loads(resp_text)
        except json.JSONDecodeError as exc:
            self._emit_status("error", f"Failed to parse Aura response: {exc!r}")
            return None

    def _aura_job_detail(self, reference: str) -> dict | None:
        """Fetch full job details via the Aura API.

        Returns the parsed job detail dict or None on failure.
        """
        message = {
            "actions": [
                {
                    "id": "1;a",
                    "descriptor": "apex://APSJobSearchController/ACTION$getJobDetail",
                    "callingDescriptor": "UNKNOWN",
                    "params": {
                        "referenceNumber": reference,
                    },
                }
            ]
        }

        payload = {
            "message": json.dumps(message, separators=(",", ":")),
            "aura.context": json.dumps(
                {
                    "mode": "PROD",
                    "fwuid": self._fwuid or "",
                    "app": "siteforce:communityApp",
                    "loaded": {},
                    "dn": [],
                    "globals": {},
                    "uad": False,
                },
                separators=(",", ":"),
            ),
            "aura.token": self._aura_token or "",
        }

        try:
            resp_text = self._request(
                _AURA_ENDPOINT,
                method="POST",
                data=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Accept": "*/*",
                    "Referer": f"{_APSJOBS_BASE}/s/job-details/{reference}",
                    "Origin": _APSJOBS_BASE,
                },
            )
        except Exception as exc:
            self._emit_status("error", f"Failed to fetch detail for {reference}: {exc!r}")
            return None

        try:
            data = json.loads(resp_text)
        except json.JSONDecodeError:
            return None

        # Navigate Aura response structure to find the job detail
        return self._extract_action_result(data)

    # ------------------------------------------------------------------
    # Response parsing helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_action_result(aura_response: dict) -> dict | None:
        """Extract the returnValue from the first successful Aura action."""
        actions = aura_response.get("actions", [])
        for action in actions:
            state = action.get("state", "")
            if state == "SUCCESS":
                return action.get("returnValue")
        return None

    @staticmethod
    def _extract_job_listings(aura_response: dict) -> tuple[list[dict], int]:
        """Extract job listing dicts and total count from an Aura search response.

        Returns (listings, total_count).
        """
        actions = aura_response.get("actions", [])
        for action in actions:
            if action.get("state") != "SUCCESS":
                continue
            rv = action.get("returnValue")
            if rv is None:
                continue

            # The response structure may vary; handle common patterns
            if isinstance(rv, dict):
                listings = rv.get("jobListings") or rv.get("records") or rv.get("jobs") or []
                total = rv.get("totalCount") or rv.get("totalRecords") or len(listings)
                return listings, int(total)
            elif isinstance(rv, list):
                return rv, len(rv)

        return [], 0

    def _parse_listing(self, listing: dict) -> dict:
        """Parse a single job listing dict from the Aura response into our field map."""
        # Field names from Salesforce may use various casing conventions
        def _get(*keys: str, default: Any = "") -> Any:
            for k in keys:
                val = listing.get(k)
                if val is not None:
                    return val
            return default

        return {
            "reference": _get("Reference_Number__c", "referenceNumber", "ReferenceNumber", "reference", default=""),
            "title": _get("Title__c", "title", "Name", "jobTitle", default=""),
            "agency": _get("Agency__c", "agency", "Department__c", "department", "organisationName", default=""),
            "location": _get("Location__c", "location", "jobLocation", default=""),
            "classification": _get("Classification__c", "classification", "apsClassification", default=""),
            "closes_at": _get("Closing_Date__c", "closingDate", "closesAt", default=None),
            "posted_at": _get("Opening_Date__c", "openingDate", "postedAt", "datePosted", default=None),
            "salary_min": _get("Salary_Min__c", "salaryMin", default=None),
            "salary_max": _get("Salary_Max__c", "salaryMax", default=None),
            "work_type": _get("Work_Type__c", "workType", "employmentType", default=None),
            "description_snippet": _get("Description__c", "description", "snippet", default=""),
        }

    # ------------------------------------------------------------------
    # Main scrape method
    # ------------------------------------------------------------------

    def scrape(self) -> list[dict]:
        """Scrape APSJobs via the Salesforce Aura API."""
        all_jobs: list[dict] = []
        jobs_found = 0

        self._emit_status("started", f"APSJobs scrape: keywords={self.keywords!r}, location={self.location!r}")

        # Step 1: Fetch Aura context (token + fwuid)
        if not self._fetch_aura_context():
            self._emit_status("error", "Aborting: could not obtain Aura context.")
            return all_jobs

        page_size = 25

        for page in range(self.max_pages):
            self._emit_status("progress", f"Fetching APSJobs page {page + 1}...")

            # Step 2: Search via Aura API
            response = self._aura_search(page_num=page, page_size=page_size)
            if not response:
                self._emit_status("error", f"No response for page {page + 1}, stopping.")
                break

            listings, total_count = self._extract_job_listings(response)

            if not listings:
                self._emit_status("info", f"No listings on page {page + 1}, stopping.")
                break

            self._emit_status("progress", f"Page {page + 1}: {len(listings)} listings (total available: {total_count})")

            for listing in listings:
                parsed = self._parse_listing(listing)
                reference = parsed["reference"]

                if not reference:
                    self._emit_status("warning", "Skipping listing with no reference number.")
                    continue

                # Step 3: Fetch full detail for each job
                detail_data = self._aura_job_detail(reference)
                description = ""
                raw_json = json.dumps(listing, ensure_ascii=False)

                if detail_data:
                    # Merge detail data
                    if isinstance(detail_data, dict):
                        description = (
                            detail_data.get("Description__c")
                            or detail_data.get("fullDescription")
                            or detail_data.get("description")
                            or parsed["description_snippet"]
                            or ""
                        )
                        raw_json = json.dumps(detail_data, ensure_ascii=False)
                else:
                    description = parsed["description_snippet"]

                # Extract visa requirement from description
                visa_req = _extract_visa_requirement(description)

                # Normalise classification
                classification = _normalise_classification(parsed["classification"])

                # Parse salary values
                sal_min = None
                sal_max = None
                if parsed["salary_min"] is not None:
                    try:
                        sal_min = int(float(parsed["salary_min"]))
                    except (ValueError, TypeError):
                        pass
                if parsed["salary_max"] is not None:
                    try:
                        sal_max = int(float(parsed["salary_max"]))
                    except (ValueError, TypeError):
                        pass

                # Build job URL
                job_url = f"{_APSJOBS_BASE}/s/job-details/{reference}"

                # Normalise work type
                work_type = parsed.get("work_type")
                if work_type:
                    wt_lower = work_type.strip().lower()
                    wt_map = {
                        "full time": "full-time",
                        "full-time": "full-time",
                        "part time": "part-time",
                        "part-time": "part-time",
                        "non-ongoing": "contract",
                        "contract": "contract",
                        "casual": "casual",
                    }
                    work_type = wt_map.get(wt_lower, wt_lower)

                # Build salary string from min/max
                salary_str = None
                if sal_min is not None and sal_max is not None:
                    salary_str = f"${sal_min:,} - ${sal_max:,}"
                elif sal_min is not None:
                    salary_str = f"${sal_min:,}+"
                elif sal_max is not None:
                    salary_str = f"Up to ${sal_max:,}"

                job = JobRecord(
                    external_id=f"aps-{reference}",
                    platform="apsjobs",
                    title=parsed["title"],
                    company=parsed["agency"],
                    location=parsed["location"],
                    description=description,
                    url=job_url,
                    salary=salary_str,
                    salary_min=sal_min,
                    salary_max=sal_max,
                    work_type=work_type,
                    visa_requirement=visa_req,
                    classification=classification,
                    closes_at=parsed["closes_at"],
                    posted_at=parsed["posted_at"],
                    raw_json=raw_json,
                )

                try:
                    self._emit_job(job)
                    all_jobs.append(job.to_dict())
                    jobs_found += 1
                except Exception as exc:
                    self._emit_status("error", f"Failed to emit job {reference}: {exc!r}")

            # Check if we've fetched all available results
            if (page + 1) * page_size >= total_count:
                self._emit_status("info", "All available listings fetched.")
                break

        self._emit_status("completed", f"APSJobs scrape complete: {jobs_found} jobs found.")
        return all_jobs
