"""Unit tests for NSW Government classification additions to classification_map.

T-F.1 — verifies every NSW mapping declared in WBS Module B and SYSTEM_DESIGN.md
NSW Classification Mapping, plus the extract_classification regex updates and an
ACT Gov regression check to confirm the existing mappings were not disturbed.

These tests exercise the real ``scrapers.classification_map`` module — they do
not reconstruct the mapping table inline.
"""

from __future__ import annotations

import pytest

from scrapers.classification_map import extract_classification, map_classification


# ---------------------------------------------------------------------------
# Clerk Grade → APS (high-confidence mappings)
# ---------------------------------------------------------------------------

class TestClerkGradeMappings:
    """NSW Clerk Grade bands (Crown Employees Award) map to APS equivalents."""

    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("Clerk Grade 1/2", "APS 1-2"),
            ("Clerk Grade 3/4", "APS 3-4"),
            ("Clerk Grade 5/6", "APS 5"),
            ("Clerk Grade 7/8", "APS 6"),
            ("Clerk Grade 9/10", "EL1"),
            ("Clerk Grade 11/12", "EL2"),
        ],
    )
    def test_clerk_grade_to_aps(self, raw: str, expected: str) -> None:
        assert map_classification(raw) == expected

    def test_clerk_grade_case_insensitive(self) -> None:
        assert map_classification("clerk grade 7/8") == "APS 6"
        assert map_classification("CLERK GRADE 11/12") == "EL2"

    def test_clerk_grade_extra_whitespace(self) -> None:
        assert map_classification("  Clerk   Grade   7/8  ") == "APS 6"


# ---------------------------------------------------------------------------
# Senior Officer Grade → EL
# ---------------------------------------------------------------------------

class TestSeniorOfficerGradeMappings:
    """NSW Senior Officer Grade bands map to EL equivalents.

    NOTE: NSW's Senior Officer Grade 1 is the higher band (EL2),
    and Grade 2 is the lower band (EL1). The mapping preserves this.
    """

    def test_senior_officer_grade_1_to_el2(self) -> None:
        assert map_classification("Senior Officer Grade 1") == "EL2"

    def test_senior_officer_grade_2_to_el1(self) -> None:
        assert map_classification("Senior Officer Grade 2") == "EL1"

    def test_senior_officer_case_insensitive(self) -> None:
        assert map_classification("senior officer grade 1") == "EL2"


# ---------------------------------------------------------------------------
# Senior Executive Band → SES
# ---------------------------------------------------------------------------

class TestSeniorExecutiveBandMappings:
    """NSW Senior Executive Band 1/2/3 map to SES Band 1/2/3."""

    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("Senior Executive Band 1", "SES Band 1"),
            ("Senior Executive Band 2", "SES Band 2"),
            ("Senior Executive Band 3", "SES Band 3"),
        ],
    )
    def test_band_to_ses(self, raw: str, expected: str) -> None:
        assert map_classification(raw) == expected

    def test_band_case_insensitive(self) -> None:
        assert map_classification("senior executive band 1") == "SES Band 1"


# ---------------------------------------------------------------------------
# Agency-specific classifications intentionally return None
# ---------------------------------------------------------------------------

class TestAgencySpecificReturnsNone:
    """NSW agency-specific classifications (Health Manager, Transport Service
    Grade, Legal Officer Grade, School Administrative Manager) are intentionally
    not present in the mapping dict — ``map_classification()`` returns ``None``.

    The adapter layer (``_classification_label``) adds the
    ``"NSW Gov — <raw>"`` fallback; that fallback is NOT the responsibility of
    ``map_classification`` and must not leak into this return value.
    """

    @pytest.mark.parametrize(
        "raw",
        [
            "Health Manager Level 1",
            "Health Manager Level 2",
            "Health Manager Level 3",
            "Health Manager Level 4",
            "Transport Service Grade 3",
            "Transport Service Grade 7",
            "Legal Officer Grade 3",
            "School Administrative Manager",
        ],
    )
    def test_agency_specific_returns_none(self, raw: str) -> None:
        assert map_classification(raw) is None


# ---------------------------------------------------------------------------
# ACT Gov regression — existing ACT mappings still work
# ---------------------------------------------------------------------------

