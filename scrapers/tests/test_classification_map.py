"""Unit tests for scrapers.classification_map module.

Tests all ACT-to-APS classification mappings, edge cases,
case-insensitivity, and the extract_classification regex.
"""

import pytest

from scrapers.classification_map import extract_classification, map_classification


# ---------------------------------------------------------------------------
# map_classification — high-confidence direct mappings
# ---------------------------------------------------------------------------

class TestMapClassificationDirectMappings:
    """Test ASO 1-6, SOG A/B/C, and EXEC direct mappings."""

    @pytest.mark.parametrize(
        "input_val, expected",
        [
            ("ASO 1", "APS 1"),
            ("ASO 2", "APS 2"),
            ("ASO 3", "APS 3"),
            ("ASO 4", "APS 4"),
            ("ASO 5", "APS 5"),
            ("ASO 6", "APS 6"),
        ],
    )
    def test_aso_to_aps(self, input_val: str, expected: str) -> None:
        assert map_classification(input_val) == expected

    def test_sog_c_to_el1(self) -> None:
        assert map_classification("SOG C") == "EL1"

    def test_sog_b_to_el1_el2(self) -> None:
        assert map_classification("SOG B") == "EL1-EL2"

    def test_sog_a_to_el2(self) -> None:
        assert map_classification("SOG A") == "EL2"

    def test_exec_to_ses(self) -> None:
        assert map_classification("EXEC") == "SES"


# ---------------------------------------------------------------------------
# map_classification — low-confidence / unmappable classifications
# ---------------------------------------------------------------------------

class TestMapClassificationUnmappable:
    """Test specialist streams that return 'ACT Gov — <original>'."""

    @pytest.mark.parametrize(
        "input_val, expected",
        [
            ("HSO 5", "ACT Gov \u2014 HSO 5"),
            ("GSO 3", "ACT Gov \u2014 GSO 3"),
            ("TO 2", "ACT Gov \u2014 TO 2"),
            ("PO 1", "ACT Gov \u2014 PO 1"),
            ("SPOA", "ACT Gov \u2014 SPOA"),
            ("SPOB", "ACT Gov \u2014 SPOB"),
            ("SPOC", "ACT Gov \u2014 SPOC"),
        ],
    )
    def test_specialist_streams(self, input_val: str, expected: str) -> None:
        assert map_classification(input_val) == expected

    def test_hso_without_number(self) -> None:
        assert map_classification("HSO") == "ACT Gov \u2014 HSO"

    def test_gso_without_number(self) -> None:
        assert map_classification("GSO") == "ACT Gov \u2014 GSO"


# ---------------------------------------------------------------------------
# map_classification — edge cases
# ---------------------------------------------------------------------------

class TestMapClassificationEdgeCases:
    """Test None, empty string, whitespace, and case-insensitivity."""

    def test_none_returns_none(self) -> None:
        assert map_classification(None) is None

    def test_empty_string_returns_none(self) -> None:
        assert map_classification("") is None

    def test_whitespace_only_returns_none(self) -> None:
        assert map_classification("   ") is None

    def test_case_insensitive_lower(self) -> None:
        assert map_classification("aso 6") == "APS 6"

    def test_case_insensitive_mixed(self) -> None:
        assert map_classification("Aso 3") == "APS 3"

    def test_case_insensitive_sog(self) -> None:
        assert map_classification("sog c") == "EL1"

    def test_case_insensitive_exec(self) -> None:
        assert map_classification("exec") == "SES"

    def test_extra_whitespace(self) -> None:
        assert map_classification("  ASO  6  ") == "APS 6"

    def test_unknown_classification_returns_none(self) -> None:
        assert map_classification("XYZ 99") is None

    def test_random_text_returns_none(self) -> None:
        assert map_classification("Senior Policy Officer") is None


# ---------------------------------------------------------------------------
# extract_classification — regex extraction from free text
# ---------------------------------------------------------------------------

class TestExtractClassification:
    """Test extract_classification regex on title/description strings."""

    def test_extract_aso_from_title(self) -> None:
        result = extract_classification("Senior Policy Officer ASO 6")
        assert result is not None
        assert "ASO" in result.upper()
        assert "6" in result

    def test_extract_sog_from_title(self) -> None:
        result = extract_classification("Director SOG B position")
        assert result is not None
        assert "SOG" in result.upper()

    def test_extract_exec_from_title(self) -> None:
        result = extract_classification("Branch Manager EXEC")
        assert result is not None
        assert "EXEC" in result.upper()

    def test_extract_hso_from_title(self) -> None:
        result = extract_classification("Registered Nurse HSO 5")
        assert result is not None
        assert "HSO" in result.upper()

    def test_extract_to_from_title(self) -> None:
        result = extract_classification("Workshop Technician TO 2")
        assert result is not None
        assert "TO" in result.upper()

    def test_extract_po_from_title(self) -> None:
        result = extract_classification("Professional Officer PO 1")
        assert result is not None
        assert "PO" in result.upper()

    def test_extract_gso_from_title(self) -> None:
        result = extract_classification("Maintenance Worker GSO 5")
        assert result is not None
        assert "GSO" in result.upper()

    def test_no_classification_returns_none(self) -> None:
        assert extract_classification("Senior Policy Officer") is None

    def test_none_input_returns_none(self) -> None:
        assert extract_classification(None) is None

    def test_empty_string_returns_none(self) -> None:
        assert extract_classification("") is None

    def test_case_insensitive_extraction(self) -> None:
        result = extract_classification("Officer aso 4 position")
        assert result is not None
        assert "4" in result

    def test_spoa_extraction(self) -> None:
        result = extract_classification("Specialist SPOA role")
        assert result is not None
        assert "SPOA" in result.upper()


# ---------------------------------------------------------------------------
# Integration: extract then map
# ---------------------------------------------------------------------------

class TestExtractAndMap:
    """Test the pipeline of extracting and then mapping classifications."""

    def test_extract_and_map_aso(self) -> None:
        raw = extract_classification("Senior Policy Officer ASO 6")
        assert raw is not None
        mapped = map_classification(raw)
        assert mapped == "APS 6"

    def test_extract_and_map_sog_c(self) -> None:
        raw = extract_classification("Team Leader SOG C")
        assert raw is not None
        mapped = map_classification(raw)
        assert mapped == "EL1"

    def test_extract_and_map_hso(self) -> None:
        raw = extract_classification("Nurse HSO 5")
        assert raw is not None
        mapped = map_classification(raw)
        assert mapped is not None
        assert "ACT Gov" in mapped
