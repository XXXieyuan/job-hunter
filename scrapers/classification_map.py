"""ACT / NSW Government to APS classification mapping.

Maps ACT Government classification codes (ASO, SOG, EXEC, etc.) and
NSW Government classification codes (Clerk Grade, Senior Officer Grade,
Senior Executive Band, etc.) to their Australian Public Service (APS)
equivalents.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# ACT/NSW-to-APS classification mapping
# ---------------------------------------------------------------------------
# High-confidence mappings return the APS equivalent string.
# Low-confidence mappings (specialist streams) return None.
# For ACT prefixes already registered here with value None, the helper
# returns "ACT Gov -- <original>" as a fallback label. For NSW agency-
# specific classifications (Health Manager Level, Transport Service Grade,
# Legal Officer Grade, School Administrative Manager), entries are
# intentionally omitted so ``map_classification()`` returns ``None``; the
# adapter layer applies the "NSW Gov -- <original>" fallback per
# SYSTEM_DESIGN.md NSW Classification Mapping.

_ACT_TO_APS: dict[str, str | None] = {
    "ASO 1": "APS 1",
    "ASO 2": "APS 2",
    "ASO 3": "APS 3",
    "ASO 4": "APS 4",
    "ASO 5": "APS 5",
    "ASO 6": "APS 6",
    "SOG C": "EL1",
    "SOG B": "EL1-EL2",
    "SOG A": "EL2",
    "EXEC": "SES",
    # Low-confidence: specialist streams with no direct APS equivalent
    "GSO": None,
    "HSO": None,
    "TO": None,
    "PO": None,
    "SPOA": None,
    "SPOB": None,
    "SPOC": None,
    # NSW Government: Clerk Grade (Crown Employees Award)
    "CLERK GRADE 1/2": "APS 1-2",
    "CLERK GRADE 3/4": "APS 3-4",
    "CLERK GRADE 5/6": "APS 5",
    "CLERK GRADE 7/8": "APS 6",
    "CLERK GRADE 9/10": "EL1",
    "CLERK GRADE 11/12": "EL2",
    # NSW Government: Senior Officer Grade
    "SENIOR OFFICER GRADE 1": "EL2",
    "SENIOR OFFICER GRADE 2": "EL1",
    # NSW Government: Senior Executive Band
    "SENIOR EXECUTIVE BAND 1": "SES Band 1",
    "SENIOR EXECUTIVE BAND 2": "SES Band 2",
    "SENIOR EXECUTIVE BAND 3": "SES Band 3",
    # NSW Government agency-specific classifications (Health Manager Level,
    # Transport Service Grade, Legal Officer Grade, School Administrative
    # Manager) intentionally omitted — map_classification returns None, and
    # the adapter produces a "NSW Gov -- <original>" fallback label.
}

# Regex to extract ACT and NSW classification codes from free text.
# NSW patterns ("Clerk Grade N/N", "Senior Officer Grade N",
# "Senior Executive Band N", "Health Manager Level N") are placed before the
# ACT patterns so the more specific multi-word matches win.
_CLASSIFICATION_RE = re.compile(
    r"\bClerk\s+Grade\s+\d+/\d+"
    r"|\bSenior\s+Executive\s+Band\s+\d+"
    r"|\bSenior\s+Officer\s+Grade\s+\d+"
    r"|\bHealth\s+Manager\s+Level\s+\d+"
    r"|\b(?:ASO|SOG|GSO|HSO|SPOA|SPOB|SPOC|EXEC)\s*\d*\s*[A-C]?"
    r"|\b(?:TO|PO)\s+\d+",
    re.IGNORECASE,
)


def _normalise_key(raw: str) -> str:
    """Normalise a classification string for dictionary lookup.

    Strips whitespace, collapses internal whitespace, and uppercases.
    """
    return re.sub(r"\s+", " ", raw.strip()).upper()


def map_classification(raw: str | None) -> str | None:
    """Map an ACT Government classification to its APS equivalent.

    Parameters
    ----------
    raw:
        The raw classification string (e.g. ``"ASO 6"``, ``"SOG C"``).
        May be ``None`` or empty.

    Returns
    -------
    str | None
        - APS equivalent string for high-confidence mappings
        - ``"ACT Gov \u2014 <original>"`` for low-confidence specialist streams
        - ``None`` if input is ``None`` or empty
    """
    if raw is None or raw == "":
        return None

    key = _normalise_key(raw)
    if not key:
        return None

    if key in _ACT_TO_APS:
        aps = _ACT_TO_APS[key]
        if aps is not None:
            return aps
        # Low-confidence: preserve original with prefix
        return f"ACT Gov \u2014 {raw.strip()}"

    # Try matching just the prefix (e.g. "HSO 5" -> prefix "HSO")
    prefix = key.split()[0] if " " in key else key
    if prefix in _ACT_TO_APS:
        aps = _ACT_TO_APS[prefix]
        if aps is not None:
            return aps
        return f"ACT Gov \u2014 {raw.strip()}"

    return None


def extract_classification(text: str | None) -> str | None:
    """Extract an ACT classification code from free text.

    Parameters
    ----------
    text:
        Job title or description text to search.

    Returns
    -------
    str | None
        The matched classification string, or ``None`` if not found.
    """
    if not text:
        return None
    m = _CLASSIFICATION_RE.search(text)
    if m:
        return m.group(0).strip()
    return None
