"""Unit tests for scrapers.adapters.nswgov — T-A.1 through T-A.4 Verify criteria.

Covers the WBS Verify fields for Batch B2:
- T-A.1: class inheritance, method presence, Cloudflare detection heuristics,
         build ID extraction.
- T-A.2: ``_parse_salary()`` across all documented formats.
- T-A.3: ``_detect_visa_eligibility()`` and ``_detect_security_clearance()``.
- T-A.4: ``_flatten_location()`` across all documented input shapes.

These tests exercise the real adapter module — they do not reconstruct logic
inline (per checkpoint-runner rules).
"""

from __future__ import annotations

import pytest

from scrapers.adapters.nswgov import NswGovScraper
from scrapers.base import BaseScraper


@pytest.fixture()
def scraper() -> NswGovScraper:
    """Instantiate NswGovScraper with a minimal offline config.

    The constructor calls ``BaseScraper._new_session`` which creates a curl_cffi
    Session; the session is only used when network requests are actually made,
    so instantiation is cheap and offline-safe.
    """
    return NswGovScraper(
        config={
            "keywords": "analyst",
            "location": "Sydney",
            "max_pages": 1,
            "rpm": 60,
            "burst": 5,
            "timeout": 5,
        }
    )


# ---------------------------------------------------------------------------
# T-A.1 — class structure and method presence
# ---------------------------------------------------------------------------

class TestClassStructure:
    def test_inherits_base_scraper(self):
        assert issubclass(NswGovScraper, BaseScraper)

    def test_required_methods_present(self, scraper: NswGovScraper):
        for method in (
            "scrape",
            "_bypass_cloudflare",
            "_parse_salary",
            "_detect_visa_eligibility",
            "_detect_security_clearance",
            "_flatten_location",
        ):
            assert callable(getattr(scraper, method, None)), f"Missing: {method}"

    def test_platform_set_to_nswgov(self, scraper: NswGovScraper):
        assert scraper.platform == "nswgov"


# ---------------------------------------------------------------------------
# T-A.1 — Cloudflare detection heuristics
# ---------------------------------------------------------------------------

class TestCloudflareDetection:
    def test_403_with_cf_ray_is_block(self):
        reason = NswGovScraper._is_cloudflare_block(
            status=403,
            headers={"cf-ray": "abcd1234-SYD"},
            body="<html>blocked</html>",
        )
        assert reason is not None and "cf-ray" in reason

    def test_403_without_cf_ray_is_not_cf_block(self):
        reason = NswGovScraper._is_cloudflare_block(
            status=403,
            headers={},
            body="<html>plain 403</html>",
        )
        assert reason is None

    def test_challenge_page_html_detected(self):
        body = (
            "<html><head><title>Just a moment...</title></head>"
            "<body>checking your browser</body></html>"
        )
        reason = NswGovScraper._is_cloudflare_block(
            status=200,
            headers={},
            body=body,
        )
        assert reason is not None and "Just a moment" in reason

    def test_valid_200_html_is_not_block(self):
        body = "<html><head><title>NSW Jobs</title></head><body>content</body></html>"
        reason = NswGovScraper._is_cloudflare_block(
            status=200,
            headers={"content-type": "text/html"},
            body=body,
        )
        assert reason is None


# ---------------------------------------------------------------------------
# T-A.1 — Next.js build ID extraction
# ---------------------------------------------------------------------------

class TestBuildIdExtraction:
    def test_build_id_present(self):
        html = (
            '<html><head></head><body>'
            '<script id="__NEXT_DATA__" type="application/json">'
            '{"buildId": "abc123def456", "page": "/"}'
            '</script></body></html>'
        )
        assert NswGovScraper._extract_build_id(html) == "abc123def456"

    def test_build_id_absent(self):
        html = "<html><head></head><body>no next data</body></html>"
        assert NswGovScraper._extract_build_id(html) is None

    def test_malformed_next_data(self):
        html = (
            '<script id="__NEXT_DATA__">not valid json</script>'
        )
        assert NswGovScraper._extract_build_id(html) is None

    def test_empty_html_returns_none(self):
        assert NswGovScraper._extract_build_id("") is None


# ---------------------------------------------------------------------------
# T-A.2 — Salary parsing
# ---------------------------------------------------------------------------

