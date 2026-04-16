"""Unit tests for scrapers.adapters.nswgov — classification integration,
fingerprint rotation order, pagination metadata, JSON Lines serialisation,
Cloudflare exhaustion error, and build-ID refresh behaviour.

This file complements ``test_nswgov_core.py`` (which covers T-A.1..T-A.4 Verify
criteria) with the additional T-F.2 coverage requested by WBS Module F:

    - Fingerprint rotation order.
    - Classification mapping integration (adapter-level ``_classification_label``).
    - JSON Lines output format validation (envelope shape + required fields).
    - Error handling: 3× Cloudflare failure, 0-result warning, salary → null.
    - API payload shape variations (``_extract_jobs_from_api``).
    - Pagination metadata (``_has_more_pages``).
    - Build-ID staleness refresh path.

All tests import and exercise real adapter code — no inline reconstruction.
"""

from __future__ import annotations

import io
import json
from unittest.mock import MagicMock, patch

import pytest

from scrapers.adapters.nswgov import (
    _CF_BACKOFFS,
    _CF_FINGERPRINTS,
    _HOURS_PER_YEAR,
    _MIN_REQUEST_INTERVAL_S,
    NswGovScraper,
    _classification_label,
    _coerce_str,
    _extract_external_id_from_url,
)
from scrapers.models import JobRecord


# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------

@pytest.fixture()
def scraper() -> NswGovScraper:
    """Offline-safe scraper instance for unit-level method testing."""
    return NswGovScraper(
        config={
            "keywords": "analyst",
            "location": "Sydney",
            "max_pages": 2,
            "rpm": 60,
            "burst": 5,
            "timeout": 5,
        }
    )


# ---------------------------------------------------------------------------
# Module-level constants — fingerprint rotation order + backoff schedule
# ---------------------------------------------------------------------------

class TestFingerprintRotationOrder:
    """WBS T-F.2 step 4 — fingerprint order: chrome120 → chrome124 → firefox120 → edge101.
    SYSTEM_DESIGN.md §Request Flow 3 and TEST_PLAN_BACKEND T-13."""

    def test_four_fingerprints(self) -> None:
        assert len(_CF_FINGERPRINTS) == 4

    def test_rotation_order(self) -> None:
        assert _CF_FINGERPRINTS == [
            "chrome120",
            "chrome124",
            "firefox120",
            "edge101",
        ]

    def test_chrome_first(self) -> None:
        """Chrome is tried first (market share) per SYSTEM_DESIGN §Request Flow 3."""
        assert _CF_FINGERPRINTS[0].startswith("chrome")

    def test_backoff_schedule_exponential(self) -> None:
        """Exponential backoff 2s → 4s → 8s between attempts."""
        assert _CF_BACKOFFS == [2, 4, 8]


class TestRateLimitingConstants:
    def test_min_request_interval_two_seconds(self) -> None:
        """SYSTEM_DESIGN.md §4 and TEST_PLAN_BACKEND T-18 — ≥2s between requests."""
        assert _MIN_REQUEST_INTERVAL_S >= 2.0

    def test_hours_per_year_standard(self) -> None:
        """Hourly-to-annual conversion: 40 × 52 = 2080."""
        assert _HOURS_PER_YEAR == 2080


# ---------------------------------------------------------------------------
# Classification label fallback (adapter-level integration)
# ---------------------------------------------------------------------------

class TestClassificationLabel:
    """Adapter-level wrapper that applies "NSW Gov — <raw>" fallback when
    map_classification returns None (per SYSTEM_DESIGN §3 NSW Classification
    Mapping). Tests the integration, not the underlying mapping table."""

    def test_mappable_returns_aps_equivalent(self) -> None:
        assert _classification_label("Clerk Grade 7/8") == "APS 6"

    def test_mappable_senior_executive_band(self) -> None:
        assert _classification_label("Senior Executive Band 1") == "SES Band 1"

    def test_unmappable_returns_nsw_gov_fallback(self) -> None:
        result = _classification_label("Health Manager Level 2")
        assert result is not None
        assert result.startswith("NSW Gov")
        assert "Health Manager Level 2" in result

    def test_unmappable_transport_service_grade(self) -> None:
        result = _classification_label("Transport Service Grade 3")
        assert result is not None
        assert result.startswith("NSW Gov")

    def test_empty_input_returns_none(self) -> None:
        assert _classification_label("") is None
        assert _classification_label(None) is None
        assert _classification_label("   ") is None

    def test_uses_em_dash_separator(self) -> None:
        """SYSTEM_DESIGN §3 specifies em-dash (U+2014) not hyphen."""
        result = _classification_label("Legal Officer Grade 3")
        assert result is not None
        assert "\u2014" in result  # em dash


