"""Verified HTTP downloads for model files (atomic: <file>.part -> rename)."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger("studio_workers")

ProgressFn = Callable[[int, int | None], None]


class DownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class Expected:
    """What a downloaded file must satisfy. Any unset field is not checked."""

    size_bytes: int | None = None
    min_bytes: int | None = None
    md5: str | None = None
    sha256: str | None = None


def file_matches(path: Path, expected: Expected) -> bool:
    """Cheap check used to skip downloads: size (+ hashes when known)."""
    if not path.is_file():
        return False
    size = path.stat().st_size
    if expected.size_bytes is not None and size != expected.size_bytes:
        return False
    if expected.min_bytes is not None and size < expected.min_bytes:
        return False
    if expected.md5 or expected.sha256:
        md5, sha = _hash_file(path)
        if expected.md5 and md5 != expected.md5.lower():
            return False
        if expected.sha256 and sha != expected.sha256.lower():
            return False
    return size > 0


def _hash_file(path: Path) -> tuple[str, str]:
    md5, sha = hashlib.md5(), hashlib.sha256()  # noqa: S324 - md5 only to match voices.json
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            md5.update(chunk)
            sha.update(chunk)
    return md5.hexdigest(), sha.hexdigest()


def download(
    url: str,
    dest: Path,
    expected: Expected | None = None,
    *,
    timeout: float = 60.0,
    on_progress: ProgressFn | None = None,
    client: httpx.Client | None = None,
) -> int:
    """Download url to dest, verifying Content-Length, size bounds and hashes. Returns bytes."""
    expected = expected or Expected()
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    md5, sha = hashlib.md5(), hashlib.sha256()  # noqa: S324
    written = 0
    own_client = client is None
    http = client or httpx.Client(follow_redirects=True, timeout=timeout)
    try:
        with http.stream("GET", url) as res:
            if res.status_code != 200:
                raise DownloadError(f"HTTP {res.status_code} al descargar {url}")
            header = res.headers.get("content-length")
            total = int(header) if header and header.isdigit() else None
            with part.open("wb") as fh:
                for chunk in res.iter_bytes(1 << 20):
                    fh.write(chunk)
                    md5.update(chunk)
                    sha.update(chunk)
                    written += len(chunk)
                    if on_progress:
                        on_progress(written, total or expected.size_bytes)
        problems: list[str] = []
        if total is not None and written != total:
            problems.append(f"descarga incompleta ({written}/{total} bytes)")
        if expected.size_bytes is not None and written != expected.size_bytes:
            problems.append(f"tamano {written} != esperado {expected.size_bytes}")
        if expected.min_bytes is not None and written < expected.min_bytes:
            problems.append(f"tamano {written} < minimo {expected.min_bytes}")
        if expected.md5 and md5.hexdigest() != expected.md5.lower():
            problems.append("md5 no coincide")
        if expected.sha256 and sha.hexdigest() != expected.sha256.lower():
            problems.append("sha256 no coincide")
        if written == 0:
            problems.append("archivo vacio")
        if problems:
            raise DownloadError(f"{dest.name}: " + "; ".join(problems))
        part.replace(dest)
        log.info("downloaded %s (%d bytes)", dest, written)
        return written
    except httpx.HTTPError as exc:
        raise DownloadError(f"Error de red al descargar {url}: {exc}") from exc
    finally:
        if own_client:
            http.close()
        if part.exists():
            part.unlink(missing_ok=True)