class TestActGovRegression:
    """Confirms the NSW additions did not break the ACT mapping table.

    The WBS for T-B.1 explicitly requires verifying existing ACT Gov mappings
    are unchanged after NSW rows are appended.
    """

    def test_aso_6_still_maps_to_aps_6(self) -> None:
        assert map_classification("ASO 6") == "APS 6"

    def test_aso_1_still_maps_to_aps_1(self) -> None:
        assert map_classification("ASO 1") == "APS 1"

    def test_sog_c_still_maps_to_el1(self) -> None:
        assert map_classification("SOG C") == "EL1"

    def test_sog_a_still_maps_to_el2(self) -> None:
        assert map_classification("SOG A") == "EL2"

    def test_exec_still_maps_to_ses(self) -> None:
        assert map_classification("EXEC") == "SES"

    def test_hso_still_returns_act_gov_fallback(self) -> None:
        result = map_classification("HSO 5")
        assert result is not None
        assert "ACT Gov" in result


# ---------------------------------------------------------------------------
# Unmappable / edge-case input
# ---------------------------------------------------------------------------

class TestUnmappableInput:
    def test_unknown_string_returns_none(self) -> None:
        assert map_classification("Something random") is None

    def test_unknown_grade_returns_none(self) -> None:
        assert map_classification("Clerk Grade 99/99") is None

    def test_none_returns_none(self) -> None:
        assert map_classification(None) is None

    def test_empty_string_returns_none(self) -> None:
        assert map_classification("") is None


# ---------------------------------------------------------------------------
# extract_classification — NSW regex patterns
# ---------------------------------------------------------------------------

class TestExtractClassificationNsw:
    """Verify the updated regex extracts NSW classification codes from title /
    description text (per WBS T-B.1 step 6)."""

    def test_extract_clerk_grade_from_text(self) -> None:
        result = extract_classification("This is a Clerk Grade 7/8 position")
        assert result == "Clerk Grade 7/8"

    def test_extract_clerk_grade_11_12(self) -> None:
        result = extract_classification("We are hiring at Clerk Grade 11/12 level")
        assert result == "Clerk Grade 11/12"

    def test_extract_senior_officer_grade(self) -> None:
        result = extract_classification("Senior Officer Grade 1 position available")
        assert result == "Senior Officer Grade 1"

    def test_extract_senior_executive_band(self) -> None:
        result = extract_classification("Director Senior Executive Band 2 role")
        assert result == "Senior Executive Band 2"

    def test_extract_health_manager_level(self) -> None:
        # The regex captures the raw classification — map_classification then
        # returns None for it, causing the adapter to produce the "NSW Gov — ..."
        # fallback label.
        result = extract_classification("Role classified as Health Manager Level 2")
        assert result == "Health Manager Level 2"

    def test_extract_clerk_grade_case_insensitive(self) -> None:
        result = extract_classification("role at clerk grade 5/6 level")
        assert result is not None
        assert "5/6" in result

    def test_extract_does_not_match_arbitrary_digits(self) -> None:
        assert extract_classification("Clerk Grade with 7 years experience") is None

    def test_extract_returns_none_for_plain_text(self) -> None:
        assert extract_classification("Senior Policy Analyst") is None


# ---------------------------------------------------------------------------
# Integration: extract then map
# ---------------------------------------------------------------------------

class TestExtractThenMap:
    """End-to-end extract → map chain for NSW inputs."""

    def test_clerk_grade_7_8_roundtrip(self) -> None:
        raw = extract_classification("Senior Analyst Clerk Grade 7/8")
        assert raw == "Clerk Grade 7/8"
        assert map_classification(raw) == "APS 6"

    def test_senior_executive_band_1_roundtrip(self) -> None:
        raw = extract_classification("Director — Senior Executive Band 1 level")
        assert raw == "Senior Executive Band 1"
        assert map_classification(raw) == "SES Band 1"

    def test_health_manager_level_unmappable(self) -> None:
        raw = extract_classification("Role: Health Manager Level 2 full time")
        assert raw == "Health Manager Level 2"
        assert map_classification(raw) is None
