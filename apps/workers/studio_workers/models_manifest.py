"""Incremental model installs: models/manifest.json + resumable, verified downloads.

The manifest records every model file Studio downloaded (or found already on disk): name, path,
size, sha256 (+ md5 when the catalog publishes it), source URL and date. setup.ps1 uses it through
models_cli: ``--check`` lists present/missing, a normal run downloads only what is missing.

Downloads go to ``<file>.part`` and resume with an HTTP Range request when interrupted; the file
is verified (size, catalog hash, Hugging Face sha256 from X-Linked-Etag) before it replaces the
destination. Files already on disk are trusted when size and mtime match the manifest entry that
was verified earlier, so a re-run does not re-hash gigabytes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from .downloads import DownloadError, Expected, ProgressFn

log = logging.getLogger("studio_workers")

MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1
_HEX64 = re.compile(r"^[0-9a-f]{64}$")

# faster_whisper.utils._MODELS (used when faster_whisper is not importable, e.g. in --check).
WHISPER_REPOS: dict[str, str] = {
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "tiny": "Systran/faster-whisper-tiny",
    "base.en": "Systran/faster-whisper-base.en",
    "base": "Systran/faster-whisper-base",
    "small.en": "Systran/faster-whisper-small.en",
    "small": "Systran/faster-whisper-small",
    "medium.en": "Systran/faster-whisper-medium.en",
    "medium": "Systran/faster-whisper-medium",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large": "Systran/faster-whisper-large-v3",
    "distil-large-v2": "Systran/faster-distil-whisper-large-v2",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
    "distil-large-v3.5": "distil-whisper/distil-large-v3.5-ct2",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}
WHISPER_REQUIRED = ("model.bin", "config.json")


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def human_size(n: int | None) -> str:
    if n is None:
        return "?"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit in ("B", "KB") else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def hash_file(path: Path) -> tuple[str, str]:
    """(md5, sha256) of a file, streamed."""
    md5, sha = hashlib.md5(), hashlib.sha256()  # noqa: S324 - md5 only to match voices.json
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            md5.update(chunk)
            sha.update(chunk)
    return md5.hexdigest(), sha.hexdigest()


# ------------------------------------------------------------------------------------ manifest


@dataclass
class Manifest:
    root: Path
    files: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Packs fully installed (studio_workers/packs.py): {id: {"date", "files", "pip"}}. Additive key:
    # older readers ignore it.
    packs: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def path(self) -> Path:
        return self.root / MANIFEST_NAME

    @classmethod
    def load(cls, root: Path) -> Manifest:
        path = root / MANIFEST_NAME
        try:
            data = json.loads(path.read_text("utf-8")) if path.is_file() else {}
        except (OSError, ValueError):
            log.warning("models manifest unreadable; starting a new one")
            data = {}
        files = data.get("files") if isinstance(data, dict) else None
        packs = data.get("packs") if isinstance(data, dict) else None
        return cls(
            root=root,
            files=dict(files) if isinstance(files, dict) else {},
            packs=dict(packs) if isinstance(packs, dict) else {},
        )

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        data = {
            "version": MANIFEST_VERSION,
            "updated": now_iso(),
            "files": dict(sorted(self.files.items())),
        }
        if self.packs:
            data["packs"] = dict(sorted(self.packs.items()))
        tmp = self.path.with_name(MANIFEST_NAME + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
        tmp.replace(self.path)

    def get(self, rel: str) -> dict[str, Any] | None:
        entry = self.files.get(rel)
        return entry if isinstance(entry, dict) else None

    def record(
        self,
        rel: str,
        *,
        name: str,
        group: str,
        source: str,
        sha256: str | None,
        md5: str | None = None,
        adopted: bool = False,
    ) -> dict[str, Any]:
        st = (self.root / rel).stat()
        entry: dict[str, Any] = {
            "name": name,
            "group": group,
            "path": rel,
            "size": st.st_size,
            "sha256": sha256,
            "source": source,
            "date": now_iso(),
            "mtime_ns": st.st_mtime_ns,
        }
        if md5:
            entry["md5"] = md5
        if adopted:
            entry["adopted"] = True  # was on disk before the manifest existed
        self.files[rel] = entry
        return entry

    def groups(self) -> list[str]:
        return sorted({str(e.get("group")) for e in self.files.values() if e.get("group")})


def _trusted(entry: dict[str, Any] | None, path: Path) -> bool:
    """Size + mtime unchanged since the manifest verified this file."""
    if not entry:
        return False
    st = path.stat()
    return entry.get("size") == st.st_size and entry.get("mtime_ns") == st.st_mtime_ns


def _changed(entry: dict[str, Any], path: Path, size: int, deep: bool) -> bool:
    if entry.get("size") != size:
        return True
    return bool(deep and entry.get("sha256") and hash_file(path)[1] != entry["sha256"])


def _verified_earlier(
    entry: dict[str, Any] | None, size: int, known_md5: str | None, known_sha: str | None
) -> bool:
    """The manifest already verified this exact file (same size, sha256 recorded) and the new
    expectation has no hash to contradict it (models/manifest.json written by an older version)."""
    if not entry or known_md5 or known_sha:
        return False
    return entry.get("size") == size and bool(_HEX64.match(str(entry.get("sha256") or "")))


def verify_existing(
    path: Path, expected: Expected, entry: dict[str, Any] | None, *, deep: bool = False
) -> tuple[str, tuple[str, str] | None]:
    """('present' | 'missing' | 'corrupt', hashes computed or None)."""
    if not path.is_file():
        return "missing", None
    size = path.stat().st_size
    if size == 0:
        return "corrupt", None
    known_md5 = (expected.md5 or "").lower() or None
    known_sha = (expected.sha256 or "").lower() or None
    if expected.size_bytes is not None and size != expected.size_bytes:
        if not _verified_earlier(entry, size, known_md5, known_sha):
            return "corrupt", None
        # Upgrade tolerance: a size-only expectation (no published hash) that changed after this
        # file was downloaded and verified (sha256 recorded in the manifest). The recorded sha256
        # decides below (trusted size + mtime, or re-hash): never a re-download because of it.
        log.warning(
            "%s: %d bytes != %d expected by this version; kept (sha256 verified earlier)",
            path.name, size, expected.size_bytes,
        )  # fmt: skip
    if expected.min_bytes is not None and size < expected.min_bytes:
        return "corrupt", None
    if entry and entry.get("size") not in (None, size):
        return "corrupt", None
    if not deep and _trusted(entry, path):
        entry = entry or {}
        if known_md5 and entry.get("md5") not in (None, known_md5):
            return "corrupt", None
        if known_sha and entry.get("sha256") not in (None, known_sha):
            return "corrupt", None
        if (not known_md5 or entry.get("md5")) and (not known_sha or entry.get("sha256")):
            return "present", None
    needs_hash = deep or known_md5 or known_sha or (entry and entry.get("sha256"))
    if not needs_hash:
        return "present", None
    md5, sha = hash_file(path)
    if known_md5 and md5 != known_md5:
        return "corrupt", (md5, sha)
    if known_sha and sha != known_sha:
        return "corrupt", (md5, sha)
    if not known_sha and entry and entry.get("sha256") and entry["sha256"] != sha:
        return "corrupt", (md5, sha)
    return "present", (md5, sha)


# ------------------------------------------------------------------------- resumable download


_COMMIT = re.compile(r"^[0-9a-f]{40}$")


def _hf_commit(res: httpx.Response) -> str | None:
    """The commit a Hugging Face `resolve/<rev>/` URL resolved to (X-Repo-Commit header)."""
    for r in [*res.history, res]:
        value = (r.headers.get("x-repo-commit") or "").strip().lower()
        if _COMMIT.match(value):
            return value
    return None


def _hf_meta(res: httpx.Response) -> tuple[str | None, int | None]:
    """sha256 + size that Hugging Face publishes for LFS files (X-Linked-Etag / X-Linked-Size)."""
    sha: str | None = None
    size: int | None = None
    for r in [*res.history, res]:
        etag = (r.headers.get("x-linked-etag") or "").strip().removeprefix("W/").strip('"')
        if _HEX64.match(etag.lower()):
            sha = etag.lower()
        linked = r.headers.get("x-linked-size") or ""
        if linked.isdigit():
            size = int(linked)
    return sha, size


def _content_range_total(value: str | None) -> tuple[int | None, int | None]:
    """'bytes 100-199/200' -> (100, 200); 'bytes */200' -> (None, 200)."""
    m = re.match(r"bytes\s+(?:(\d+)-\d+|\*)/(\d+|\*)", value or "")
    if not m:
        return None, None
    start = int(m.group(1)) if m.group(1) else None
    total = int(m.group(2)) if m.group(2) != "*" else None
    return start, total


@dataclass
class FetchResult:
    size: int
    md5: str
    sha256: str
    resumed_from: int
    # Hugging Face `X-Repo-Commit` of a `resolve/<revision>/…` download (audit fix 13: the commit
    # `main` pointed to, recorded so later downloads pin it).
    repo_commit: str | None = None


def fetch_file(
    url: str,
    dest: Path,
    expected: Expected | None = None,
    *,
    client: httpx.Client | None = None,
    on_progress: ProgressFn | None = None,
    timeout: float = 60.0,
) -> FetchResult:
    """Download into dest.part (resuming with Range when it exists), verify, rename to dest.

    A network error keeps the .part for the next run. A verification failure deletes it; when
    the bad file came from a resumed download, it retries once from zero.
    """
    expected = expected or Expected()
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    own = client is None
    http = client or httpx.Client(follow_redirects=True, timeout=timeout)
    try:
        for attempt in (1, 2):
            resumed = part.stat().st_size if part.is_file() else 0
            if expected.size_bytes is not None and resumed > expected.size_bytes:
                part.unlink()
                resumed = 0
            commit: list[str] = []
            try:
                total, hf_sha = _stream(http, url, part, resumed, expected, on_progress, commit)
            except httpx.HTTPError as exc:
                raise DownloadError(
                    f"Error de red al descargar {url}: {exc} (se reanuda al reintentar)"
                ) from exc
            written = part.stat().st_size
            md5, sha = hash_file(part)
            problems: list[str] = []
            if total is not None and written != total:
                problems.append(f"descarga incompleta ({written}/{total} bytes)")
            if expected.size_bytes is not None and written != expected.size_bytes:
                problems.append(f"tamano {written} != esperado {expected.size_bytes}")
            if expected.min_bytes is not None and written < expected.min_bytes:
                problems.append(f"tamano {written} < minimo {expected.min_bytes}")
            if expected.md5 and md5 != expected.md5.lower():
                problems.append("md5 no coincide")
            if expected.sha256 and sha != expected.sha256.lower():
                problems.append("sha256 no coincide")
            if hf_sha and sha != hf_sha:
                problems.append("sha256 no coincide con el publicado por el servidor")
            if written == 0:
                problems.append("archivo vacio")
            if not problems:
                part.replace(dest)
                log.info("downloaded %s (%d bytes, resumed from %d)", dest, written, resumed)
                return FetchResult(written, md5, sha, resumed, commit[0] if commit else None)
            part.unlink(missing_ok=True)
            if resumed and attempt == 1:
                log.warning("%s: resumed file failed verification; restarting", dest.name)
                continue
            raise DownloadError(f"{dest.name}: " + "; ".join(problems))
        raise DownloadError(f"{dest.name}: no se pudo verificar")  # pragma: no cover
    finally:
        if own:
            http.close()


def _stream(
    http: httpx.Client,
    url: str,
    part: Path,
    offset: int,
    expected: Expected,
    on_progress: ProgressFn | None,
    commit: list[str] | None = None,
) -> tuple[int | None, str | None]:
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    with http.stream("GET", url, headers=headers) as res:
        hf_sha, hf_size = _hf_meta(res)
        rev = _hf_commit(res)
        if rev and commit is not None:
            commit.append(rev)
        if res.status_code == 416 and offset:
            # Range starts at/after EOF: the .part may already be complete; verification decides.
            _, total = _content_range_total(res.headers.get("content-range"))
            total = total or hf_size or expected.size_bytes
            if total is not None:
                return total, hf_sha
        if res.status_code == 416 and offset:
            # Unknown total: the .part cannot be verified; start over.
            part.unlink(missing_ok=True)
            return _stream(http, url, part, 0, expected, on_progress, commit)
        if res.status_code == 206 and offset:
            start, total = _content_range_total(res.headers.get("content-range"))
            if start != offset:
                part.unlink(missing_ok=True)
                raise DownloadError(f"El servidor respondio un rango inesperado para {url}")
            mode = "ab"
        elif res.status_code == 200:
            header = res.headers.get("content-length")
            total = int(header) if header and header.isdigit() else None
            offset, mode = 0, "wb"  # server ignored Range (or fresh download)
        else:
            raise DownloadError(f"HTTP {res.status_code} al descargar {url}")
        total = total or hf_size
        done = offset
        with part.open(mode) as fh:
            for chunk in res.iter_bytes():  # unbuffered: a cut keeps every byte received
                fh.write(chunk)
                done += len(chunk)
                if on_progress:
                    on_progress(done, total or expected.size_bytes)
        return total, hf_sha


# ----------------------------------------------------------------------------------- plan items


@dataclass
class ItemStatus:
    group: str
    name: str
    path: str
    state: str  # present | missing | partial | corrupt
    size: int | None = None
    expected_size: int | None = None
    source: str = ""


@dataclass(frozen=True)
class FileItem:
    group: str
    name: str
    rel: str  # posix path relative to the models root
    url: str
    expected: Expected

    def status(self, root: Path, manifest: Manifest, *, deep: bool = False) -> ItemStatus:
        path = root / self.rel
        state, hashes = verify_existing(path, self.expected, manifest.get(self.rel), deep=deep)
        if state == "missing" and path.with_name(path.name + ".part").is_file():
            state = "partial"
        if state == "present" and (hashes or not manifest.get(self.rel)):
            md5, sha = hashes or hash_file(path)
            manifest.record(
                self.rel,
                name=self.name,
                group=self.group,
                source=self.url,
                sha256=sha,
                md5=md5 if self.expected.md5 else None,
                adopted=not manifest.get(self.rel),
            )
        size = path.stat().st_size if path.is_file() else None
        if state == "partial":
            size = path.with_name(path.name + ".part").stat().st_size
        return ItemStatus(
            self.group, self.name, self.rel, state, size, self.expected.size_bytes, self.url
        )

    def fetch(
        self, root: Path, manifest: Manifest, client: httpx.Client | None, progress: ProgressFn
    ) -> int:
        res = fetch_file(
            self.url, root / self.rel, self.expected, client=client, on_progress=progress
        )
        entry = manifest.record(
            self.rel,
            name=self.name,
            group=self.group,
            source=self.url,
            sha256=res.sha256,
            md5=res.md5 if self.expected.md5 else None,
        )
        if res.repo_commit:
            entry["revision"] = res.repo_commit
        if not (self.expected.sha256 or self.expected.md5):
            # No published hash (e.g. SAM 2.1 on dl.fbaipublicfiles.com): this first download's
            # size + sha256 become the reference that later checks (--check, deep) compare to.
            entry["verified"] = "first-download"
        return res.size


WhisperDownloader = Callable[[Path, str], Path]


@dataclass(frozen=True)
class WhisperItem:
    """A faster-whisper model: a Hugging Face snapshot (huggingface_hub resumes it on its own)."""

    model: str
    downloader: WhisperDownloader | None = None

    @property
    def group(self) -> str:
        return f"whisper:{self.model}"

    @property
    def repo(self) -> str:
        try:
            from faster_whisper.utils import _MODELS  # noqa: PLC0415

            return str(_MODELS.get(self.model) or WHISPER_REPOS[self.model])
        except (ImportError, KeyError):
            return WHISPER_REPOS.get(self.model, f"Systran/faster-whisper-{self.model}")

    def cache_dir(self, root: Path) -> Path:
        return root / "whisper" / ("models--" + self.repo.replace("/", "--"))

    def snapshot(self, root: Path) -> Path | None:
        snaps = sorted((self.cache_dir(root) / "snapshots").glob("*"))
        for snap in reversed(snaps):
            if all((snap / f).is_file() for f in WHISPER_REQUIRED):
                return snap
        return None

    def status(self, root: Path, manifest: Manifest, *, deep: bool = False) -> ItemStatus:
        snap = self.snapshot(root)
        url = f"https://huggingface.co/{self.repo}"
        if snap is None:
            partial = any((self.cache_dir(root) / "blobs").glob("*.incomplete"))
            rel = self.cache_dir(root).relative_to(root).as_posix()
            return ItemStatus(
                self.group, self.model, rel, "partial" if partial else "missing", None, None, url
            )
        state = "present"
        total = 0
        for f in sorted(p for p in snap.iterdir() if p.is_file()):
            rel = f.relative_to(root).as_posix()
            entry = manifest.get(rel)
            st = f.stat()
            total += st.st_size
            if entry and _changed(entry, f, st.st_size, deep):
                state = "corrupt"
        if state == "present":
            self._record(root, manifest, snap, url)
        rel = snap.relative_to(root).as_posix()
        return ItemStatus(self.group, self.model, rel, state, total, None, url)

    def _record(self, root: Path, manifest: Manifest, snap: Path, url: str) -> None:
        for f in sorted(p for p in snap.iterdir() if p.is_file()):
            rel = f.relative_to(root).as_posix()
            entry = manifest.get(rel)
            if entry and _trusted(entry, f):
                continue
            blob = Path(os.path.realpath(f)).name.lower()
            sha = blob if _HEX64.match(blob) else hash_file(f)[1]
            manifest.record(
                rel,
                name=f"{self.model}/{f.name}",
                group=self.group,
                source=url,
                sha256=sha,
                adopted=entry is None,
            )

    def fetch(
        self, root: Path, manifest: Manifest, client: httpx.Client | None, progress: ProgressFn
    ) -> int:
        current = self.status(root, manifest)
        if current.state == "corrupt":
            shutil.rmtree(self.cache_dir(root), ignore_errors=True)
            for rel in [k for k, v in manifest.files.items() if v.get("group") == self.group]:
                manifest.files.pop(rel, None)
        downloader = self.downloader
        if downloader is None:
            from .stt.engine import download_model  # noqa: PLC0415

            downloader = download_model
        downloader(root, self.model)
        snap = self.snapshot(root)
        if snap is None:
            raise DownloadError(f"Whisper {self.model}: faltan {', '.join(WHISPER_REQUIRED)}")
        self._record(root, manifest, snap, f"https://huggingface.co/{self.repo}")
        return sum(p.stat().st_size for p in snap.iterdir() if p.is_file())


Item = FileItem | WhisperItem


# ---------------------------------------------------------------------------------- plan build


def piper_items(root: Path, voice_id: str, catalog: dict | None) -> list[FileItem]:
    from .tts import piper_catalog as pc  # noqa: PLC0415

    m = pc.VOICE_ID_RE.match(voice_id)
    if not m:
        raise ValueError(f"Id de voz Piper invalido: {voice_id}")
    if catalog is not None and voice_id not in catalog:
        raise ValueError(f"La voz {voice_id} no existe en el catalogo oficial de Piper")
    voice = pc.CATALOG.get(voice_id) or pc.CatalogVoice(voice_id, voice_id, "und", m["quality"])
    onnx_dst, json_dst = pc.voice_files(root, voice_id)
    items = []
    for remote, dst, min_bytes in zip(
        voice.remote_paths(), (onnx_dst, json_dst), (1_000_000, 200), strict=True
    ):
        info = ((catalog or {}).get(voice_id) or {}).get("files", {}).get(remote)
        if info:
            exp = Expected(size_bytes=info.get("size_bytes"), md5=info.get("md5_digest"))
        else:
            exp = Expected(min_bytes=min_bytes)
        items.append(
            FileItem(
                f"piper:{voice_id}",
                dst.name,
                dst.relative_to(root).as_posix(),
                f"{pc.PIPER_VOICES_BASE}/{remote}",
                exp,
            )
        )
    return items


def rvc_items(root: Path, *, legacy: bool) -> list[FileItem]:
    """Pack rvc-base (sprint 4: official URL + mirror fallback, see rvc_engine.BASE_ASSETS)."""
    from .rvc_engine import base_items  # noqa: PLC0415

    return base_items(root, legacy=legacy)


def build_plan(
    root: Path,
    *,
    piper: Iterable[str] = (),
    whisper: Iterable[str] = (),
    rvc_base: bool = False,
    rvc_legacy: bool = False,
    catalog: dict | None = None,
    whisper_downloader: WhisperDownloader | None = None,
) -> list[Item]:
    from .stt.engine import WHISPER_MODELS  # noqa: PLC0415

    plan: list[Item] = []
    for voice in dict.fromkeys(piper):
        plan.extend(piper_items(root, voice, catalog))
    for size in dict.fromkeys(whisper):
        if size not in WHISPER_MODELS:
            raise ValueError(f"Modelo Whisper desconocido: {size}")
        plan.append(WhisperItem(size, whisper_downloader))
    if rvc_base or rvc_legacy:
        plan.extend(rvc_items(root, legacy=rvc_legacy))
    return plan


def groups_to_args(groups: Iterable[str]) -> dict[str, Any]:
    """Manifest groups ('piper:<id>', 'whisper:<size>', 'rvc:base') back to build_plan kwargs."""
    out: dict[str, Any] = {"piper": [], "whisper": [], "rvc_base": False, "rvc_legacy": False}
    for g in groups:
        kind, _, value = g.partition(":")
        if kind == "piper" and value:
            out["piper"].append(value)
        elif kind == "whisper" and value:
            out["whisper"].append(value)
        elif g == "rvc:base":
            out["rvc_base"] = True
        elif g == "rvc:legacy":
            out["rvc_legacy"] = True
    return out