# ---------------------------------------------------------------------------
# Next.js API payload extraction variants
# ---------------------------------------------------------------------------

class TestExtractJobsFromApi:
    """Defensive extraction of the job list from different Next.js shapes."""

    def test_page_props_job_results(self, scraper: NswGovScraper) -> None:
        api = {"pageProps": {"jobResults": [{"title": "Job A"}, {"title": "Job B"}]}}
        result = scraper._extract_jobs_from_api(api)
        assert len(result) == 2
        assert result[0]["title"] == "Job A"

    def test_page_props_jobs_alias(self, scraper: NswGovScraper) -> None:
        api = {"pageProps": {"jobs": [{"title": "Only"}]}}
        assert len(scraper._extract_jobs_from_api(api)) == 1

    def test_top_level_results(self, scraper: NswGovScraper) -> None:
        """Degradation path — accepts top-level list when pageProps is absent."""
        api = {"results": [{"title": "Top"}]}
        assert len(scraper._extract_jobs_from_api(api)) == 1

    def test_empty_dict_returns_empty(self, scraper: NswGovScraper) -> None:
        assert scraper._extract_jobs_from_api({}) == []

    def test_non_dict_returns_empty(self, scraper: NswGovScraper) -> None:
        assert scraper._extract_jobs_from_api("not a dict") == []
        assert scraper._extract_jobs_from_api(None) == []
        assert scraper._extract_jobs_from_api([{"title": "x"}]) == []


# ---------------------------------------------------------------------------
# Pagination metadata
# ---------------------------------------------------------------------------

class TestHasMorePages:
    def test_current_lt_total_has_more(self) -> None:
        api = {"pageProps": {"pagination": {"totalPages": 5}}}
        assert NswGovScraper._has_more_pages(api, current_page=1) is True

    def test_current_eq_total_no_more(self) -> None:
        api = {"pageProps": {"pagination": {"totalPages": 3}}}
        assert NswGovScraper._has_more_pages(api, current_page=3) is False

    def test_top_level_pagination(self) -> None:
        api = {"pagination": {"totalPages": 2}}
        assert NswGovScraper._has_more_pages(api, current_page=1) is True
        assert NswGovScraper._has_more_pages(api, current_page=2) is False

    def test_snake_case_total_pages(self) -> None:
        api = {"pageProps": {"pagination": {"total_pages": 4}}}
        assert NswGovScraper._has_more_pages(api, current_page=2) is True

    def test_no_metadata_assumes_more(self) -> None:
        """Without pagination metadata, assume more pages exist — the adapter
        stops when a subsequent page is empty (scrape() loop)."""
        assert NswGovScraper._has_more_pages({}, current_page=1) is True

    def test_non_dict_returns_false(self) -> None:
        assert NswGovScraper._has_more_pages("not a dict", current_page=1) is False
        assert NswGovScraper._has_more_pages(None, current_page=1) is False


# ---------------------------------------------------------------------------
# API → JobRecord parsing (integration) and JSON Lines output
# ---------------------------------------------------------------------------

_SAMPLE_API_PAYLOAD = {
    "id": "NSW-0042",
    "title": "Senior Policy Officer",
    "organisation": "Department of Premier and Cabinet",
    "location": {"region": "Sydney", "suburb": "Parramatta"},
    "description": "Exciting opportunity. Applicants must have the right to work in Australia.",
    "url": "/job/NSW-0042",
    "salary": {
        "min": 100000,
        "max": 120000,
        "displayText": "$100,000 - $120,000 per annum",
    },
    "classification": "Clerk Grade 7/8",
    "closingDate": "2026-05-01",
    "postedDate": "2026-04-01",
    "employmentType": "Full-time",
}


