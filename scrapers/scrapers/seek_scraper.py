#!/usr/bin/env python
import json
import re
import sys
from urllib.parse import quote_plus, urljoin, urlparse

from .base_scraper import BaseScraper, main


class SeekScraper(BaseScraper):
    BASE_URL = "https://www.seek.com.au"

    def build_url(self, keyword, page_number):
        slug = "-".join(keyword.replace(",", " ").split()).lower()
        return f"{self.BASE_URL}/{slug}-jobs?sortmode=ListedDate&page={page_number}"

    def extract_external_id(self, job_url):
        parsed = urlparse(job_url)
        if not parsed.path:
            return job_url
        return parsed.path.rstrip("/").split("/")[-1]

    def normalize_job(self, job):
        title = self.clean_text(job.get("title"))
        job_url = job.get("job_url") or ""
        if job_url and not job_url.startswith("http"):
            job_url = urljoin(self.BASE_URL, job_url)

        if not title or not job_url:
            return None

        salary_text = self.clean_text(job.get("salary_text"))
        salary_min, salary_max = self.parse_salary(salary_text)
        description = self.clean_text(job.get("job_description")) or title

        return {
            "external_id": self.extract_external_id(job_url),
            "title": title,
            "company": self.clean_text(job.get("company")) or None,
            "location": self.clean_text(job.get("location")) or None,
            "salary_text": salary_text or None,
            "salary_min": salary_min,
            "salary_max": salary_max,
            "salary_currency": "AUD",
            "job_description": description,
            "job_url": job_url,
            "posted_date": self.clean_text(job.get("posted_date")) or None,
        }

    def extract_json_scripts(self, html):
        return re.findall(
            r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
            html,
            re.I | re.S,
        )

    def parse_json_blob(self, blob):
        text = (blob or "").strip()
        if not text:
            return None

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    def extract_location_from_posting(self, posting):
        location_data = posting.get("jobLocation") or {}
        if isinstance(location_data, list):
            location_data = location_data[0] if location_data else {}

        if not isinstance(location_data, dict):
            return ""

        address = location_data.get("address") or {}
        if not isinstance(address, dict):
            return ""

        parts = [
            address.get("addressLocality"),
            address.get("addressRegion"),
            address.get("addressCountry"),
        ]
        return ", ".join(part for part in parts if part)

    def extract_salary_text_from_posting(self, posting):
        base_salary = posting.get("baseSalary")
        if not isinstance(base_salary, dict):
            return ""

        value = base_salary.get("value")
        if isinstance(value, dict):
            minimum = value.get("minValue")
            maximum = value.get("maxValue")
            if minimum and maximum:
                return f"{minimum} - {maximum}"
            if minimum:
                return str(minimum)
            if maximum:
                return str(maximum)

        return ""

    def job_from_posting(self, posting):
        if not isinstance(posting, dict):
            return None

        title = posting.get("title") or ""
        job_url = posting.get("url") or ""
        if not title or not job_url:
            return None

        organization = posting.get("hiringOrganization") or {}
        company = organization.get("name") if isinstance(organization, dict) else ""
        description = posting.get("description") or ""

        return self.normalize_job(
            {
                "title": title,
                "job_url": job_url,
                "company": company,
                "location": self.extract_location_from_posting(posting),
                "salary_text": self.extract_salary_text_from_posting(posting),
                "job_description": description,
                "posted_date": posting.get("datePosted") or "",
            }
        )

    def extract_jobs_from_jsonld(self, html):
        jobs = []

        for script_content in self.extract_json_scripts(html):
            data = self.parse_json_blob(script_content)
            if data is None:
                continue

            payloads = data if isinstance(data, list) else [data]
            for payload in payloads:
                if not isinstance(payload, dict):
                    continue

                if payload.get("@type") == "JobPosting":
                    job = self.job_from_posting(payload)
                    if job:
                        jobs.append(job)
                    continue

                if payload.get("@type") != "ItemList":
                    continue

                for item in payload.get("itemListElement", []):
                    posting = item
                    if isinstance(item, dict) and item.get("@type") != "JobPosting":
                        posting = item.get("item") or {}

                    job = self.job_from_posting(posting)
                    if job:
                        jobs.append(job)

        return jobs

    def extract_embedded_state(self, html):
        patterns = [
            r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>',
            r'window\.__SEEK_REDUX_DATA__\s*=\s*({.*?})\s*;?\s*</script>',
        ]

        for pattern in patterns:
            match = re.search(pattern, html, re.I | re.S)
            if match:
                data = self.parse_json_blob(match.group(1))
                if data is not None:
                    return data

        return None

    def iterate_job_like_objects(self, payload):
        if isinstance(payload, dict):
            title = payload.get("title") or payload.get("listingTitle")
            job_url = payload.get("url") or payload.get("jobUrl") or payload.get("absoluteUrl")
            job_id = payload.get("jobId") or payload.get("id")

            if title and (job_url or job_id):
                yield payload

            for value in payload.values():
                yield from self.iterate_job_like_objects(value)
            return

        if isinstance(payload, list):
            for item in payload:
                yield from self.iterate_job_like_objects(item)

    def extract_jobs_from_state(self, html):
        state = self.extract_embedded_state(html)
        if state is None:
            return []

        jobs = []
        seen_ids = set()

        for item in self.iterate_job_like_objects(state):
            title = item.get("title") or item.get("listingTitle") or ""
            job_url = item.get("url") or item.get("jobUrl") or item.get("absoluteUrl") or ""
            job_id = item.get("jobId") or item.get("id")

            if not job_url and job_id:
                job_url = f"{self.BASE_URL}/job/{job_id}"

            company = (
                item.get("companyName")
                or item.get("advertiserName")
                or item.get("advertiser")
                or item.get("company")
                or ""
            )
            if isinstance(company, dict):
                company = company.get("name") or company.get("description") or ""

            location = item.get("location") or item.get("locationLabel") or item.get("suburb") or ""
            if isinstance(location, dict):
                location = location.get("label") or location.get("name") or ""

            description = item.get("teaser") or item.get("description") or item.get("bulletPoints") or ""
            if isinstance(description, list):
                description = " ".join(str(entry) for entry in description if entry)

            job = self.normalize_job(
                {
                    "title": title,
                    "job_url": job_url,
                    "company": company,
                    "location": location,
                    "salary_text": item.get("salary") or item.get("salaryLabel") or item.get("salaryText") or "",
                    "job_description": description,
                    "posted_date": item.get("listedAt") or item.get("listingDate") or item.get("datePosted") or "",
                }
            )
            if not job or job["external_id"] in seen_ids:
                continue

            seen_ids.add(job["external_id"])
            jobs.append(job)

        return jobs

    def extract_cards(self, html):
        patterns = [
            re.compile(
                r'(<article[^>]+(?:data-card-type="JobCard"|data-automation="[^"]*(?:job-card|normalJob)[^"]*")[^>]*>.*?</article>)',
                re.I | re.S,
            ),
            re.compile(r'(<article[^>]*>.*?</article>)', re.I | re.S),
        ]

        for pattern in patterns:
            cards = pattern.findall(html)
            if cards:
                return cards

        return []

    def extract_card_value(self, card_html, patterns):
        for pattern in patterns:
            match = re.search(pattern, card_html, re.I | re.S)
            if match:
                return self.clean_text(match.group(1))
        return ""

    def extract_card_link(self, card_html):
        patterns = [
            r'<a[^>]+data-automation="jobTitle"[^>]+href="([^"]+)"',
            r'<a[^>]+href="([^"]+/job/[^"]+)"',
            r'<a[^>]+href="([^"]+)"[^>]*>\s*(?:<span[^>]*>)?\s*[^<]+',
        ]
        for pattern in patterns:
            match = re.search(pattern, card_html, re.I | re.S)
            if match:
                return urljoin(self.BASE_URL, match.group(1))
        return ""

    def extract_jobs_from_cards(self, html):
        jobs = []

        for card_html in self.extract_cards(html):
            job = self.normalize_job(
                {
                    "title": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobTitle"[^>]*>\s*(.*?)\s*<',
                            r'<h3[^>]*>\s*<a[^>]*>(.*?)</a>',
                            r'<a[^>]+href="[^"]+/job/[^"]+"[^>]*>(.*?)</a>',
                        ],
                    ),
                    "job_url": self.extract_card_link(card_html),
                    "company": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobCompany"[^>]*>(.*?)<',
                            r'data-automation="advertiser-name"[^>]*>(.*?)<',
                        ],
                    ),
                    "location": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobLocation"[^>]*>(.*?)<',
                            r'data-automation="job-detail-location"[^>]*>(.*?)<',
                        ],
                    ),
                    "salary_text": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobSalary"[^>]*>(.*?)<',
                            r'data-automation="job-detail-salary"[^>]*>(.*?)<',
                        ],
                    ),
                    "job_description": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobShortDescription"[^>]*>(.*?)<',
                            r'<p[^>]*>(.*?)</p>',
                        ],
                    ),
                    "posted_date": self.extract_card_value(
                        card_html,
                        [
                            r'data-automation="jobListingDate"[^>]*>(.*?)<',
                            r'<time[^>]*datetime="([^"]+)"',
                            r'<time[^>]*>(.*?)</time>',
                        ],
                    ),
                }
            )
            if job:
                jobs.append(job)

        return jobs

    def fetch_job_detail(self, job_url):
        try:
            response = self.http_get(job_url, timeout=30)
        except Exception:
            return ""

        if response.status_code >= 400:
            return ""

        detail_html = self.extract_detail_block(response.text)
        if detail_html:
            return self.clean_text(detail_html)

        postings = self.extract_jobs_from_jsonld(response.text)
        if postings:
            return postings[0].get("job_description") or ""

        article_match = re.search(r"(<article[^>]*>.*?</article>)", response.text, re.I | re.S)
        if article_match:
            return self.clean_text(article_match.group(1))

        paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", response.text, re.I | re.S)
        return self.clean_text(" ".join(paragraphs[:8]))

    def extract_detail_block(self, html):
        match = re.search(r'<div[^>]+data-automation="jobAdDetails"[^>]*>', html, re.I)
        if not match:
            return ""

        start = match.start()
        pos = match.end()
        depth = 1
        open_tag = re.compile(r"<div(?:\s|>)", re.I)
        close_tag = re.compile(r"</div>", re.I)

        while depth > 0 and pos < len(html):
            next_open = open_tag.search(html, pos)
            next_close = close_tag.search(html, pos)

            if not next_close:
                return html[start:]

            if next_open and next_open.start() < next_close.start():
                depth += 1
                pos = next_open.end()
            else:
                depth -= 1
                pos = next_close.end()

        return html[start:pos]

    def fetch_page_jobs(self, keyword, page_number):
        response = self.http_get(self.build_url(keyword, page_number), timeout=30)

        if response.status_code >= 400:
            raise RuntimeError(f"SEEK returned HTTP {response.status_code}")

        if "captcha" in response.text.lower():
            self.sse_emit("warning", {"message": "SEEK may have challenged the request"})

        jobs = self.extract_jobs_from_jsonld(response.text)
        if not jobs:
            jobs = self.extract_jobs_from_state(response.text)
        if not jobs:
            jobs = self.extract_jobs_from_cards(response.text)

        deduped_jobs = []
        seen_ids = set()
        for job in jobs:
            external_id = job.get("external_id")
            if not external_id or external_id in seen_ids:
                continue
            seen_ids.add(external_id)
            deduped_jobs.append(job)

        enriched_jobs = []
        for job in deduped_jobs:
            description = self.fetch_job_detail(job["job_url"])
            if description:
                job["job_description"] = description

            job["job_description"] = job.get("job_description") or job["title"]
            enriched_jobs.append(job)

        return enriched_jobs

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
