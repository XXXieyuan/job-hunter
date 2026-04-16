"""ACT Government to APS classification mapping.

Maps ACT Government classification codes (ASO, SOG, EXEC, etc.)
to their Australian Public Service (APS) equivalents.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# ACT-to-APS classification mapping
# ---------------------------------------------------------------------------
# High-confidence mappings return the APS equivalent string.
# Low-confidence mappings (specialist streams) return None, which triggers
# a fallback label of "ACT Gov -- <original>".

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
}

# Regex to extract ACT classification codes from free text
_CLASSIFICATION_RE = re.compile(
    r"\b(?:ASO|SOG|GSO|HSO|SPOA|SPOB|SPOC|EXEC)\s*\d*\s*[A-C]?"
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
