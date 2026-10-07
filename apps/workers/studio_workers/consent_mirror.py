"""Workers-side check of the consents (audit fix 4).

The api rewrites ``storage/consent/active.json`` on every change of a Person, consent or licence
and when it starts::

    {"consents": [{"personId", "consentId", "scope", "expires_at", "photo_paths": [...],
                   "sample_paths": [...]}], "updated_at": ...}

with only the VALID consents and the STORAGE_DIR-relative files each one covers. FaceFusion and
Chatterbox only run when the ``consent_id`` they are given is in that mirror (not expired, right
scope) and every source photo / voice sample is under ``consent/persons/<thatPersonId>/`` AND listed
for that consent. A non-empty id is no longer enough. Any problem reading the mirror = no consent.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal

CONSENT_MIRROR_REL = Path("consent") / "active.json"

Need = Literal["face", "voice"]


def read_mirror(storage_root: Path) -> list[dict[str, Any]] | None:
    try:
        data = json.loads((storage_root / CONSENT_MIRROR_REL).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    rows = data.get("consents") if isinstance(data, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else None


def _expired(raw: Any, now: datetime) -> bool:
    if raw in (None, ""):
        return False
    try:
        when = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return True  # unreadable expiry: fail closed
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when <= now


def _key(rel: str) -> str:
    """Comparison key of a STORAGE_DIR-relative path (case-insensitive on Windows)."""
    p = PurePosixPath(rel.replace("\\", "/")).as_posix()
    return p.lower() if os.name == "nt" else p


def _denied(reason: str, need: Need, person_id: str | None) -> Exception:
    from .errors import CodedError  # noqa: PLC0415 - errors imports packs (cycle)

    what = "su cara" if need == "face" else "su voz"
    motivo = {
        "none": "sin consentimiento",
        "expired": "vencido",
        "scope": "el consentimiento no cubre ese uso",
        "file": "el archivo no está cubierto por el consentimiento",
    }.get(reason, reason)
    return CodedError(
        "CONSENT_REQUIRED",
        f"La persona no tiene un consentimiento vigente para usar {what} ({motivo}). "
        "Registralo en Ajustes → Personas.",
        details={
            "personId": person_id or "?",
            "scope": need,
            "reason": "scope" if reason == "file" else reason,
        },
    )


def require_consent(
    storage_root: Path,
    consent_id: str,
    need: Need,
    rel_paths: list[str],
    *,
    now: datetime | None = None,
) -> str:
    """Raise CONSENT_REQUIRED unless `consent_id` is a valid consent of the mirror that covers
    `need` and lists every path of `rel_paths` (STORAGE_DIR-relative, under
    consent/persons/<itsPerson>/). Returns the personId."""
    rows = read_mirror(storage_root)
    entry = next((r for r in rows or [] if r.get("consentId") == consent_id), None)
    if entry is None:
        raise _denied("none", need, None)
    person_id = str(entry.get("personId") or "")
    if entry.get("scope") not in (need, "both"):
        raise _denied("scope", need, person_id)
    if _expired(entry.get("expires_at"), now or datetime.now(UTC)):
        raise _denied("expired", need, person_id)
    listed = entry.get("photo_paths" if need == "face" else "sample_paths") or []
    allowed = {_key(str(p)) for p in listed if isinstance(p, str)}
    prefix = _key(f"consent/persons/{person_id}/")
    if not rel_paths:
        raise _denied("file", need, person_id)
    for rel in rel_paths:
        key = _key(rel)
        if not person_id or not key.startswith(prefix) or key not in allowed:
            raise _denied("file", need, person_id)
    return person_id