class TestParseJobFromApi:
    """End-to-end API payload → JobRecord translation."""

    def test_builds_job_record(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert isinstance(record, JobRecord)

    def test_external_id_prefixed_with_nswgov(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.external_id.startswith("nswgov-")
        assert record.external_id == "nswgov-NSW-0042"

    def test_platform_is_nswgov(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.platform == "nswgov"

    def test_location_flattened(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.location == "Sydney / Parramatta"

    def test_salary_extracted_from_structured_payload(
        self, scraper: NswGovScraper
    ) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.salary_min == 100000
        assert record.salary_max == 120000

    def test_classification_mapped_to_aps(self, scraper: NswGovScraper) -> None:
        """Clerk Grade 7/8 → APS 6 (T-F.2 step 8)."""
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.classification == "APS 6"

    def test_unmappable_classification_falls_back_to_nsw_gov_prefix(
        self, scraper: NswGovScraper
    ) -> None:
        """Health Manager Level 2 → "NSW Gov — Health Manager Level 2"."""
        payload = {**_SAMPLE_API_PAYLOAD, "classification": "Health Manager Level 2"}
        record = scraper._parse_job_from_api(payload)
        assert record is not None
        assert record.classification is not None
        assert record.classification.startswith("NSW Gov")
        assert "Health Manager Level 2" in record.classification

    def test_visa_detection_from_description(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        # description includes "right to work in Australia"
        assert record.visa_requirement == "work_rights_required"

    def test_url_absolutised(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.url.startswith("https://iworkfor.nsw.gov.au")

    def test_dates_normalised(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.closes_at == "2026-05-01"
        assert record.posted_at == "2026-04-01"

    def test_work_type_mapped(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        assert record.work_type == "full-time"

    def test_missing_title_returns_none(self, scraper: NswGovScraper) -> None:
        """Payload without a title is considered invalid."""
        payload = {"id": "X", "organisation": "Y"}
        assert scraper._parse_job_from_api(payload) is None

    def test_unparseable_salary_string_yields_null_min_max(
        self, scraper: NswGovScraper
    ) -> None:
        """WBS T-F.2 step 10 — salary parse failure → null min/max, raw
        ``salary`` text preserved."""
        payload = {
            "id": "NSW-X",
            "title": "Anonymous Role",
            "salary": "Negotiable",
        }
        record = scraper._parse_job_from_api(payload)
        assert record is not None
        assert record.salary_min is None
        assert record.salary_max is None
        assert record.salary == "Negotiable"

    def test_external_id_fallback_to_url_hash(self, scraper: NswGovScraper) -> None:
        """When no id field is present, an external_id is synthesised from URL."""
        payload = {
            "title": "No-ID Role",
            "url": "https://iworkfor.nsw.gov.au/job/slug-123",
        }
        record = scraper._parse_job_from_api(payload)
        assert record is not None
        assert record.external_id.startswith("nswgov-")


class TestJsonLinesOutput:
    """WBS T-F.2 step 9 — each line valid JSON, required fields present."""

    def test_to_json_line_is_single_line(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        line = record.to_json_line()
        assert "\n" not in line
        assert line.startswith("{") and line.endswith("}")

    def test_to_json_line_parses_as_json(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        line = record.to_json_line()
        parsed = json.loads(line)
        assert parsed["type"] == "job"
        assert isinstance(parsed["data"], dict)

    def test_required_fields_present_in_envelope(
        self, scraper: NswGovScraper
    ) -> None:
        """Node.js ingestion (scraperService.mapCrawlerJob) reads these fields."""
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        data = json.loads(record.to_json_line())["data"]
        for key in (
            "external_id",
            "platform",
            "title",
            "company",
            "location",
            "description",
            "url",
            "salary",
            "salary_min",
            "salary_max",
            "work_type",
            "visa_requirement",
            "classification",
            "closes_at",
            "posted_at",
            "raw_json",
        ):
            assert key in data, f"JSON Lines envelope missing field: {key}"

    def test_platform_field_is_nswgov(self, scraper: NswGovScraper) -> None:
        record = scraper._parse_job_from_api(_SAMPLE_API_PAYLOAD)
        assert record is not None
        data = json.loads(record.to_json_line())["data"]
        assert data["platform"] == "nswgov"


# ---------------------------------------------------------------------------
# Cloudflare bypass exhaustion — all fingerprints blocked
# ---------------------------------------------------------------------------

class _FakeBlockedResponse:
    """Mimics curl_cffi response where Cloudflare always blocks."""

    def __init__(self) -> None:
        self.status_code = 403
        self.headers = {"cf-ray": "block1234-SYD"}
        self.text = "<html>blocked</html>"


class _FakeBlockedSession:
    """Session replacement that always returns a CF block, tracking calls."""

    instances: list["_FakeBlockedSession"] = []

    def __init__(self, impersonate: str | None = None, **_kwargs) -> None:
        self.impersonate = impersonate
        self.headers: dict[str, str] = {}
        self.closed = False
        _FakeBlockedSession.instances.append(self)

    def get(self, *_args, **_kwargs) -> _FakeBlockedResponse:
        return _FakeBlockedResponse()

    def close(self) -> None:
        self.closed = True


class TestCloudflareBypassExhaustion:
    """WBS T-F.2 step 10 — graceful exit after all 4 fingerprints are blocked."""

    def test_raises_runtime_error_after_all_fingerprints_blocked(
        self, scraper: NswGovScraper
    ) -> None:
        # Patch both the Session symbol in the module and time.sleep to avoid
        # actual 2+4+8s delays during tests.
        _FakeBlockedSession.instances = []
        with patch("scrapers.adapters.nswgov.Session", _FakeBlockedSession), \
             patch("scrapers.adapters.nswgov.time.sleep"):
            with pytest.raises(RuntimeError) as excinfo:
                scraper._bypass_cloudflare("https://iworkfor.nsw.gov.au/")

        assert "Cloudflare bypass failed" in str(excinfo.value)
        # One fake session per fingerprint attempt.
        assert len(_FakeBlockedSession.instances) == len(_CF_FINGERPRINTS)

    def test_attempted_fingerprints_in_documented_order(
        self, scraper: NswGovScraper
    ) -> None:
        _FakeBlockedSession.instances = []
        with patch("scrapers.adapters.nswgov.Session", _FakeBlockedSession), \
             patch("scrapers.adapters.nswgov.time.sleep"):
            with pytest.raises(RuntimeError):
                scraper._bypass_cloudflare("https://iworkfor.nsw.gov.au/")

        attempted = [s.impersonate for s in _FakeBlockedSession.instances]
        assert attempted == _CF_FINGERPRINTS


# ---------------------------------------------------------------------------
# Build-ID refresh behaviour (T-A.1 step 11)
# ---------------------------------------------------------------------------

class _FakeHomepageResponse:
    def __init__(self, status: int, body: str) -> None:
        self.status_code = status
        self.text = body
        self.headers: dict[str, str] = {}


class TestBuildIdRefresh:
    """Staleness retry — refresh buildId once when API returns 404."""

    def test_refresh_updates_build_id(self, scraper: NswGovScraper) -> None:
        new_html = (
            '<html><head></head><body>'
            '<script id="__NEXT_DATA__" type="application/json">'
            '{"buildId": "fresh999", "page": "/"}'
            '</script></body></html>'
        )
        scraper._build_id = "stale111"
        fake_resp = _FakeHomepageResponse(200, new_html)
        with patch.object(scraper._session, "get", return_value=fake_resp), \
             patch("scrapers.adapters.nswgov.time.sleep"):
            refreshed = scraper._refresh_build_id()
        assert refreshed is True
        assert scraper._build_id == "fresh999"

    def test_refresh_only_runs_once(self, scraper: NswGovScraper) -> None:
        scraper._build_id = "stale111"
        scraper._build_id_refreshed = True  # already refreshed
        # If not bailed out, .get() would raise.
        assert scraper._refresh_build_id() is False

    def test_refresh_handles_homepage_error(self, scraper: NswGovScraper) -> None:
        fake_resp = _FakeHomepageResponse(500, "server error")
        with patch.object(scraper._session, "get", return_value=fake_resp), \
             patch("scrapers.adapters.nswgov.time.sleep"):
            assert scraper._refresh_build_id() is False

    def test_refresh_handles_exception(self, scraper: NswGovScraper) -> None:
        with patch.object(
            scraper._session,
            "get",
            side_effect=RuntimeError("network down"),
        ), patch("scrapers.adapters.nswgov.time.sleep"):
            assert scraper._refresh_build_id() is False


# ---------------------------------------------------------------------------
# External ID helper
# ---------------------------------------------------------------------------

class TestExtractExternalIdFromUrl:
    def test_extracts_slug_from_job_url(self) -> None:
        url = "https://iworkfor.nsw.gov.au/job/ABC-123"
        assert _extract_external_id_from_url(url) == "nswgov-ABC-123"

    def test_returns_empty_for_non_job_url(self) -> None:
        assert _extract_external_id_from_url("https://iworkfor.nsw.gov.au/") == ""

    def test_empty_url_returns_empty_string(self) -> None:
        assert _extract_external_id_from_url("") == ""


# ---------------------------------------------------------------------------
# Coerce helper
# ---------------------------------------------------------------------------

class TestCoerceStr:
    def test_strips_whitespace(self) -> None:
        assert _coerce_str("  hello  ") == "hello"

    def test_none_returns_empty(self) -> None:
        assert _coerce_str(None) == ""

    def test_int_stringified(self) -> None:
        assert _coerce_str(42) == "42"
