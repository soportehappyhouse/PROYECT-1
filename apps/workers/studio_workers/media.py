"""Small FFmpeg / WAV helpers (FFmpeg is spawned directly, never through a shell)."""

from __future__ import annotations

import shutil
import subprocess
import wave
from functools import lru_cache
from pathlib import Path

from .config import get_settings


class FfmpegNotFoundError(RuntimeError):
    pass


def find_ffmpeg() -> str | None:
    configured = get_settings().ffmpeg_path.strip()
    if configured:
        return configured if Path(configured).exists() else None
    return shutil.which("ffmpeg")


@lru_cache(maxsize=4)
def ffmpeg_version(path: str) -> str | None:
    try:
        out = subprocess.run(
            [path, "-hide_banner", "-version"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    first = out.stdout.splitlines()[0] if out.stdout else ""
    return first.removeprefix("ffmpeg version ").split(" ")[0] or None


def run_ffmpeg(args: list[str], timeout: float = 600.0) -> None:
    exe = find_ffmpeg()
    if not exe:
        raise FfmpegNotFoundError(
            "ffmpeg no encontrado: instalalo (setup.ps1) o defini FFMPEG_PATH en .env"
        )
    proc = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg fallo ({proc.returncode}): {proc.stderr.strip()[-500:]}")


def wav_to_mp3(src: Path, dst: Path, quality: int = 2) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(["-i", str(src), "-codec:a", "libmp3lame", "-q:a", str(quality), str(dst)])


def to_wav(
    src: Path,
    dst: Path,
    sample_rate: int | None = None,
    mono: bool = False,
    channels: int | None = None,
) -> None:
    """Decode ``src`` to 16-bit PCM WAV. ``channels`` (e.g. 2) downmixes 5.1/7.1 with ``-ac N``."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    args = ["-i", str(src), "-vn"]
    if mono:
        args += ["-ac", "1"]
    elif channels:
        args += ["-ac", str(int(channels))]
    if sample_rate:
        args += ["-ar", str(sample_rate)]
    run_ffmpeg([*args, "-c:a", "pcm_s16le", str(dst)])


def wav_info(path: Path) -> tuple[float, int]:
    """Return (duration_sec, sample_rate) of a PCM WAV file."""
    with wave.open(str(path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
    return (frames / float(rate) if rate else 0.0), rate
