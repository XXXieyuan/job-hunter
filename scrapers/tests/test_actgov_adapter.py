"""Unit tests for scrapers.adapters.actgov module.

Tests RSS parsing, HTML tile extraction, salary parsing, visa detection,
classification mapping, external_id generation, error handling, and
RSS truncation warnings.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from scrapers.adapters.actgov import (
    ActGovScraper,
    _detect_visa_requirement,
    _extract_work_type,
    _parse_iso_date,
    _parse_rss_date,
    parse_salary,
)
from scrapers.models import JobRecord


# ---------------------------------------------------------------------------
# Fixtures: mock RSS and HTML content
# ---------------------------------------------------------------------------

MOCK_RSS_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ACT Government Jobs</title>
    <item>
      <title>Senior Policy Officer ASO 6</title>
      <link>https://jobs.act.gov.au/opportunities/12345</link>
      <description>The Health Directorate is seeking an experienced policy officer. Australian citizen required.</description>
      <pubDate>Mon, 14 Apr 2026 00:00:00 +1000</pubDate>
      <guid>https://jobs.act.gov.au/opportunities/12345</guid>
    </item>
    <item>
      <title>Administrative Assistant ASO 3</title>
      <link>https://jobs.act.gov.au/opportunities/12346</link>
      <description>General admin role in CMTEDD. Permanent resident or citizen.</description>
      <pubDate>Tue, 15 Apr 2026 00:00:00 +1000</pubDate>
      <guid>https://jobs.act.gov.au/opportunities/12346</guid>
    </item>
    <item>
      <title>Registered Nurse HSO 5</title>
      <link>https://jobs.act.gov.au/opportunities/12347</link>
      <description>Nursing position at Canberra Hospital.</description>
      <pubDate>Wed, 16 Apr 2026 00:00:00 +1000</pubDate>
      <guid>https://jobs.act.gov.au/opportunities/12347</guid>
    </item>
  </channel>
</rss>
"""

MOCK_HTML_LISTINGS = """\
<html>
<body>
<div class="job-listings">
  <div class="job-tile" data-salary="92000" data-closingdate="2026-04-30" data-advertiseddate="2026-04-14" data-classification="ASO 6" data-directorate="Health">
    <h3><a href="/opportunities/12345">Senior Policy Officer ASO 6</a></h3>
    <span class="directorate">Health</span>
    <span>Full-time</span>
  </div>
  <div class="job-tile" data-salary="72000" data-closingdate="2026-05-01" data-advertiseddate="2026-04-15" data-classification="ASO 3" data-directorate="Chief Minister, Treasury and Economic Development Directorate">
    <h3><a href="/opportunities/12346">Administrative Assistant ASO 3</a></h3>
    <span>Part-time</span>
  </div>
  <div class="job-tile" data-salary="$85,000 - $95,000" data-closingdate="30/04/2026" data-advertiseddate="2026-04-16" data-classification="HSO 5">
    <h3><a href="/opportunities/12347">Registered Nurse HSO 5</a></h3>
    <span>Full time</span>
  </div>
</div>
</body>
</html>
"""

MOCK_HTML_NO_TILES = """\
<html><body><div class="content"><p>No jobs available.</p></div></body></html>
"""


# ---------------------------------------------------------------------------
# Salary parsing tests
# ---------------------------------------------------------------------------

class TestParseSalary:
    """Test the parse_salary function with various input formats."""

    def test_raw_integer(self) -> None:
        """data-salary raw integer → salary_min = salary_max = value."""
        lo, hi, fmt = parse_salary("92000")
        assert lo == 92000
        assert hi == 92000
        assert "$92,000" in fmt

    def test_raw_integer_large(self) -> None:
        lo, hi, fmt = parse_salary("145000")
        assert lo == 145000
        assert hi == 145000

    def test_range_with_dollar_dash(self) -> None:
        lo, hi, fmt = parse_salary("$85,000 - $95,000")
        assert lo == 85000
        assert hi == 95000
        assert "$85,000 - $95,000" == fmt

    def test_range_with_to(self) -> None:
        lo, hi, fmt = parse_salary("$70,000 to $80,000")
        assert lo == 70000
        assert hi == 80000

    def test_single_value_pa(self) -> None:
        lo, hi, fmt = parse_salary("$92,000 pa")
        assert lo == 92000
        assert hi == 92000

    def test_single_value_per_annum(self) -> None:
        lo, hi, fmt = parse_salary("$92,000 per annum")
        assert lo == 92000
        assert hi == 92000

    def test_hourly_rate(self) -> None:
        lo, hi, fmt = parse_salary("$45.50 per hour")
        assert lo is not None
        assert hi is not None
        # $45.50 × 2080 = $94,640
        assert lo == 94640
        assert hi == 94640
        assert "annualised" in fmt

    def test_unparseable_returns_none(self) -> None:
        lo, hi, fmt = parse_salary("negotiable")
        assert lo is None
        assert hi is None
        assert fmt is None

    def test_empty_string(self) -> None:
        lo, hi, fmt = parse_salary("")
        assert lo is None
        assert hi is None
        assert fmt is None

    def test_none_input(self) -> None:
        lo, hi, fmt = parse_salary(None)
        assert lo is None
        assert hi is None
        assert fmt is None

    def test_whitespace_only(self) -> None:
        lo, hi, fmt = parse_salary("   ")
        assert lo is None
        assert hi is None
        assert fmt is None


