"""Abstract base scraper with rate limiting, retry, and anti-detection."""

from __future__ import annotations

import io
import json
import random
import sys
import time
from abc import ABC, abstractmethod
from typing import Any

# Force UTF-8 on stdout/stderr to avoid Windows charmap encoding errors
# when job descriptions contain Unicode characters (e.g., \u2011 non-breaking hyphen)
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from curl_cffi.requests import Session

from scrapers.models import JobRecord

# TLS fingerprints to rotate through for anti-detection
_FINGERPRINTS: list[str] = [
    "chrome110",
    "chrome116",
    "chrome120",
]

# Randomised Accept-Language values
_ACCEPT_LANGUAGES: list[str] = [
    "en-AU,en;q=0.9",
    "en-US,en;q=0.9",
    "en-AU,en-US;q=0.9,en;q=0.8",
    "en;q=0.9",
]


class _TokenBucket:
    """Simple token-bucket rate limiter.

    Allows *burst* immediate requests, then enforces *requests_per_minute*
    steady-state throughput.  A random 1-3 s jitter is added after each
    consumed token to mimic human browsing cadence.
    """

    def __init__(self, requests_per_minute: int = 10, burst: int = 3) -> None:
        self.rpm = max(requests_per_minute, 1)
        self.burst = max(burst, 1)
        self.tokens = float(self.burst)
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self.tokens = min(self.burst, self.tokens + elapsed * (self.rpm / 60.0))
        self._last_refill = now

    def wait(self) -> None:
        """Block until a token is available, then add random jitter."""
        while True:
            self._refill()
            if self.tokens >= 1.0:
                break
            time.sleep(60.0 / self.rpm)

        self.tokens -= 1.0
        # Human-like random delay between requests
        time.sleep(random.uniform(1.0, 3.0))


class BaseScraper(ABC):
    """Abstract base class for all platform scrapers.

    Subclasses must implement :meth:`scrape` which yields/returns a list of
    :class:`JobRecord` instances.

    Parameters
    ----------
    platform:
        One of ``linkedin``, ``seek``, ``apsjobs``.
    config:
        Dict with keys ``keywords``, ``location``, ``max_pages`` and
        optionally ``rpm`` (requests per minute) and ``burst``.
    """

    # Retry configuration
    MAX_RETRIES: int = 3
    BACKOFF_BASE: float = 2.0  # seconds; doubles each attempt

    # Session rotation threshold
    _SESSION_ROTATE_REQUESTS: int = 50

    def __init__(self, platform: str, config: dict[str, Any]) -> None:
        self.platform = platform
        self.config = config
        self.keywords: str = config.get("keywords", "")
        self.location: str = config.get("location", "")
        self.max_pages: int = int(config.get("max_pages", 5))
        self.timeout: int = int(config.get("timeout", 30))

        rpm = int(config.get("rpm", 10))
        burst = int(config.get("burst", 3))
        self._rate_limiter = _TokenBucket(requests_per_minute=rpm, burst=burst)

        self._request_count: int = 0
        self._session: Session = self._new_session()

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    @staticmethod
    def _random_fingerprint() -> str:
        return random.choice(_FINGERPRINTS)

    def _new_session(self) -> Session:
        """Create a fresh curl_cffi Session with a random TLS fingerprint."""
        fp = self._random_fingerprint()
        session = Session(impersonate=fp)
        session.headers.update(
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": random.choice(_ACCEPT_LANGUAGES),
                "Accept-Encoding": "gzip, deflate, br",
            }
        )
        return session

    def _maybe_rotate_session(self) -> None:
        if self._request_count >= self._SESSION_ROTATE_REQUESTS:
            self._session.close()
            self._session = self._new_session()
            self._request_count = 0

    # ------------------------------------------------------------------
    # HTTP request wrapper
    # ------------------------------------------------------------------

    def _request(self, url: str, *, method: str = "GET", **kwargs: Any) -> str:
        """Rate-limited, retried HTTP request via *curl_cffi*.

        Returns the response body as a string.

        Retry policy
        ------------
        * HTTP 429 — honour ``Retry-After`` or wait 60 s, then retry.
        * HTTP 403 — rotate TLS fingerprint, retry once, then raise.
        * HTTP 5xx — exponential back-off (2 s, 8 s, 32 s).
        * Connection errors — exponential back-off.
        * Other HTTP errors — fail immediately.
        """
        last_exc: Exception | None = None

        for attempt in range(1, self.MAX_RETRIES + 1):
            self._rate_limiter.wait()
            self._maybe_rotate_session()

            try:
                kwargs.setdefault("timeout", self.timeout)
                if method.upper() == "GET":
                    resp = self._session.get(url, **kwargs)
                else:
                    resp = self._session.request(method, url, **kwargs)

                self._request_count += 1

                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", 60))
                    self._emit_status(
                        "rate_limited",
                        f"429 on {url}, waiting {retry_after}s (attempt {attempt})",
                    )
                    time.sleep(retry_after)
                    continue

                if resp.status_code == 403:
                    self._emit_status(
                        "blocked",
                        f"403 on {url}, rotating fingerprint (attempt {attempt})",
                    )
                    self._session.close()
                    self._session = self._new_session()
                    self._request_count = 0
                    if attempt < self.MAX_RETRIES:
                        continue
                    resp.raise_for_status()

                if resp.status_code >= 500:
                    wait = self.BACKOFF_BASE ** (2 * attempt - 1)
                    self._emit_status(
                        "server_error",
                        f"{resp.status_code} on {url}, retrying in {wait:.0f}s (attempt {attempt})",
                    )
                    time.sleep(wait)
                    continue

                resp.raise_for_status()
                return resp.text

            except Exception as exc:
                last_exc = exc
                if attempt < self.MAX_RETRIES:
                    wait = self.BACKOFF_BASE ** (2 * attempt - 1)
                    self._emit_status(
                        "connection_error",
                        f"{exc!r} on {url}, retrying in {wait:.0f}s (attempt {attempt})",
                    )
                    time.sleep(wait)
                else:
                    raise

        # All retries exhausted — re-raise the last exception
        raise last_exc  # type: ignore[misc]

    # ------------------------------------------------------------------
    # Output helpers (JSON Lines protocol)
    # ------------------------------------------------------------------

    @staticmethod
    def _emit_job(job: JobRecord) -> None:
        """Print a job record as a JSON line to stdout."""
        print(job.to_json_line(), flush=True)

    @staticmethod
    def _emit_status(status: str, message: str) -> None:
        """Print a status/progress line to stderr (and a JSON envelope to stdout)."""
        # Human-readable on stderr
        print(f"[{status}] {message}", file=sys.stderr, flush=True)
        # Machine-readable on stdout
        envelope = json.dumps(
            {"type": "status", "data": {"phase": status, "message": message}},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        print(envelope, flush=True)

    # ------------------------------------------------------------------
    # Abstract interface
    # ------------------------------------------------------------------

    @abstractmethod
    def scrape(self) -> list[dict]:
        """Run the scraper and return a list of job dicts.

        Implementations should call :meth:`_emit_job` for each job found and
        :meth:`_emit_status` for progress updates.
        """
        ...
