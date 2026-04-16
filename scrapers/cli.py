#!/usr/bin/env python3
"""CLI entry point for the job-hunter scrapers.

Usage::

    python -m scrapers.cli --platform seek --keywords "data analyst" \\
        --location "Canberra" --max-pages 3

Outputs JSON Lines to stdout.  Status/error messages go to stderr.
Exit code 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import sys
import time
import json

VALID_PLATFORMS = ("linkedin", "seek", "apsjobs", "actgov", "nswgov")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scrapers",
        description="Job Hunter — multi-platform job scraper CLI",
    )
    parser.add_argument(
        "--platform",
        required=True,
        choices=VALID_PLATFORMS,
        help="Target job platform",
    )
    parser.add_argument(
        "--keywords",
        required=True,
        help="Search keywords (e.g. 'data analyst')",
    )
    parser.add_argument(
        "--location",
        default="",
        help="Location filter (e.g. 'Canberra')",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=5,
        help="Maximum number of result pages to scrape (default: 5)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Per-request timeout in seconds (default: 30)",
    )
    return parser


def _load_adapter(platform: str):
    """Lazily import the adapter for *platform*."""
    if platform == "linkedin":
        from scrapers.adapters.linkedin import LinkedInScraper
        return LinkedInScraper
    elif platform == "seek":
        from scrapers.adapters.seek import SeekScraper
        return SeekScraper
    elif platform == "apsjobs":
        from scrapers.adapters.apsjobs import APSJobsScraper
        return APSJobsScraper
    elif platform == "actgov":
        from scrapers.adapters.actgov import ActGovScraper
        return ActGovScraper
    elif platform == "nswgov":
        from scrapers.adapters.nswgov import NswGovScraper
        return NswGovScraper
    else:
        raise ValueError(f"Unknown platform: {platform}")


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    config = {
        "keywords": args.keywords,
        "location": args.location,
        "max_pages": args.max_pages,
        "timeout": args.timeout,
    }

    print(f"[start] platform={args.platform} keywords={args.keywords!r} "
          f"location={args.location!r} max_pages={args.max_pages}",
          file=sys.stderr, flush=True)

    start = time.monotonic()

    try:
        AdapterClass = _load_adapter(args.platform)
        adapter = AdapterClass(config=config)
        jobs = adapter.scrape()
    except Exception as exc:
        print(f"[error] {exc!r}", file=sys.stderr, flush=True)
        error_envelope = json.dumps(
            {"type": "status", "data": {"phase": "error", "message": str(exc)}},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        print(error_envelope, flush=True)
        return 1

    elapsed = time.monotonic() - start
    print(f"[complete] {len(jobs)} jobs scraped in {elapsed:.1f}s",
          file=sys.stderr, flush=True)

    complete_envelope = json.dumps(
        {
            "type": "status",
            "data": {
                "phase": "complete",
                "jobs_found": len(jobs),
                "duration_seconds": round(elapsed, 1),
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    print(complete_envelope, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