# ---------------------------------------------------------------------------
# Visa detection tests
# ---------------------------------------------------------------------------

class TestVisaDetection:
    """Test _detect_visa_requirement with various patterns."""

    def test_australian_citizen(self) -> None:
        assert _detect_visa_requirement("Must be an Australian citizen") == "citizens_only"

    def test_citizenship_required(self) -> None:
        assert _detect_visa_requirement("Must hold Australian citizenship") == "citizens_only"

    def test_permanent_resident(self) -> None:
        assert _detect_visa_requirement("Open to permanent resident applicants") == "pr_required"

    def test_no_match_returns_none(self) -> None:
        assert _detect_visa_requirement("Open to all applicants") is None

    def test_none_input(self) -> None:
        assert _detect_visa_requirement(None) is None

    def test_empty_string(self) -> None:
        assert _detect_visa_requirement("") is None

    def test_actps_employee(self) -> None:
        assert _detect_visa_requirement("Must be an ACTPS employee") == "citizens_only"


# ---------------------------------------------------------------------------
# Date parsing tests
# ---------------------------------------------------------------------------

class TestDateParsing:
    """Test RSS and ISO date parsing helpers."""

    def test_rss_date(self) -> None:
        result = _parse_rss_date("Mon, 14 Apr 2026 00:00:00 +1000")
        assert result == "2026-04-14"

    def test_rss_date_none(self) -> None:
        assert _parse_rss_date(None) is None

    def test_rss_date_invalid(self) -> None:
        assert _parse_rss_date("not a date") is None

    def test_iso_date_already_iso(self) -> None:
        assert _parse_iso_date("2026-04-30") == "2026-04-30"

    def test_iso_date_with_time(self) -> None:
        assert _parse_iso_date("2026-04-30T00:00:00") == "2026-04-30"

    def test_iso_date_dd_mm_yyyy(self) -> None:
        assert _parse_iso_date("30/04/2026") == "2026-04-30"

    def test_iso_date_none(self) -> None:
        assert _parse_iso_date(None) is None

    def test_iso_date_empty(self) -> None:
        assert _parse_iso_date("") is None


# ---------------------------------------------------------------------------
# Work type extraction tests
# ---------------------------------------------------------------------------

class TestWorkTypeExtraction:
    """Test _extract_work_type from listing text."""

    def test_full_time(self) -> None:
        assert _extract_work_type("Full-time permanent position") == "full-time"

    def test_part_time(self) -> None:
        assert _extract_work_type("Part time role available") == "part-time"

    def test_contract(self) -> None:
        assert _extract_work_type("12-month contract") == "contract"

    def test_casual(self) -> None:
        assert _extract_work_type("Casual pool") == "casual"

    def test_no_match(self) -> None:
        assert _extract_work_type("Exciting opportunity") is None

    def test_none_input(self) -> None:
        assert _extract_work_type(None) is None


# ---------------------------------------------------------------------------
# External ID generation tests
# ---------------------------------------------------------------------------

class TestExternalId:
    """Test external_id extraction from URLs."""

    def test_opportunities_url(self) -> None:
        result = ActGovScraper._extract_external_id(
            "https://jobs.act.gov.au/opportunities/12345"
        )
        assert result == "actgov-12345"

    def test_jobs_url(self) -> None:
        result = ActGovScraper._extract_external_id(
            "https://jobs.act.gov.au/jobs/67890"
        )
        assert result == "actgov-67890"

    def test_empty_url(self) -> None:
        result = ActGovScraper._extract_external_id("")
        assert result == ""

    def test_no_numeric_path(self) -> None:
        result = ActGovScraper._extract_external_id(
            "https://jobs.act.gov.au/about/us"
        )
        assert result.startswith("actgov-")


# ---------------------------------------------------------------------------
# RSS parsing tests (via scraper instance)
# ---------------------------------------------------------------------------

