#!/usr/bin/env python
import argparse
import sys

from scrapers.apsjobs_scraper import APSJobsScraper
from scrapers.base_scraper import BaseScraper
from scrapers.linkedin_scraper import LinkedInScraper
from scrapers.seek_scraper import SeekScraper


SCRAPERS = {
    "seek": SeekScraper,
    "linkedin": LinkedInScraper,
    "apsjobs": APSJobsScraper,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Run a Job Hunter scraper")
    parser.add_argument("--source", choices=SCRAPERS.keys(), required=True)
    parser.add_argument("--keywords", default="")
    parser.add_argument("--max_pages", type=int, default=1)
    parser.add_argument("--history_id", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    scraper_class = SCRAPERS[args.source]
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
