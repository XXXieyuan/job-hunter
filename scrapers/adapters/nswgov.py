"""NSW Government Jobs scraper adapter.

Scrapes iworkfor.nsw.gov.au with Cloudflare bypass via TLS fingerprint rotation
and dual-path data extraction (Next.js data API when a buildId can be extracted
from ``__NEXT_DATA__`` on the homepage; HTML search listing otherwise).

Design references:
- SYSTEM_DESIGN.md §1 Architecture Overview
- SYSTEM_DESIGN.md §6 Error Handling Strategy
- SYSTEM_DESIGN.md §7 NSW Gov Data Extraction
- WBS.md Module A (T-A.1 through T-A.4)
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from bs4 import BeautifulSoup
from curl_cffi.requests import Session

from scrapers.base import BaseScraper
from scrapers.classification_map import extract_classification, map_classification
from scrapers.models import JobRecord

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_NSWGOV_BASE = "https://iworkfor.nsw.gov.au"
_NSWGOV_HOMEPAGE = _NSWGOV_BASE + "/"
_NSWGOV_SEARCH_URL = _NSWGOV_BASE + "/jobs"

# iworkfor.nsw.gov.au Next.js frontend calls this public backend via a
# hard-coded OAuth client JWT (public, baked into the JS bundle). The JWT is
# valid until 2036 and used unauthenticated for guest job search.
_ADCORE_API_BASE = "https://api.ad-core04.com/api"
_ADCORE_SEARCH_URL = _ADCORE_API_BASE + "/search/jobs"
_ADCORE_PUBLIC_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIzRTJDNjUzOS1ENDQwLTQ2QkMtODgzQS0yNUYxOUMyMkU2NDYiLCJlbWFpbCI6Im5zd0BhcHBseWRpcmVjdC5jb20iLCJqdGkiOiJmNmQ5MTUzNC04ZTA2LTQwMjEtYWNjYi00MDZiZjNjNDg5MjQiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1lIjoiSVdGTlNXIEFwcGxpY2F0aW9uIiwiaHR0cDovL3NjaGVtYXMueG1sc29hcC5vcmcvd3MvMjAwNS8wNS9pZGVudGl0eS9jbGFpbXMvdXJpIjoiaHR0cHM6Ly9hZG1pbnpvbmUuaXdvcmtmb3IubnN3Lmdvdi5hdS9jYWxsYmFjayIsImh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vd3MvMjAwOC8wNi9pZGVudGl0eS9jbGFpbXMvcm9sZSI6Ik9BdXRoQ2xpZW50IiwiaHR0cDovL3NjaGVtYXMueG1sc29hcC5vcmcvd3MvMjAwNS8wNS9pZGVudGl0eS9jbGFpbXMvaGFzaCI6ImFvclhrN1ZHM0ZNUDBLMXRRTzA0M2dVdklRPSIsIm9hdXRoY2xpZW50IjoiM0UyQzY1MzktRDQ0MC00NkJDLTg4M0EtMjVGMTlDMjJFNjQ2IiwiZmVhdHVyZXMiOiJbXCJCbG9nXCJdIiwiZXhwIjoyMDg1NDg5NTY0LCJpc3MiOiJkMjIzYjA2OS1mODc0LTQzZmItODZkMi1jNzk2MDYwMGIxMDYiLCJhdWQiOiJJV0ZOU1cgQXBwbGljYXRpb24ifQ."
    "Hr2UnSwFb9br6tBDxIuGKiL6iLMPkfIZwqcJFOC0YUg"
)

# Fingerprint rotation order per SYSTEM_DESIGN.md §Request Flow 3 and
# TEST_PLAN_BACKEND T-13. Chrome first (market share), then Firefox, then Edge.
_CF_FINGERPRINTS: list[str] = [
    "chrome120",
    "chrome124",
    "firefox120",
    "edge101",
]

# Exponential backoff between fingerprint rotation attempts (seconds).
_CF_BACKOFFS: list[int] = [2, 4, 8]

# Minimum 2-second delay between outbound requests per SYSTEM_DESIGN.md §4
# and TEST_PLAN_BACKEND T-18.
_MIN_REQUEST_INTERVAL_S: float = 2.0

# Hourly → annual conversion factor (40 hrs/week × 52 weeks).
_HOURS_PER_YEAR: int = 2080

# ---------------------------------------------------------------------------
# Salary regex patterns
# ---------------------------------------------------------------------------

# Range with dollar signs: "$100,000 - $120,000" or "$100,000 to $120,000".
_SALARY_RANGE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$\s*([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)

# Hourly rate: "$55.00 per hour", "$55/hr", "$55 p/h".
_SALARY_HOURLY_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:per\s+hour|/\s*hour|/\s*hr|\bp/?h\b)",
    re.IGNORECASE,
)

# Single dollar value (fallback for "$110,000 pa", "$150,000", etc.).
_SALARY_SINGLE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _to_int(raw: str) -> int | None:
    """Convert a numeric salary string to int, stripping commas/dollar signs."""
    try:
        cleaned = raw.replace(",", "").replace("$", "").strip()
        return int(float(cleaned))
    except (ValueError, TypeError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# Visa / citizenship / security-clearance patterns (T-A.3)
# ---------------------------------------------------------------------------

# Citizenship-required patterns → 'citizens_only'
_CITIZEN_PATTERNS = [
    re.compile(r"must\s+be\s+an?\s+australian\s+citizen", re.I),
    re.compile(r"australian\s+citizenship\s+(?:is\s+)?(?:a\s+)?requirement", re.I),
    re.compile(r"only\s+available\s+to\s+australian\s+citizens", re.I),
    re.compile(r"must\s+hold\s+australian\s+citizenship", re.I),
    re.compile(r"australian\s+citizens?\s+only", re.I),
    re.compile(r"citizenship\s+is\s+required", re.I),
    re.compile(r"australian\s+citizenship\s+is\s+required", re.I),
]

# PR-required patterns → 'pr_required'
_PR_PATTERNS = [
    re.compile(r"permanent\s+resident", re.I),
    re.compile(r"must\s+have\s+the\s+right\s+to\s+work\s+permanently", re.I),
    re.compile(r"permanent\s+work\s+rights", re.I),
]

# Work-rights patterns → 'work_rights_required'
_WORK_RIGHTS_PATTERNS = [
    re.compile(r"right\s+to\s+work\s+in\s+australia", re.I),
    re.compile(r"eligible\s+to\s+work\s+in\s+australia", re.I),
    re.compile(r"australian\s+work\s+rights", re.I),
    re.compile(r"must\s+hold\s+a\s+valid\s+work\s+visa", re.I),
    re.compile(r"unrestricted\s+work\s+rights", re.I),
]

# Security clearance patterns → short label
_SECURITY_CLEARANCE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bNV1\b", re.I), "NV1"),
    (re.compile(r"\bNV2\b", re.I), "NV2"),
    (re.compile(r"negative\s+vetting", re.I), "Negative Vetting"),
    (re.compile(r"baseline\s+clearance", re.I), "Baseline"),
    (re.compile(r"\bAGSVA\s+clearance\b", re.I), "AGSVA"),
    (re.compile(r"security\s+clearance", re.I), "Security Clearance"),
]


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

_ISO_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_DDMMYYYY_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def _parse_iso_date(date_str: Any) -> str | None:
    """Normalise an input date value to ISO 8601 date (YYYY-MM-DD).

    Returns None when no recognisable date can be extracted.
    """
    if date_str is None:
        return None
    text = str(date_str).strip()
    if not text:
        return None
    m = _ISO_DATE_RE.match(text)
    if m:
        return m.group(1)
    m = _DDMMYYYY_RE.match(text)
    if m:
        return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
    return None


# ---------------------------------------------------------------------------
# Work-type extraction
# ---------------------------------------------------------------------------

_WORK_TYPE_MAP: dict[str, str] = {
    "full-time": "full-time",
    "full time": "full-time",
    "fulltime": "full-time",
    "ongoing": "full-time",
    "part-time": "part-time",
    "part time": "part-time",
    "parttime": "part-time",
    "casual": "casual",
    "temporary": "temporary",
    "contract": "contract",
    "permanent": "full-time",
}


def _extract_work_type(text: Any) -> str | None:
    """Map a free-text employment type to the standard enum."""
    if not text:
        return None
    lower = str(text).lower()
    for key, value in _WORK_TYPE_MAP.items():
        if key in lower:
            return value
    return None


# ---------------------------------------------------------------------------
# Classification fallback label
# ---------------------------------------------------------------------------

def _classification_label(raw_classification: str | None) -> str | None:
    """Map a raw NSW classification to an APS equivalent, else fallback.

    Returns:
    - The APS equivalent (e.g. ``"APS 6"``, ``"EL1"``) if mappable.
    - ``"NSW Gov — <raw>"`` for unmappable NSW-specific levels
      (e.g. Health Manager Level 2) per SYSTEM_DESIGN §3.
    - ``None`` if the raw input is empty.
    """
    if not raw_classification or not str(raw_classification).strip():
        return None
    raw_clean = str(raw_classification).strip()
    mapped = map_classification(raw_clean)
    if mapped is not None:
        return mapped
    # Unmappable — preserve original with NSW Gov prefix (em dash per SYSTEM_DESIGN)
    return f"NSW Gov \u2014 {raw_clean}"


# ---------------------------------------------------------------------------
# NSW Gov Scraper Adapter
# ---------------------------------------------------------------------------

class NswGovScraper(BaseScraper):
    """Scraper for iworkfor.nsw.gov.au (NSW Government Jobs).

    Implements:
    - Cloudflare bypass via TLS fingerprint rotation (chrome120 → chrome124 →
      firefox120 → edge101) with exponential backoff (2s, 4s, 8s) and graceful
      failure after exhaustion.
    - Dynamic Next.js ``buildId`` extraction from ``__NEXT_DATA__``.
    - Dual-path search fetching — ``/_next/data/{buildId}/jobs.json`` when a
      buildId is available, HTML listing page otherwise.
    - Build ID staleness retry (re-extract homepage buildId on first 404 from
      ``/_next/data/``).
    - Pagination honouring ``max_pages`` (≥2s rate limit between requests).
    - NSW classification → APS mapping via ``scrapers.classification_map``.
    - Salary parsing, visa-eligibility detection, security-clearance detection,
      and location hierarchy flattening.
    """

    def __init__(self, config: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if config is None:
            config = {}
        # Forward kwargs (keywords, location, max_pages) into config
        for key, value in kwargs.items():
            config.setdefault(key, value)
        # Conservative rate limiting — Cloudflare actively monitors patterns.
        config.setdefault("rpm", 10)
        config.setdefault("burst", 2)
        super().__init__(platform="nswgov", config=config)
        self._last_request_at: float | None = None
        self._build_id: str | None = None
        self._build_id_refreshed: bool = False

    # ------------------------------------------------------------------
    # Rate-limit helper — enforces ≥2s between outbound NSW requests.
    # ------------------------------------------------------------------

    def _enforce_min_interval(self) -> None:
        """Sleep so at least ``_MIN_REQUEST_INTERVAL_S`` has passed since the
        previous outbound request. Records the current monotonic time
        after sleeping so the interval accumulates across calls.
        """
        now = time.monotonic()
        if self._last_request_at is not None:
            elapsed = now - self._last_request_at
            if elapsed < _MIN_REQUEST_INTERVAL_S:
                time.sleep(_MIN_REQUEST_INTERVAL_S - elapsed)
        self._last_request_at = time.monotonic()

    def _nsw_http_get(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> tuple[int, Any, str]:
        """Rate-limited GET via the active session.

        Returns ``(status_code, headers, body)``. Raises on connection error.
        """
        self._enforce_min_interval()
        kwargs: dict[str, Any] = {"timeout": self.timeout}
        if params is not None:
            kwargs["params"] = params
        resp = self._session.get(url, **kwargs)
        return resp.status_code, resp.headers, (resp.text or "")

    def _nsw_http_post(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, Any, str]:
        """Rate-limited POST via the active session.

        Returns ``(status_code, headers, body)``. Raises on connection error.
        """
        self._enforce_min_interval()
        kwargs: dict[str, Any] = {"timeout": self.timeout}
        if json_body is not None:
            kwargs["json"] = json_body
        if extra_headers:
            kwargs["headers"] = extra_headers
        resp = self._session.post(url, **kwargs)
        return resp.status_code, resp.headers, (resp.text or "")

    # ------------------------------------------------------------------
    # Cloudflare bypass (T-A.1)
    # ------------------------------------------------------------------

    @staticmethod
    def _is_cloudflare_block(status: int, headers: Any, body: str) -> str | None:
        """Return a short reason string if response is a Cloudflare block.

        Detection heuristics per SYSTEM_DESIGN.md §6:
        - HTTP 403 + ``cf-ray`` header → hard block.
        - ``cf-mitigated`` header → block.
        - Body contains ``<title>Just a moment...`` or ``cf-challenge`` → challenge.
        """

        def _header(key: str) -> str | None:
            if headers is None:
                return None
            try:
                val = headers.get(key)
            except AttributeError:
                return None
            return val

        cf_ray = _header("cf-ray") or _header("CF-RAY") or _header("CF-Ray")
        cf_mitigated = _header("cf-mitigated") or _header("CF-Mitigated")

        if status == 403 and cf_ray:
            return f"403 with cf-ray={cf_ray}"
        if cf_mitigated:
            return f"cf-mitigated: {cf_mitigated}"
        if body:
            lowered = body.lower()
            if "just a moment..." in lowered and "<title>" in lowered:
                return "Cloudflare interstitial 'Just a moment...'"
            if "cf-challenge" in lowered:
                return "Cloudflare challenge page"
        return None

    def _bypass_cloudflare(self, url: str | None = None) -> str:
        """Fetch ``url`` rotating through TLS fingerprints.

        Replaces ``self._session`` with the successful fingerprint's session
        for subsequent requests. Raises ``RuntimeError`` after all fingerprints
        fail (cli.py catches this and exits cleanly with non-zero code).
        """
        target = url or _NSWGOV_HOMEPAGE
        last_reason = "no attempt made"

        for idx, fingerprint in enumerate(_CF_FINGERPRINTS):
            self._enforce_min_interval()
            session = Session(impersonate=fingerprint)
            session.headers.update({
                "Accept": "text/html,application/xhtml+xml,application/xml;"
                          "q=0.9,*/*;q=0.8",
                "Accept-Language": "en-AU,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
            })

            try:
                resp = session.get(target, timeout=self.timeout)
            except Exception as exc:
                last_reason = f"connection error: {exc!r}"
                self._emit_status(
                    "blocked",
                    f"Fingerprint {fingerprint}: {last_reason}",
                )
                try:
                    session.close()
                except Exception:
                    pass
                self._sleep_backoff(idx)
                continue

            status = resp.status_code
            body = resp.text or ""
            block_reason = self._is_cloudflare_block(status, resp.headers, body)

            if block_reason is not None:
                last_reason = block_reason
                self._emit_status(
                    "blocked",
                    f"Fingerprint {fingerprint}: Cloudflare detected ({block_reason})",
                )
                try:
                    session.close()
                except Exception:
                    pass
                self._sleep_backoff(idx)
                continue

            if status >= 400:
                last_reason = f"HTTP {status}"
                self._emit_status(
                    "warn",
                    f"Fingerprint {fingerprint}: HTTP {status}",
                )
                try:
                    session.close()
                except Exception:
                    pass
                self._sleep_backoff(idx)
                continue

            # Success — swap sessions so downstream requests share TLS fingerprint.
            try:
                self._session.close()
            except Exception:
                pass
            self._session = session
            self._request_count = 0
            self._emit_status(
                "cloudflare_bypass",
                f"bypass success with {fingerprint}",
            )
            return body

        raise RuntimeError(
            f"Cloudflare bypass failed after {len(_CF_FINGERPRINTS)} "
            f"fingerprint rotations (last: {last_reason})"
        )

    def _sleep_backoff(self, attempt_idx: int) -> None:
        """Sleep between fingerprint rotations (no sleep after the final attempt)."""
        if attempt_idx >= len(_CF_FINGERPRINTS) - 1:
            return
        backoff_idx = min(attempt_idx, len(_CF_BACKOFFS) - 1)
        time.sleep(_CF_BACKOFFS[backoff_idx])

    # ------------------------------------------------------------------
    # Next.js build ID extraction (T-A.1)
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_build_id(html: str) -> str | None:
        """Parse ``buildId`` from the ``__NEXT_DATA__`` script tag.

        Returns ``None`` when the tag is absent (spike showed it may be) or the
        JSON does not carry a ``buildId`` — the adapter then falls back to
        HTML scraping per SYSTEM_DESIGN.md §6.
        """
        if not html:
            return None
        try:
            soup = BeautifulSoup(html, "lxml")
        except Exception:
            return None
        script = soup.find("script", id="__NEXT_DATA__")
        if script is None or not script.string:
            return None
        try:
            data = json.loads(script.string)
        except (ValueError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict):
            return None
        build_id = data.get("buildId")
        if isinstance(build_id, str) and build_id:
            return build_id
        return None

    def _refresh_build_id(self) -> bool:
        """Re-fetch the homepage to obtain a fresh ``buildId``.

        Returns True if a new buildId was extracted; False otherwise.
        Only attempts the refresh once per scrape session to bound work.
        """
        if self._build_id_refreshed:
            return False
        self._build_id_refreshed = True
        try:
            self._enforce_min_interval()
            resp = self._session.get(_NSWGOV_HOMEPAGE, timeout=self.timeout)
        except Exception as exc:
            self._emit_status(
                "warn",
                f"buildId refresh homepage fetch failed: {exc!r}",
            )
            return False
        if resp.status_code >= 400:
            self._emit_status(
                "warn",
                f"buildId refresh homepage returned HTTP {resp.status_code}",
            )
            return False
        new_build_id = self._extract_build_id(resp.text or "")
        if new_build_id and new_build_id != self._build_id:
            self._build_id = new_build_id
            self._emit_status(
                "progress",
                f"buildId refreshed to {new_build_id}",
            )
            return True
        return False

    # ------------------------------------------------------------------
    # Salary parsing (T-A.2)
    # ------------------------------------------------------------------

    def _parse_salary(self, raw: Any) -> tuple[int | None, int | None]:
        """Parse a salary string into ``(salary_min, salary_max)``.

        Handles:
        - Range: ``"$100,000 - $120,000"`` → ``(100000, 120000)``
        - Range with "to": ``"$100,000 to $120,000 pa"`` → ``(100000, 120000)``
        - Single value: ``"$110,000 pa"`` → ``(110000, 110000)``
        - Hourly rate: ``"$55.00 per hour"`` → ``(114400, 114400)`` (×2080 annual)
        - Total remuneration: ``"Total remuneration package valued at $150,000"``
          → ``(150000, 150000)``
        - Unparseable: ``"Negotiable"`` → ``(None, None)``
        """
        if raw is None:
            return None, None
        text = str(raw).strip()
        if not text:
            return None, None

        # Hourly rate first — its "$X/hr" pattern would otherwise be matched
        # by the single-value regex as a plain $X.
        m = _SALARY_HOURLY_RE.search(text)
        if m:
            try:
                hourly = float(m.group(1).replace(",", "").replace("$", "").strip())
                annual = int(hourly * _HOURS_PER_YEAR)
                return annual, annual
            except (ValueError, TypeError):
                return None, None

        # Range pattern next — covers "$X - $Y" and "$X to $Y".
        m = _SALARY_RANGE_RE.search(text)
        if m:
            lo = _to_int(m.group(1))
            hi = _to_int(m.group(2))
            if lo is not None and hi is not None:
                return lo, hi

        # Single value last — matches the first "$X" in the text, which also
        # handles the "Total remuneration package valued at $150,000" case.
        m = _SALARY_SINGLE_RE.search(text)
        if m:
            val = _to_int(m.group(1))
            if val is not None:
                return val, val

        return None, None

    # ------------------------------------------------------------------
    # Visa / citizenship / security clearance detection (T-A.3)
    # ------------------------------------------------------------------

    def _detect_visa_eligibility(self, text: Any) -> str | None:
        """Return visa-eligibility enum or None (unknown) from description text.

        Returns one of ``'citizens_only'``, ``'pr_required'``,
        ``'work_rights_required'``, or ``None``. Default is None (unknown) —
        never "no requirement" per SYSTEM_DESIGN.md §7.
        """
        if not text:
            return None
        haystack = str(text)
        for pat in _CITIZEN_PATTERNS:
            if pat.search(haystack):
                return "citizens_only"
        for pat in _PR_PATTERNS:
            if pat.search(haystack):
                return "pr_required"
        for pat in _WORK_RIGHTS_PATTERNS:
            if pat.search(haystack):
                return "work_rights_required"
        return None

    def _detect_security_clearance(self, text: Any) -> str | None:
        """Return a short security-clearance label or None."""
        if not text:
            return None
        haystack = str(text)
        for pat, label in _SECURITY_CLEARANCE_PATTERNS:
            if pat.search(haystack):
                return label
        return None

    # ------------------------------------------------------------------
    # Location flattening (T-A.4)
    # ------------------------------------------------------------------

    def _flatten_location(self, loc: Any) -> str:
        """Flatten a location value to a readable string.

        Handles:
        - ``None`` → ``"NSW"`` (fallback per SYSTEM_DESIGN.md §7).
        - ``str`` → passthrough (stripped).
        - ad-core04 ``list`` of ``{"Name": ..., "Path": ...}`` dicts → joined names.
        - Legacy ``dict`` with ``displayText``/``region``/``suburb`` fields.
        """
        if loc is None:
            return "NSW"
        if isinstance(loc, str):
            s = loc.strip()
            return s if s else "NSW"

        # ad-core04 shape: list of dicts, each with Name + optional Path
        if isinstance(loc, list):
            names: list[str] = []
            for item in loc:
                if not isinstance(item, dict):
                    continue
                # Prefer Path (e.g. "Sydney / Sydney City") over just Name.
                path = item.get("Path") or item.get("path")
                name = item.get("Name") or item.get("name")
                if isinstance(path, str) and path.strip():
                    names.append(path.strip())
                elif isinstance(name, str) and name.strip():
                    names.append(name.strip())
            if names:
                return " / ".join(names[:3])  # cap at 3 to avoid runaway strings
            return "NSW"

        if isinstance(loc, dict):
            # ad-core04 single-location shape
            path = loc.get("Path")
            if isinstance(path, str) and path.strip():
                return path.strip()
            name = loc.get("Name")
            if isinstance(name, str) and name.strip():
                return name.strip()
            # Legacy Next.js shapes
            display = loc.get("displayText")
            if isinstance(display, str) and display.strip():
                return display.strip()
            region = loc.get("region")
            suburb = loc.get("suburb")
            region_s = region.strip() if isinstance(region, str) else ""
            suburb_s = suburb.strip() if isinstance(suburb, str) else ""
            if region_s and suburb_s:
                return f"{region_s} / {suburb_s}"
            if region_s:
                return region_s
            if suburb_s:
                return suburb_s
            return "NSW"
        # Unexpected type — stringify rather than crash.
        return str(loc)

    # ------------------------------------------------------------------
    # Search result fetching (T-A.1)
    # ------------------------------------------------------------------

    def _fetch_search_page(self, page: int) -> dict[str, Any] | None:
        """Fetch a single search-result page via ad-core04 backend API.

        Returns ``{"api": <parsed response dict>, "html": None}`` on success,
        ``None`` on irrecoverable failure. Falls back to HTML/Next.js paths
        only if the ad-core04 path errors out.
        """
        # Primary path: ad-core04 backend (post-2026 site migration).
        body = {
            "Locations": [],
            "Agencies": [],
            "Branches": [],
            "WorkTypes": [],
            "RoleTypes": [],
            "SalaryRanges": [],
            "PostedDates": [],
            "SearchTerm": self.keywords or "",
            "PageNumber": page,
            "PageSize": 20,
            "SortBy": "RelevanceDesc",
            "ForManageJobs": False,
            "IsInternalJob": False,
        }
        try:
            status, _headers, resp_body = self._nsw_http_post(
                _ADCORE_SEARCH_URL,
                json_body=body,
                extra_headers={
                    "Authorization": f"Bearer {_ADCORE_PUBLIC_TOKEN}",
                    "Content-Type": "application/json",
                    "Origin": _NSWGOV_BASE,
                    "Referer": _NSWGOV_BASE + "/",
                },
            )
            if status < 400:
                data = json.loads(resp_body)
                return {"api": data, "html": None}
            self._emit_status(
                "warn",
                f"ad-core04 search HTTP {status} page {page} — falling back",
            )
        except Exception as exc:
            self._emit_status(
                "warn",
                f"ad-core04 search error page {page}: {exc!r} — falling back",
            )

        # Legacy fallback (pre-2026 Next.js /_next/data/) — usually gone now.
        if self._build_id:
            api_url = f"{_NSWGOV_BASE}/_next/data/{self._build_id}/jobs.json"
            try:
                status, _headers, body = self._nsw_http_get(
                    api_url,
                    params={
                        "keyword": self.keywords,
                        "location": self.location,
                        "page": page,
                    },
                )
            except Exception as exc:
                self._emit_status(
                    "warn",
                    f"Next.js API fetch error page {page}: {exc!r} — HTML fallback",
                )
                return self._fetch_search_page_html(page)

            if status == 404:
                # Build ID may have gone stale — refresh and retry once.
                if self._refresh_build_id():
                    api_url = f"{_NSWGOV_BASE}/_next/data/{self._build_id}/jobs.json"
                    try:
                        status, _headers, body = self._nsw_http_get(
                            api_url,
                            params={
                                "keyword": self.keywords,
                                "location": self.location,
                                "page": page,
                            },
                        )
                    except Exception as exc:
                        self._emit_status(
                            "warn",
                            f"Post-refresh API fetch error page {page}: {exc!r}",
                        )
                        return self._fetch_search_page_html(page)
                    if status == 404:
                        self._emit_status(
                            "warn",
                            f"Persistent 404 on /_next/data/ — HTML fallback",
                        )
                        return self._fetch_search_page_html(page)
                else:
                    return self._fetch_search_page_html(page)

            if status >= 400:
                self._emit_status(
                    "warn",
                    f"API HTTP {status} on page {page} — HTML fallback",
                )
                return self._fetch_search_page_html(page)

            try:
                data = json.loads(body)
                return {"api": data, "html": None}
            except (ValueError, json.JSONDecodeError) as exc:
                self._emit_status(
                    "warn",
                    f"API JSON parse error page {page}: {exc!r} — HTML fallback",
                )
                return self._fetch_search_page_html(page)

        return self._fetch_search_page_html(page)

    def _fetch_search_page_html(self, page: int) -> dict[str, Any] | None:
        """HTML-listing fallback for a single search page."""
        try:
            status, _headers, body = self._nsw_http_get(
                _NSWGOV_SEARCH_URL,
                params={
                    "keyword": self.keywords,
                    "location": self.location,
                    "page": page,
                },
            )
        except Exception as exc:
            self._emit_status(
                "error",
                f"HTML search page {page} fetch failed: {exc!r}",
            )
            return None
        if status >= 400:
            self._emit_status(
                "error",
                f"HTML search page {page} returned HTTP {status}",
            )
            return None
        return {"api": None, "html": body}

    # ------------------------------------------------------------------
    # Parsing (T-A.1)
    # ------------------------------------------------------------------

    def _extract_jobs_from_api(self, api_data: Any) -> list[dict[str, Any]]:
        """Extract the list of raw job payloads from the API response.

        Handles:
        - ad-core04 format: ``{"Jobs": {"$values": [{"Job": {...}}, ...]}}``
          (items are wrapped in a container with a ``Job`` key).
        - Legacy Next.js pageProps format with ``jobResults`` / ``jobs``.
        """
        if not isinstance(api_data, dict):
            return []

        # ad-core04 format: Jobs is a .NET-serialized object with $values
        jobs_container = api_data.get("Jobs")
        if isinstance(jobs_container, dict) and "$values" in jobs_container:
            values = jobs_container["$values"]
            if isinstance(values, list):
                # Each item wraps the actual job under "Job" key
                extracted = []
                for item in values:
                    if isinstance(item, dict):
                        job = item.get("Job")
                        if isinstance(job, dict):
                            extracted.append(job)
                        else:
                            extracted.append(item)
                return extracted

        # Legacy Next.js pageProps format
        page_props = api_data.get("pageProps")
        if isinstance(page_props, dict):
            for key in ("jobResults", "jobs", "results", "items"):
                val = page_props.get(key)
                if isinstance(val, list):
                    return val
        for key in ("jobResults", "jobs", "results"):
            val = api_data.get(key)
            if isinstance(val, list):
                return val
        return []

    def _parse_job_from_api(self, payload: dict[str, Any]) -> JobRecord | None:
        """Convert an ad-core04 job payload (PascalCase keys) to a JobRecord."""
        if not isinstance(payload, dict):
            return None

        # ad-core04 uses PascalCase; fall back to legacy camelCase.
        title = _coerce_str(payload.get("Title") or payload.get("title"))
        if not title:
            return None

        # external_id priority: ReferenceNumber → ID → legacy
        external_id = _coerce_str(
            payload.get("ReferenceNumber")
            or payload.get("ID")
            or payload.get("id")
            or payload.get("referenceNumber")
            or payload.get("jobId")
        )

        # Company — BusinessName is the display name (e.g. "Department of
        # Customer Service"), AgencyName is shorter (e.g. "Customer Service").
        company = _coerce_str(
            payload.get("BusinessName")
            or payload.get("AgencyName")
            or payload.get("organisation")
            or payload.get("organization")
            or payload.get("agency")
        ) or "NSW Government"

        # Location: ad-core04 returns a list of {Name, Path} dicts under "Location"
        location_field = payload.get("Location") or payload.get("location")
        location = self._flatten_location(location_field)

        # Description: prefer plain text over HTMLDescription (will be
        # sanitized by Node-side sanitize-html anyway).
        description = _coerce_str(
            payload.get("Description")
            or payload.get("ShortDescription")
            or payload.get("HTMLDescription")
            or payload.get("description")
            or payload.get("summary")
        )

        # URL — build from SharingKey pattern: /job/<id>/<sharing-key>
        sharing_key = _coerce_str(payload.get("SharingKey"))
        job_id = _coerce_str(payload.get("ID") or payload.get("id"))
        url = _coerce_str(payload.get("url") or payload.get("jobUrl") or payload.get("link"))
        if not url and job_id and sharing_key:
            url = f"{_NSWGOV_BASE}/job/{job_id}/{sharing_key}"
        elif not url and job_id:
            url = f"{_NSWGOV_BASE}/job/{job_id}"
        if url and not url.startswith("http"):
            url = _NSWGOV_BASE + (url if url.startswith("/") else "/" + url)

        # Salary — ad-core04 has structured SalaryFrom / SalaryTo ints.
        salary_min: int | None = None
        salary_max: int | None = None
        salary_str: str | None = None
        sf = payload.get("SalaryFrom")
        st = payload.get("SalaryTo")
        if isinstance(sf, (int, float)) and sf > 0:
            salary_min = int(sf)
        if isinstance(st, (int, float)) and st > 0:
            salary_max = int(st)
        if salary_min and salary_max:
            salary_str = f"${salary_min:,} - ${salary_max:,}"
        elif salary_min:
            salary_str = f"${salary_min:,}"

        # Legacy fallback for older shape
        if salary_min is None:
            salary_payload = payload.get("salary")
            if isinstance(salary_payload, dict):
                sp_min = salary_payload.get("min")
                sp_max = salary_payload.get("max")
                if isinstance(sp_min, (int, float)) and isinstance(sp_max, (int, float)):
                    salary_min = int(sp_min)
                    salary_max = int(sp_max)
                salary_str = _coerce_str(salary_payload.get("displayText"))
                if salary_min is None and salary_str:
                    salary_min, salary_max = self._parse_salary(salary_str)
            elif isinstance(salary_payload, str):
                salary_str = salary_payload
                salary_min, salary_max = self._parse_salary(salary_payload)

        # Classification — not directly in ad-core04 payload; derive from title/description.
        raw_classification = _coerce_str(
            payload.get("Classification")
            or payload.get("classification")
            or payload.get("grade")
        )
        if not raw_classification:
            raw_classification = extract_classification(title) or extract_classification(description) or ""
        classification = _classification_label(raw_classification) if raw_classification else None

        # Dates: DateTo is closing, PublishDate/DateFrom is posted.
        closes_at = _parse_iso_date(
            payload.get("DateTo")
            or payload.get("closingDate")
            or payload.get("closesAt")
            or payload.get("closing_date")
        )
        posted_at = _parse_iso_date(
            payload.get("PublishDate")
            or payload.get("DateFrom")
            or payload.get("CreatedOn")
            or payload.get("postedDate")
            or payload.get("postedAt")
        )

        # Work type — WorkTypes is a list of {Name: "Full-Time"} dicts.
        work_type_raw: str | None = None
        wt_field = payload.get("WorkTypes") or payload.get("workType") or payload.get("jobType")
        if isinstance(wt_field, list) and wt_field:
            first = wt_field[0]
            if isinstance(first, dict):
                work_type_raw = _coerce_str(first.get("Name") or first.get("name"))
            else:
                work_type_raw = _coerce_str(first)
        else:
            work_type_raw = _coerce_str(wt_field)
        work_type = _extract_work_type(work_type_raw)

        # Visa + security clearance (scan title+description)
        combined = f"{title} {description}".strip()
        visa_req = self._detect_visa_eligibility(combined)
        security_clearance = self._detect_security_clearance(combined)

        if not external_id and url:
            external_id = f"nswgov-{abs(hash(url)) & 0xFFFFFFFF:08x}"
        if not external_id:
            return None

        raw_json = json.dumps(
            {
                "source": "api",
                "payload": payload,
                "security_clearance": security_clearance,
            },
            ensure_ascii=False,
            default=str,
        )

        return JobRecord(
            external_id=external_id if external_id.startswith("nswgov") else f"nswgov-{external_id}",
            platform="nswgov",
            title=title,
            company=company,
            location=location,
            description=description,
            url=url or _NSWGOV_SEARCH_URL,
            salary=salary_str,
            salary_min=salary_min,
            salary_max=salary_max,
            work_type=work_type,
            visa_requirement=visa_req,
            classification=classification,
            closes_at=closes_at,
            posted_at=posted_at,
            raw_json=raw_json,
        )

    def _parse_jobs_from_html(self, html: str) -> list[JobRecord]:
        """Extract JobRecord list from an HTML search page.

        The exact structure of iworkfor.nsw.gov.au listings is variable — this
        method is defensive: it looks for anchor tags pointing at ``/job/``
        slugs and scrapes surrounding metadata from the nearest card container.
        """
        if not html:
            return []
        try:
            soup = BeautifulSoup(html, "lxml")
        except Exception:
            return []

        jobs: list[JobRecord] = []
        seen_urls: set[str] = set()
        # Primary selector: anchors pointing at job-detail pages.
        for anchor in soup.find_all("a", href=True):
            href = anchor["href"]
            if not isinstance(href, str) or "/job/" not in href:
                continue
            if href in seen_urls:
                continue
            seen_urls.add(href)
            full_url = href if href.startswith("http") else _NSWGOV_BASE + (
                href if href.startswith("/") else "/" + href
            )
            title = anchor.get_text(strip=True)
            if not title:
                continue

            # Container for surrounding metadata.
            container = anchor.find_parent(["article", "li", "div"]) or anchor
            card_text = container.get_text(" ", strip=True) if container else ""

            # Description (best-effort: use the card text).
            description = card_text

            # Company / agency — look for common class hints.
            company = ""
            for el in container.find_all(class_=re.compile(r"organisation|agency|department|company", re.I)):
                t = el.get_text(strip=True)
                if t:
                    company = t
                    break
            if not company:
                company = "NSW Government"

            # Location hints.
            location_text = ""
            for el in container.find_all(class_=re.compile(r"location|region|suburb", re.I)):
                t = el.get_text(strip=True)
                if t:
                    location_text = t
                    break
            location = self._flatten_location(location_text or None)

            # Salary hints.
            salary_text = ""
            for el in container.find_all(class_=re.compile(r"salary|remuneration", re.I)):
                t = el.get_text(strip=True)
                if t:
                    salary_text = t
                    break
            salary_min, salary_max = self._parse_salary(salary_text) if salary_text else (None, None)

            # Classification from title or card text.
            raw_classification = (
                extract_classification(title) or extract_classification(card_text) or ""
            )
            classification = _classification_label(raw_classification) if raw_classification else None

            # Visa + security clearance
            combined = f"{title} {description}".strip()
            visa_req = self._detect_visa_eligibility(combined)
            security_clearance = self._detect_security_clearance(combined)

            work_type = _extract_work_type(card_text)

            external_id = _extract_external_id_from_url(full_url)
            if not external_id:
                external_id = f"nswgov-{abs(hash(full_url)) & 0xFFFFFFFF:08x}"

            raw_json = json.dumps(
                {
                    "source": "html",
                    "title": title,
                    "url": full_url,
                    "company": company,
                    "location_raw": location_text,
                    "salary_raw": salary_text,
                    "classification_raw": raw_classification,
                    "security_clearance": security_clearance,
                    "card_text": card_text[:4000],  # bounded for raw_json size
                },
                ensure_ascii=False,
                default=str,
            )

            jobs.append(JobRecord(
                external_id=external_id,
                platform="nswgov",
                title=title,
                company=company,
                location=location,
                description=description,
                url=full_url,
                salary=salary_text if salary_text else None,
                salary_min=salary_min,
                salary_max=salary_max,
                work_type=work_type,
                visa_requirement=visa_req,
                classification=classification,
                closes_at=None,
                posted_at=None,
                raw_json=raw_json,
            ))
        return jobs

    # ------------------------------------------------------------------
    # Pagination metadata (T-A.1)
    # ------------------------------------------------------------------

    @staticmethod
    def _has_more_pages(api_data: Any, current_page: int, page_size: int = 20) -> bool:
        """Return True if the API pagination metadata indicates more pages exist."""
        if not isinstance(api_data, dict):
            return False

        # ad-core04 exposes JobCount (total matching jobs across all pages).
        job_count = api_data.get("JobCount")
        if isinstance(job_count, int) and job_count > 0:
            total_pages = (job_count + page_size - 1) // page_size
            return current_page < total_pages

        page_props = api_data.get("pageProps")
        pagination = None
        if isinstance(page_props, dict):
            pagination = page_props.get("pagination")
        if not isinstance(pagination, dict):
            pagination = api_data.get("pagination") if isinstance(api_data, dict) else None
        if not isinstance(pagination, dict):
            return True  # assume more when no metadata
        total_pages = pagination.get("totalPages") or pagination.get("total_pages")
        if isinstance(total_pages, int):
            return current_page < total_pages
        return True

    # ------------------------------------------------------------------
    # Orchestration (T-A.1)
    # ------------------------------------------------------------------

    def scrape(self) -> list[dict]:
        """Run the NSW Gov scraper.

        Returns a list of job dicts (also emitted via JSON Lines).
        Raises RuntimeError on persistent Cloudflare block (cli.py handles).
        """
        all_jobs: list[dict] = []
        start_time = time.monotonic()

        self._emit_status("started", "NSW Gov scraper starting")

        # Step 1 — Cloudflare bypass + homepage fetch.
        homepage_html = self._bypass_cloudflare(_NSWGOV_HOMEPAGE)

        # Step 2 — build ID extraction (may be absent).
        self._build_id = self._extract_build_id(homepage_html)
        if self._build_id:
            self._emit_status("progress", f"buildId={self._build_id}")
        else:
            self._emit_status(
                "progress",
                "No __NEXT_DATA__.buildId — using HTML fallback path",
            )

        # Step 3 — paginated fetch honouring max_pages.
        jobs_found = 0
        for page in range(1, self.max_pages + 1):
            result = self._fetch_search_page(page)
            if result is None:
                break

            page_jobs: list[JobRecord] = []
            more_pages = True
            if result.get("api") is not None:
                api_data = result["api"]
                payloads = self._extract_jobs_from_api(api_data)
                for payload in payloads:
                    try:
                        rec = self._parse_job_from_api(payload)
                    except Exception as exc:
                        self._emit_status(
                            "error",
                            f"API parse error on page {page}: {exc!r}",
                        )
                        continue
                    if rec is not None:
                        page_jobs.append(rec)
                more_pages = self._has_more_pages(api_data, page)
            elif result.get("html"):
                page_jobs = self._parse_jobs_from_html(result["html"])
                # HTML fallback has no robust pagination signal — stop on empty.
                more_pages = bool(page_jobs)

            if not page_jobs:
                if page == 1:
                    self._emit_status(
                        "warn",
                        "Page 1 returned 0 results — possible Cloudflare soft-block",
                    )
                break

            for job in page_jobs:
                self._emit_job(job)
                all_jobs.append(job.to_dict())
                jobs_found += 1

            if not more_pages:
                break

        elapsed = time.monotonic() - start_time
        self._emit_status("completed", f"{jobs_found} jobs found in {elapsed:.1f}s")
        return all_jobs


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _coerce_str(value: Any) -> str:
    """Stringify a value, returning empty string for None."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _extract_external_id_from_url(url: str) -> str:
    """Extract a stable external_id from a NSW Gov job URL."""
    if not url:
        return ""
    m = re.search(r"/job/([A-Za-z0-9_\-]+)", url)
    if m:
        return f"nswgov-{m.group(1)}"
    return ""