class TestRSSParsing:
    """Test RSS feed parsing through the scraper adapter."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_valid_rss_produces_items(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        mock_req.return_value = MOCK_RSS_XML
        scraper = ActGovScraper(config={"keywords": "analyst"})
        items = scraper._fetch_rss()
        assert len(items) == 3
        assert items[0]["title"] == "Senior Policy Officer ASO 6"
        assert items[0]["url"] == "https://jobs.act.gov.au/opportunities/12345"
        assert items[0]["posted_at"] == "2026-04-14"

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_rss_network_error_returns_empty(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        mock_req.side_effect = ConnectionError("Network unreachable")
        scraper = ActGovScraper(config={"keywords": "analyst"})
        items = scraper._fetch_rss()
        assert items == []
        # Should have emitted a warning
        mock_emit.assert_called()
        warn_calls = [c for c in mock_emit.call_args_list if c[0][0] == "warn"]
        assert len(warn_calls) >= 1

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_rss_invalid_xml_returns_empty(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        mock_req.return_value = "<not valid xml"
        scraper = ActGovScraper(config={"keywords": "analyst"})
        items = scraper._fetch_rss()
        assert items == []


# ---------------------------------------------------------------------------
# HTML listing page parsing tests
# ---------------------------------------------------------------------------

class TestHTMLParsing:
    """Test HTML tile extraction and listing page handling."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_html_tiles_extracted(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        mock_req.return_value = MOCK_HTML_LISTINGS
        scraper = ActGovScraper(config={"keywords": "analyst"})
        listings = scraper._fetch_html_listings()
        assert len(listings) == 3
        assert listings[0]["title"] == "Senior Policy Officer ASO 6"
        assert listings[0]["salary_raw"] == "92000"
        assert listings[0]["closing_date"] == "2026-04-30"
        assert listings[0]["external_id"] == "actgov-12345"

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_html_fallback_urls(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        """When first URL returns 0 listings, tries alternate paths."""
        call_count = [0]

        def side_effect(url: str) -> str:
            call_count[0] += 1
            if call_count[0] == 1:
                return MOCK_HTML_NO_TILES
            return MOCK_HTML_LISTINGS

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        listings = scraper._fetch_html_listings()
        assert len(listings) == 3
        assert call_count[0] >= 2

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    def test_all_html_urls_fail_returns_empty(self, mock_emit: MagicMock, mock_req: MagicMock) -> None:
        """When all HTML extraction fails, returns empty and emits diagnostic."""
        mock_req.return_value = MOCK_HTML_NO_TILES
        scraper = ActGovScraper(config={"keywords": "analyst"})
        listings = scraper._fetch_html_listings()
        assert listings == []
        # Should have emitted warnings about failed URLs
        warn_calls = [c for c in mock_emit.call_args_list if c[0][0] == "warn"]
        assert len(warn_calls) >= 1


# ---------------------------------------------------------------------------
# HTML-primary mode: RSS returns 0 items
# ---------------------------------------------------------------------------

class TestHTMLPrimaryMode:
    """Test that adapter proceeds with HTML-only when RSS returns 0 items."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_html_only_when_rss_empty(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        def side_effect(url: str) -> str:
            if "rss" in url:
                raise ConnectionError("RSS unavailable")
            return MOCK_HTML_LISTINGS

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        jobs = scraper.scrape()
        assert len(jobs) >= 3
        # All jobs should still be emitted
        assert mock_emit_job.call_count >= 3


# ---------------------------------------------------------------------------
# Classification extraction tests
# ---------------------------------------------------------------------------

class TestClassificationExtraction:
    """Test classification extraction from titles and mapping to APS."""

    def test_sog_c_maps_to_el1(self) -> None:
        from scrapers.classification_map import extract_classification, map_classification
        raw = extract_classification("Senior Officer Grade C")
        # SOG C pattern
        raw2 = extract_classification("Director SOG C position")
        assert raw2 is not None
        mapped = map_classification(raw2)
        assert mapped == "EL1"

    def test_aso6_maps_to_aps6(self) -> None:
        from scrapers.classification_map import extract_classification, map_classification
        raw = extract_classification("Senior Policy Officer ASO 6")
        assert raw is not None
        mapped = map_classification(raw)
        assert mapped == "APS 6"

    def test_hso5_unmappable(self) -> None:
        from scrapers.classification_map import extract_classification, map_classification
        raw = extract_classification("Registered Nurse HSO 5")
        assert raw is not None
        mapped = map_classification(raw)
        assert mapped is not None
        assert "ACT Gov" in mapped


# ---------------------------------------------------------------------------
# Full scrape integration test (with mocked HTTP)
# ---------------------------------------------------------------------------

class TestFullScrape:
    """Test the complete scrape() method with mocked HTTP responses."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_scrape_produces_job_records(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        def side_effect(url: str) -> str:
            if "rss" in url:
                return MOCK_RSS_XML
            return MOCK_HTML_LISTINGS

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        jobs = scraper.scrape()

        # Should have processed HTML listings + any RSS-only items
        assert len(jobs) >= 3

        # Verify the first job has correct fields
        job = jobs[0]
        assert job["platform"] == "actgov"
        assert job["title"] == "Senior Policy Officer ASO 6"
        assert job["external_id"] == "actgov-12345"
        assert job["location"] == "Canberra, ACT"
        assert job["salary_min"] == 92000
        assert job["salary_max"] == 92000

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_scrape_emits_completed_status(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        def side_effect(url: str) -> str:
            if "rss" in url:
                return MOCK_RSS_XML
            return MOCK_HTML_LISTINGS

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        scraper.scrape()

        # Should have emitted "completed" status
        completed_calls = [c for c in mock_emit.call_args_list if c[0][0] == "completed"]
        assert len(completed_calls) >= 1


# ---------------------------------------------------------------------------
# RSS truncation warning
# ---------------------------------------------------------------------------

class TestRSSTruncationWarning:
    """Test RSS truncation detection when rss_count < 0.8 * html_count."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_truncation_warning_emitted(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        # RSS with 1 item, HTML with 3 tiles → 1 < 0.8 * 3 = 2.4 → warning
        truncated_rss = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Only One Job</title>
      <link>https://jobs.act.gov.au/opportunities/99999</link>
      <description>A single job.</description>
      <pubDate>Mon, 14 Apr 2026 00:00:00 +1000</pubDate>
    </item>
  </channel>
</rss>
"""

        def side_effect(url: str) -> str:
            if "rss" in url:
                return truncated_rss
            return MOCK_HTML_LISTINGS

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        scraper.scrape()

        # Should have emitted a "warn" about RSS truncation
        warn_calls = [c for c in mock_emit.call_args_list if c[0][0] == "warn"]
        truncation_warns = [
            c for c in warn_calls if "truncat" in str(c).lower()
        ]
        assert len(truncation_warns) >= 1


# ---------------------------------------------------------------------------
# RSS-only processing (items not in HTML)
# ---------------------------------------------------------------------------

class TestRSSOnlyProcessing:
    """Test processing of RSS items that have no matching HTML tile."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_rss_only_items_processed(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        # HTML has only one tile, RSS has an extra item not in HTML
        html_one_tile = """\
<html><body>
<div data-salary="92000" data-closingdate="2026-04-30" data-advertiseddate="2026-04-14">
  <h3><a href="/opportunities/12345">Senior Policy Officer ASO 6</a></h3>
</div>
</body></html>
"""
        rss_with_extra = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Senior Policy Officer ASO 6</title>
      <link>https://jobs.act.gov.au/opportunities/12345</link>
      <description>Policy role.</description>
      <pubDate>Mon, 14 Apr 2026 00:00:00 +1000</pubDate>
    </item>
    <item>
      <title>Data Analyst ASO 5</title>
      <link>https://jobs.act.gov.au/opportunities/99999</link>
      <description>Data analysis role.</description>
      <pubDate>Tue, 15 Apr 2026 00:00:00 +1000</pubDate>
    </item>
  </channel>
</rss>
"""

        def side_effect(url: str) -> str:
            if "rss" in url:
                return rss_with_extra
            return html_one_tile

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        jobs = scraper.scrape()

        # Should have 2 jobs: 1 from HTML + 1 RSS-only
        assert len(jobs) >= 2
        urls = [j["url"] for j in jobs]
        assert "https://jobs.act.gov.au/opportunities/99999" in urls


# ---------------------------------------------------------------------------
# No listings from any source
# ---------------------------------------------------------------------------

class TestNoListings:
    """Test handling when no listings are found from either source."""

    @patch.object(ActGovScraper, "_request")
    @patch.object(ActGovScraper, "_emit_status")
    @patch.object(ActGovScraper, "_emit_job")
    def test_zero_listings_emits_error_status(
        self, mock_emit_job: MagicMock, mock_emit: MagicMock, mock_req: MagicMock
    ) -> None:
        def side_effect(url: str) -> str:
            if "rss" in url:
                return '<?xml version="1.0"?><rss><channel></channel></rss>'
            return MOCK_HTML_NO_TILES

        mock_req.side_effect = side_effect
        scraper = ActGovScraper(config={"keywords": "analyst"})
        jobs = scraper.scrape()

        assert len(jobs) == 0
        error_calls = [c for c in mock_emit.call_args_list if c[0][0] == "error"]
        assert len(error_calls) >= 1
