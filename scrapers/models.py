"""Job record data model for the JSON Lines output protocol."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass


@dataclass
class JobRecord:
    """Unified job record schema emitted by all platform adapters."""

    external_id: str
    platform: str  # linkedin|seek|apsjobs
    title: str
    company: str
    location: str
    description: str
    url: str
    salary: str | None  # formatted salary string, e.g. "$120,000 - $140,000"
    salary_min: int | None
    salary_max: int | None
    work_type: str | None  # full-time|part-time|contract|casual
    visa_requirement: str | None
    classification: str | None  # APS level (APS1-6, EL1-2, SES)
    closes_at: str | None  # ISO date
    posted_at: str | None  # ISO date
    raw_json: str  # original response preserved

    def to_dict(self) -> dict:
        """Convert to a plain dict suitable for JSON serialisation."""
        return asdict(self)

    def to_json_line(self) -> str:
        """Serialise as a single JSON line (JSON Lines protocol).

        Wraps the record in ``{"type": "job", "data": {...}}`` envelope
        expected by the Node.js integration layer.
        """
        envelope = {
            "type": "job",
            "data": self.to_dict(),
        }
        return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
