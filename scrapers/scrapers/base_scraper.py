#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import time
from html import unescape

CURRENT_DIR = os.path.dirname(__file__)
PARENT_DIR = os.path.dirname(CURRENT_DIR)
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

try:
    from curl_cffi import requests as curl_requests

    USING_CURL_CFFI = True
except ImportError:
    import requests as curl_requests

    USING_CURL_CFFI = False


class BaseScraper:
    REQUEST_TIMEOUT = 30
    IMPERSONATE_BROWSER = "chrome110"

    def __init__(self, source, keywords, max_pages, history_id):
        self.source = source
        self.keywords = keywords
        self.max_pages = max_pages
        self.history_id = history_id
        self.jobs = []

    def sse_emit(self, event_type, data):
        payload = {"type": event_type, **(data or {})}
        print(f"data: {json.dumps(payload, ensure_ascii=False)}\n", flush=True)

    def rate_limit(self, delay=1.0):
        time.sleep(delay)

    def parse_salary(self, text):
        content = text or ""
        numbers = []

        for match in re.finditer(r"\$?\s?(\d+(?:\.\d+)?)\s*([kK])?", content):
            value = float(match.group(1))
            if match.group(2):
                value *= 1000
            numbers.append(int(value))

        if not numbers:
            return None, None

        if len(numbers) == 1:
            return numbers[0], numbers[0]

        return min(numbers[:2]), max(numbers[:2])

    def clean_text(self, text):
        content = unescape(text or "")
        content = re.sub(r"<[^>]+>", " ", content)
        content = re.sub(r"\s+", " ", content)
        return content.strip()

    def get_default_headers(self):
        return {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/123.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-AU,en;q=0.9",
        }

    def build_request_kwargs(self, timeout=None, **kwargs):
        request_kwargs = dict(kwargs)
        request_kwargs.setdefault("timeout", timeout or self.REQUEST_TIMEOUT)
        if USING_CURL_CFFI:
            request_kwargs.setdefault("impersonate", self.IMPERSONATE_BROWSER)
        return request_kwargs

    def get_session(self):
        session = curl_requests.Session()
        session.headers.update(self.get_default_headers())
        return session

    def session_get(self, session, url, timeout=None, **kwargs):
        return session.get(url, **self.build_request_kwargs(timeout=timeout, **kwargs))

    def session_post(self, session, url, timeout=None, **kwargs):
        return session.post(url, **self.build_request_kwargs(timeout=timeout, **kwargs))

    def http_get(self, url, timeout=None, **kwargs):
        session = self.get_session()
        return self.session_get(session, url, timeout=timeout, **kwargs)

    def http_post(self, url, timeout=None, **kwargs):
        session = self.get_session()
        return self.session_post(session, url, timeout=timeout, **kwargs)

    def validate_job(self, job):
        required_fields = ["title", "job_url", "job_description"]
        return all(job.get(field) for field in required_fields)

    def scrape(self):
        raise NotImplementedError("Subclasses must implement scrape()")


def parse_args():
    parser = argparse.ArgumentParser(description="Base scraper utilities")
    parser.add_argument("--source")
    parser.add_argument("--keywords", default="")
    parser.add_argument("--max_pages", type=int, default=1)
    parser.add_argument("--history_id", default="")
    return parser


def main(scraper_class=None):
    parser = parse_args()
    args = parser.parse_args()

    if scraper_class is None:
        return 0

    scraper = scraper_class(
        source=args.source,
        keywords=args.keywords,
        max_pages=args.max_pages,
        history_id=args.history_id,
    )

    try:
        scraper.scrape()
        return 0
    except Exception as error:
        scraper.sse_emit("error", {"message": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