class TestParseSalary:
    def test_range_with_dash(self, scraper: NswGovScraper):
        assert scraper._parse_salary("$100,000 - $120,000") == (100000, 120000)

    def test_range_with_to(self, scraper: NswGovScraper):
        assert scraper._parse_salary("$100,000 to $120,000 pa") == (100000, 120000)

    def test_single_value(self, scraper: NswGovScraper):
        assert scraper._parse_salary("$110,000 pa") == (110000, 110000)

    def test_hourly_rate_annualised(self, scraper: NswGovScraper):
        assert scraper._parse_salary("$55.00 per hour") == (114400, 114400)

    def test_total_remuneration_package(self, scraper: NswGovScraper):
        assert scraper._parse_salary(
            "Total remuneration package valued at $150,000"
        ) == (150000, 150000)

    def test_negotiable_unparseable(self, scraper: NswGovScraper):
        assert scraper._parse_salary("Negotiable") == (None, None)

    def test_empty_and_none(self, scraper: NswGovScraper):
        assert scraper._parse_salary("") == (None, None)
        assert scraper._parse_salary(None) == (None, None)


# ---------------------------------------------------------------------------
# T-A.3 — Visa and security-clearance detection
# ---------------------------------------------------------------------------

class TestDetectVisaEligibility:
    def test_citizens_only(self, scraper: NswGovScraper):
        assert scraper._detect_visa_eligibility(
            "Must be an Australian citizen"
        ) == "citizens_only"

    def test_pr_required(self, scraper: NswGovScraper):
        assert scraper._detect_visa_eligibility(
            "permanent resident or citizen"
        ) == "pr_required"

    def test_work_rights_required(self, scraper: NswGovScraper):
        assert scraper._detect_visa_eligibility(
            "Applicants must have the right to work in Australia"
        ) == "work_rights_required"

    def test_no_match_returns_none(self, scraper: NswGovScraper):
        assert scraper._detect_visa_eligibility("Great opportunity") is None

    def test_empty_and_none(self, scraper: NswGovScraper):
        assert scraper._detect_visa_eligibility("") is None
        assert scraper._detect_visa_eligibility(None) is None


class TestDetectSecurityClearance:
    def test_nv1_detected(self, scraper: NswGovScraper):
        assert scraper._detect_security_clearance(
            "NV1 clearance required"
        ) == "NV1"

    def test_baseline_detected(self, scraper: NswGovScraper):
        assert scraper._detect_security_clearance(
            "Baseline clearance needed for this role"
        ) == "Baseline"

    def test_generic_security_clearance(self, scraper: NswGovScraper):
        assert scraper._detect_security_clearance(
            "security clearance required"
        ) == "Security Clearance"

    def test_no_match_returns_none(self, scraper: NswGovScraper):
        assert scraper._detect_security_clearance("Great opportunity") is None

    def test_empty_and_none(self, scraper: NswGovScraper):
        assert scraper._detect_security_clearance("") is None
        assert scraper._detect_security_clearance(None) is None


# ---------------------------------------------------------------------------
# T-A.4 — Location flattening
# ---------------------------------------------------------------------------

class TestFlattenLocation:
    def test_region_and_suburb(self, scraper: NswGovScraper):
        assert scraper._flatten_location(
            {"region": "Sydney", "suburb": "Parramatta"}
        ) == "Sydney / Parramatta"

    def test_region_only(self, scraper: NswGovScraper):
        assert scraper._flatten_location({"region": "Sydney"}) == "Sydney"

    def test_suburb_only(self, scraper: NswGovScraper):
        assert scraper._flatten_location({"suburb": "Parramatta"}) == "Parramatta"

    def test_display_text_passthrough(self, scraper: NswGovScraper):
        assert scraper._flatten_location(
            {"displayText": "Multiple locations"}
        ) == "Multiple locations"

    def test_display_text_preferred_over_region(self, scraper: NswGovScraper):
        """When displayText exists, it takes priority per SYSTEM_DESIGN §7."""
        assert scraper._flatten_location({
            "displayText": "Multiple locations",
            "region": "Sydney",
            "suburb": "CBD",
        }) == "Multiple locations"

    def test_string_input_passthrough(self, scraper: NswGovScraper):
        assert scraper._flatten_location("Regional NSW") == "Regional NSW"

    def test_none_fallback_to_nsw(self, scraper: NswGovScraper):
        assert scraper._flatten_location(None) == "NSW"

    def test_empty_dict_fallback_to_nsw(self, scraper: NswGovScraper):
        assert scraper._flatten_location({}) == "NSW"
