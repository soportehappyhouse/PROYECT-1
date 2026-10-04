"""Spanish Piper voices: catalog, local discovery and verified download.

Source: docs/trabajo/fuentes-audio.md §1.1 (rhasspy/piper-voices on Hugging Face). Sizes and md5
come from the official voices.json at download time instead of being hardcoded.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..downloads import DownloadError, Expected, ProgressFn, download, file_matches

log = logging.getLogger("studio_workers")

# `main` is what `python -m piper.download_voices` uses; `v1.0.0` also works for older voices.
PIPER_VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES_JSON_URL = f"{PIPER_VOICES_BASE}/voices.json"

VOICE_ID_RE = re.compile(
    r"^(?P<lang>[a-z]{2})_(?P<region>[A-Z]{2})-(?P<name>[^-]+)-(?P<quality>.+)$"
)


@dataclass(frozen=True)
class CatalogVoice:
    id: str
    name: str
    language: str  # BCP-47-ish, e.g. "es-AR"
    quality: str

    @property
    def parts(self) -> re.Match[str]:
        match = VOICE_ID_RE.match(self.id)
        if not match:  # pragma: no cover - catalog is static
            raise ValueError(self.id)
        return match

    def remote_paths(self) -> tuple[str, str]:
        m = self.parts
        folder = f"{m['lang']}/{m['lang']}_{m['region']}/{m['name']}/{m['quality']}"
        return f"{folder}/{self.id}.onnx", f"{folder}/{self.id}.onnx.json"


# Exact file names from rhasspy/piper VOICES.md (each voice = <id>.onnx + <id>.onnx.json).
SPANISH_VOICES: tuple[CatalogVoice, ...] = (
    CatalogVoice("es_AR-daniela-high", "Daniela (Argentina, rioplatense)", "es-AR", "high"),
    CatalogVoice("es_MX-claude-high", "Claude (Mexico)", "es-MX", "high"),
    CatalogVoice("es_MX-ald-medium", "Ald (Mexico)", "es-MX", "medium"),
    CatalogVoice("es_ES-davefx-medium", "Davefx (Espana)", "es-ES", "medium"),
    CatalogVoice("es_ES-sharvard-medium", "Sharvard (Espana, multi-voz)", "es-ES", "medium"),
    CatalogVoice("es_ES-mls_10246-low", "MLS 10246 (Espana, baja)", "es-ES", "low"),
    CatalogVoice("es_ES-mls_9972-low", "MLS 9972 (Espana, baja)", "es-ES", "low"),
    CatalogVoice("es_ES-carlfm-x_low", "Carlfm (Espana, muy baja)", "es-ES", "x_low"),
)
CATALOG = {v.id: v for v in SPANISH_VOICES}


def voice_dir(models_root: Path) -> Path:
    return models_root / "piper"


def installed_voice_ids(models_root: Path) -> list[str]:
    folder = voice_dir(models_root)
    if not folder.is_dir():
        return []
    ids = []
    for onnx in sorted(folder.glob("*.onnx")):
        if onnx.with_name(onnx.name + ".json").is_file():
            ids.append(onnx.stem)
    return ids


def voice_files(models_root: Path, voice_id: str) -> tuple[Path, Path]:
    if not VOICE_ID_RE.match(voice_id):
        raise ValueError(f"Id de voz Piper invalido: {voice_id}")
    folder = voice_dir(models_root)
    return folder / f"{voice_id}.onnx", folder / f"{voice_id}.onnx.json"


def describe(voice_id: str, models_root: Path) -> tuple[str, str, str | None]:
    """(display name, language, quality) for an installed or catalog voice."""
    if voice_id in CATALOG:
        v = CATALOG[voice_id]
        return v.name, v.language, v.quality
    m = VOICE_ID_RE.match(voice_id)
    language = f"{m['lang']}-{m['region']}" if m else "und"
    try:
        cfg = json.loads(voice_files(models_root, voice_id)[1].read_text("utf-8"))
        language = cfg.get("language", {}).get("code", language).replace("_", "-")
    except (OSError, ValueError):
        pass
    return voice_id, language, m["quality"] if m else None


def cached_voices_json(models_root: Path) -> dict | None:
    """voices.json from the local cache only (never touches the network)."""
    cache = voice_dir(models_root) / "voices.json"
    try:
        return json.loads(cache.read_text("utf-8")) if cache.is_file() else None
    except (OSError, ValueError):
        return None


def remote_size(catalog: dict | None, voice_id: str) -> int | None:
    voice = CATALOG.get(voice_id)
    if not catalog or not voice or voice_id not in catalog:
        return None
    info = catalog[voice_id].get("files", {}).get(voice.remote_paths()[0], {})
    size = info.get("size_bytes")
    return int(size) if isinstance(size, int) else None


def load_voices_json(
    models_root: Path, client: httpx.Client | None = None, refresh: bool = False
) -> dict | None:
    """Official catalog (sizes + md5). Cached in models/piper/voices.json; None if offline."""
    cache = voice_dir(models_root) / "voices.json"
    if cache.is_file() and not refresh:
        try:
            return json.loads(cache.read_text("utf-8"))
        except ValueError:
            pass
    try:
        download(VOICES_JSON_URL, cache, Expected(min_bytes=1000), client=client)
        return json.loads(cache.read_text("utf-8"))
    except (DownloadError, ValueError) as exc:
        log.warning("voices.json unavailable (%s); falling back to size checks", exc)
        return None


def _expected(catalog: dict | None, voice_id: str, remote_path: str, min_bytes: int) -> Expected:
    info = ((catalog or {}).get(voice_id) or {}).get("files", {}).get(remote_path)
    if info:
        return Expected(size_bytes=info.get("size_bytes"), md5=info.get("md5_digest"))
    return Expected(min_bytes=min_bytes)


def download_voice(
    models_root: Path,
    voice_id: str,
    *,
    force: bool = False,
    client: httpx.Client | None = None,
    on_progress: ProgressFn | None = None,
) -> list[tuple[Path, int, bool]]:
    """Download <id>.onnx + <id>.onnx.json. Returns [(path, bytes, skipped)]."""
    m = VOICE_ID_RE.match(voice_id)
    if not m:
        raise ValueError(f"Id de voz Piper invalido: {voice_id}")
    voice = CATALOG.get(voice_id) or CatalogVoice(voice_id, voice_id, "und", m["quality"])
    onnx_remote, json_remote = voice.remote_paths()
    onnx_dst, json_dst = voice_files(models_root, voice_id)
    catalog = load_voices_json(models_root, client=client)
    if catalog is not None and voice_id not in catalog:
        raise ValueError(f"La voz {voice_id} no existe en el catalogo oficial de Piper")
    results: list[tuple[Path, int, bool]] = []
    for remote, dst, min_bytes in (
        (onnx_remote, onnx_dst, 1_000_000),
        (json_remote, json_dst, 200),
    ):
        expected = _expected(catalog, voice_id, remote, min_bytes)
        if not force and file_matches(dst, expected):
            results.append((dst, dst.stat().st_size, True))
            continue
        size = download(
            f"{PIPER_VOICES_BASE}/{remote}", dst, expected, client=client, on_progress=on_progress
        )
        results.append((dst, size, False))
    return results
