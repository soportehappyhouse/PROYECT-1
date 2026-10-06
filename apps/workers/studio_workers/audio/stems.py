"""Source separation ("stems") with Demucs v4 ``htdemucs`` (pack ``stems``; MIT code + weights).

Modes: ``two`` = vocals + no_vocals (what ``demucs --two-stems=vocals`` writes: no_vocals is the sum
of the other sources) and ``four`` = vocals / drums / bass / other. Outputs are 16-bit PCM WAV at
44.1 kHz stereo (the model rate), written next to ``output_base`` as ``<base>-<stem>.wav``.

The model runs on our own overlap-add loop over ``segment``-second chunks (7 s on <= 6-7 GB cards,
the value the demucs README recommends; 7.8 s, the htdemucs training length, otherwise) with the
same triangular cross-fade demucs' ``apply_model(split=True)`` uses, so we can report progress per
chunk and stream the result to disk (only one chunk of output is kept in memory). Each chunk goes
through ``demucs.apply.apply_model(split=False)`` (HTDemucs padding/trim rules stay demucs').

Weights: ``models/demucs/955717e8-8726e21a.th`` from the official URL of demucs' remote/files.txt
(the signature htdemucs.yaml points to). demucs names files ``<sig>-<sha256[:8]>.th``.
``verify_weights`` checks exact size + full sha256 when packs.py pins them, otherwise the prefix +
the size/sha256 recorded at the first download (with a warning). The file is a pickled package
(class + kwargs + state) that torch>=2.6 refuses with its default ``weights_only=True``: it is
loaded with ``weights_only=False`` only after that check (demucs 4.0.1's loader predates it).

Long files: the decoded WAV (downmixed to stereo) stays on disk and is read chunk by chunk (the
normalization is computed block by block first), so RAM stays at a few segments at any duration.

GPU: through the GPU budget (~2 GB, ``STEMS_VRAM_MB``); not enough VRAM or a CUDA failure -> CPU
with ``warnings: ["gpu_fallback_cpu"]``. Tests inject a fake ``loader`` (no torch in CI).
"""

from __future__ import annotations

import hashlib
import logging
import math
import tempfile
import threading
import wave
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ..config import Settings
from ..gpu import GPU_FALLBACK_CPU, GpuBudget
from ..media import to_wav
from ..models_manifest import Manifest
from ..packs import STEMS_WEIGHTS_EXACT_SIZE as WEIGHTS_SIZE
from ..packs import STEMS_WEIGHTS_SHA256 as WEIGHTS_SHA256
from ..packs import STEMS_WEIGHTS_SHA256_PREFIX as WEIGHTS_SHA_PREFIX
from ..packs import PackRequiredError, module_present, stems_weights_path

log = logging.getLogger("studio_workers")

Mode = Literal["two", "four"]
SAMPLE_RATE = 44_100
CHANNELS = 2
BUDGET_KEY = "demucs-htdemucs"
STEMS_VRAM_MB = 2000  # htdemucs fp32, segment 7 s, batch 1 (~1.6-2 GB measured by the community)
SEGMENT_LOW_VRAM_S = 7.0  # demucs README: "--segment 7" for GPUs with <= 6-7 GB
SEGMENT_MAX_S = 7.8  # htdemucs training segment (39/5 s): longer chunks are rejected
LOW_VRAM_TOTAL_MB = 7 * 1024
OVERLAP = 0.25
STEMS: dict[str, tuple[str, ...]] = {
    "two": ("vocals", "no_vocals"),
    "four": ("vocals", "drums", "bass", "other"),
}
HTDEMUCS_SOURCES = ("drums", "bass", "other", "vocals")

# progress(fraction 0..1, Spanish message)
Progress = Callable[[float, str], None]


@dataclass
class Separator:
    """A loaded model: ``run(chunk (C, n) float32 normalized, segment_s) -> (S, C, n)``."""

    sources: tuple[str, ...]
    run: Callable[[Any, float], Any]
    unload: Callable[[], None] = field(default=lambda: None)


# device ("cuda" | "cpu") -> Separator. Tests inject a fake.
Loader = Callable[[str], Separator]


def segment_for(vram_total_mb: int | None) -> float:
    """7 s on <= 6-7 GB cards (or unknown VRAM), the full 7.8 s training length otherwise."""
    if vram_total_mb is None or vram_total_mb <= LOW_VRAM_TOTAL_MB:
        return SEGMENT_LOW_VRAM_S
    return SEGMENT_MAX_S


def chunk_offsets(length: int, segment_len: int, overlap: float = OVERLAP) -> list[int]:
    stride = max(1, int((1 - overlap) * segment_len))
    return list(range(0, max(1, length), stride))


def triangle_weight(segment_len: int) -> Any:
    """demucs apply_model's cross-fade window (transition_power 1), max 1 in the middle."""
    import numpy as np  # noqa: PLC0415

    half = segment_len // 2
    w = np.concatenate([np.arange(1, half + 1), np.arange(segment_len - half, 0, -1)]).astype(
        np.float32
    )
    return w / w.max()


# Frames read per block when computing the normalization of a WAV on disk (60 s ≈ 10 MB).
STATS_BLOCK_FRAMES = SAMPLE_RATE * 60


def _pcm_to_float(frames: bytes, channels: int) -> Any:
    """16-bit PCM -> float32 (CHANNELS, n): mono is duplicated, extra channels are dropped."""
    import numpy as np  # noqa: PLC0415

    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    data = pcm.reshape(-1, channels).T
    if channels == 1:
        data = data.repeat(CHANNELS, axis=0)
    return np.ascontiguousarray(data[:CHANNELS])


class _ArrayMix:
    """Audio already in memory, (C, n) float32."""

    def __init__(self, mix: Any) -> None:
        self.mix = mix
        self.channels, self.length = mix.shape

    def stats(self) -> tuple[float, float]:
        ref = self.mix.mean(axis=0)
        return (float(ref.mean()), float(ref.std())) if self.length else (0.0, 1.0)

    def read(self, offset: int, n: int) -> Any:
        return self.mix[:, offset : offset + n]


class _WavMix:
    """16-bit PCM WAV read by ranges, so a long file never sits whole in RAM."""

    def __init__(self, path: Path) -> None:
        self._wf = wave.open(str(path), "rb")  # noqa: SIM115 - closed in close()
        self._src_channels = self._wf.getnchannels()
        self.channels = CHANNELS
        self.length = self._wf.getnframes()

    def __enter__(self) -> _WavMix:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._wf.close()

    def read(self, offset: int, n: int) -> Any:
        n = max(0, min(n, self.length - offset))
        self._wf.setpos(offset)
        return _pcm_to_float(self._wf.readframes(n), self._src_channels)

    def stats(self) -> tuple[float, float]:
        """Mean/std of the mono reference (same as ``mix.mean(0)``), block by block in float64."""
        import numpy as np  # noqa: PLC0415

        if not self.length:
            return 0.0, 1.0
        total = total_sq = 0.0
        for start in range(0, self.length, STATS_BLOCK_FRAMES):
            ref = self.read(start, STATS_BLOCK_FRAMES).mean(axis=0).astype(np.float64)
            total += float(ref.sum())
            total_sq += float(np.square(ref).sum())
        mean = total / self.length
        return mean, math.sqrt(max(total_sq / self.length - mean * mean, 0.0))


class _StemWriters:
    """One 16-bit WAV per output stem, appended chunk by chunk."""

    def __init__(self, paths: dict[str, Path]) -> None:
        self.paths = paths
        self._w: dict[str, wave.Wave_write] = {}
        for name, p in paths.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            wf = wave.open(str(p), "wb")  # noqa: SIM115 - closed in close()
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            self._w[name] = wf

    def write(self, name: str, data: Any) -> None:
        import numpy as np  # noqa: PLC0415

        pcm = (np.clip(data, -1.0, 1.0) * 32767.0).round().astype("<i2")
        self._w[name].writeframes(pcm.T.copy().tobytes())

    def close(self) -> None:
        for wf in self._w.values():
            wf.close()


def separate_array(
    mix: Any | _ArrayMix | _WavMix,
    separator: Separator,
    stems: Sequence[str],
    writers: _StemWriters,
    *,
    segment_s: float,
    progress: Progress | None = None,
    sample_rate: int = SAMPLE_RATE,
) -> int:
    """Overlap-add separation of ``mix`` streamed to ``writers``. Returns the chunk count.

    ``mix`` is a (C, n) array or a ``_WavMix`` (read chunk by chunk from disk: memory stays at a few
    segments whatever the duration).

    Same normalization as ``demucs.separate`` (mono reference mean/std) and the same triangular
    cross-fade as ``apply_model(split=True)``. A sample is final once the next chunk starts after
    it, so everything before the next offset is written and dropped from the accumulator.
    """
    import numpy as np  # noqa: PLC0415

    src = mix if isinstance(mix, (_ArrayMix, _WavMix)) else _ArrayMix(mix)
    channels, length = src.channels, src.length
    mean, std = src.stats()
    std = std if std > 1e-8 else 1.0
    seg = max(1, int(sample_rate * segment_s))
    weight = triangle_weight(seg)
    offsets = chunk_offsets(length, seg)
    n_src = len(separator.sources)
    index = {name: i for i, name in enumerate(separator.sources)}
    others = [i for name, i in index.items() if name != "vocals"]
    acc = np.zeros((n_src, channels, 0), dtype=np.float32)
    acc_w = np.zeros(0, dtype=np.float32)
    base = 0  # absolute sample index of acc[..., 0]

    def flush(upto: int) -> None:
        nonlocal acc, acc_w, base
        k = upto - base
        if k <= 0:
            return
        out = acc[..., :k] / np.maximum(acc_w[:k], 1e-8)
        out = out * std + mean
        for name in stems:
            data = out[others].sum(axis=0) if name == "no_vocals" else out[index[name]]
            writers.write(name, data)
        acc = acc[..., k:]
        acc_w = acc_w[k:]
        base = upto

    for i, offset in enumerate(offsets):
        chunk = ((src.read(offset, seg) - mean) / std).astype(np.float32)
        n = chunk.shape[-1]
        y = np.asarray(separator.run(np.ascontiguousarray(chunk), segment_s), dtype=np.float32)
        if y.shape != (n_src, channels, n):
            raise RuntimeError(
                f"El separador devolvio {y.shape}, se esperaba {(n_src, channels, n)}"
            )
        need = offset + n - base
        if acc.shape[-1] < need:
            grow = need - acc.shape[-1]
            acc = np.concatenate([acc, np.zeros((n_src, channels, grow), np.float32)], axis=-1)
            acc_w = np.concatenate([acc_w, np.zeros(grow, np.float32)])
        lo = offset - base
        acc[..., lo : lo + n] += weight[:n] * y
        acc_w[lo : lo + n] += weight[:n]
        nxt = offsets[i + 1] if i + 1 < len(offsets) else offset + n
        flush(min(nxt, length))
        if progress is not None:
            progress((i + 1) / len(offsets), f"Separando tramo {i + 1}/{len(offsets)}")
    flush(length)
    return len(offsets)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify_weights(path: Path, models_root: Path) -> str:
    """Integrity of the htdemucs weights BEFORE ``torch.load`` (it unpickles the file).

    Exact size + full sha256 when packs.py pins them; until then (TODO there: the official host was
    blocked when the pack was written) the demucs file-name prefix plus the size + sha256 recorded
    in models/manifest.json at the first download (trust on first download), with a warning.
    Returns the full sha256.
    """
    size = path.stat().st_size
    bad = "volvé a descargar el paquete «Separar audio» (Ajustes → Paquetes de IA)"
    if WEIGHTS_SIZE is not None and size != WEIGHTS_SIZE:
        raise RuntimeError(
            f"Pesos htdemucs dañados (pesan {size} bytes, se esperaban {WEIGHTS_SIZE}): {bad}"
        )
    got = _sha256(path)
    if not got.startswith(WEIGHTS_SHA_PREFIX) or (WEIGHTS_SHA256 and got != WEIGHTS_SHA256):
        want = WEIGHTS_SHA256 or f"{WEIGHTS_SHA_PREFIX}…"
        raise RuntimeError(
            f"Pesos htdemucs dañados (sha256 {got[:16]}…, se esperaba {want}): {bad}"
        )
    if WEIGHTS_SHA256:
        return got
    rel = path.relative_to(models_root).as_posix() if path.is_relative_to(models_root) else None
    entry = Manifest.load(models_root).get(rel) if rel else None
    recorded = (entry or {}).get("sha256")
    if recorded and (recorded != got or entry.get("size") != size):
        raise RuntimeError(
            f"Pesos htdemucs cambiaron desde la descarga (sha256 {got[:16]}…, registrado "
            f"{str(recorded)[:16]}…): {bad}"
        )
    log.warning(
        "stems: sha256 completo de htdemucs sin fijar en packs.py (TODO); se comprobó el prefijo "
        "%s%s",
        WEIGHTS_SHA_PREFIX,
        " y el registro de la primera descarga" if recorded else " (sin registro en manifest.json)",
    )
    return got


class StemsEngine:
    def __init__(
        self, settings: Settings, budget: GpuBudget | None = None, loader: Loader | None = None
    ) -> None:
        self.settings = settings
        self.budget = budget
        self._loader = loader
        self._state: dict[str, Any] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------------- availability
    def available(self) -> bool:
        if self._loader is not None:
            return True
        return (
            module_present("demucs")
            and module_present("torch")
            and stems_weights_path(self.settings.models_root).is_file()
        )

    def require(self) -> None:
        if not self.available():
            raise PackRequiredError("stems")

    def unload(self) -> None:
        with self._lock:
            sep: Separator | None = self._state.pop("separator", None)
            self._state.clear()
        if sep is not None:
            try:
                sep.unload()
            except Exception as exc:  # pragma: no cover - driver specific
                log.warning("stems: unload failed: %s", exc)

    # -------------------------------------------------------------------------- real model
    def _demucs_loader(self, device: str) -> Separator:
        import torch  # noqa: PLC0415
        from demucs.apply import apply_model  # noqa: PLC0415
        from demucs.states import load_model  # noqa: PLC0415

        path = stems_weights_path(self.settings.models_root)
        verify_weights(path, self.settings.models_root)
        package = torch.load(str(path), map_location="cpu", weights_only=False)
        model = load_model(package)
        model.eval()
        dev = torch.device("cuda:0" if device == "cuda" else "cpu")
        model.to(dev)
        sources = tuple(getattr(model, "sources", HTDEMUCS_SOURCES))

        def run(chunk: Any, segment_s: float) -> Any:
            x = torch.from_numpy(chunk).unsqueeze(0)
            with torch.no_grad():
                out = apply_model(
                    model, x, shifts=0, split=False, segment=segment_s, device=dev, progress=False
                )
            return out[0].float().cpu().numpy()

        def unload() -> None:
            model.to("cpu")

        return Separator(sources=sources, run=run, unload=unload)

    def _separator(self, device: str) -> Separator:
        with self._lock:
            if self._state.get("device") == device and "separator" in self._state:
                return self._state["separator"]
        loader = self._loader or self._demucs_loader
        sep = loader(device)
        with self._lock:
            self._state = {"device": device, "separator": sep}
        return sep

    # ------------------------------------------------------------------------------ public
    def output_paths(self, out_base: Path, mode: Mode) -> dict[str, Path]:
        base = out_base.with_suffix("") if out_base.suffix.lower() == ".wav" else out_base
        return {name: base.with_name(f"{base.name}-{name}.wav") for name in STEMS[mode]}

    def separate(
        self, src: Path, out_base: Path, mode: Mode, progress: Progress | None = None
    ) -> dict[str, Any]:
        """Split ``src`` into the stems of ``mode``. Returns paths, device, segment, warnings."""
        self.require()
        step: Progress = progress or (lambda _p, _m: None)
        warnings: list[str] = []
        device = "cpu"
        segment = SEGMENT_LOW_VRAM_S
        if self.budget is not None and self.settings.use_cuda:
            info = self.budget.vram()
            segment = segment_for(info.total_mb if info else None)
            decision = self.budget.acquire(BUDGET_KEY, STEMS_VRAM_MB, self.unload)
            device = decision.device
            warnings.extend(decision.warnings)
        paths = self.output_paths(out_base, mode)
        out_base.parent.mkdir(parents=True, exist_ok=True)
        step(0.01, "Decodificando el audio (44,1 kHz estéreo)")
        with tempfile.TemporaryDirectory(dir=out_base.parent) as tmp:
            wav = Path(tmp) / "mix.wav"
            # 5.1/7.1 sources are downmixed by ffmpeg (htdemucs is a stereo model).
            to_wav(src, wav, sample_rate=SAMPLE_RATE, channels=CHANNELS)
            with _WavMix(wav) as mix:
                device, chunks, duration = self._run(
                    mix, paths, mode, device, segment, step, warnings
                )
        if self.budget is not None and device == "cuda":
            self.budget.touch(BUDGET_KEY)
        return {
            "paths": paths,
            "device": device,
            "segment": segment,
            "chunks": chunks,
            "duration_s": round(duration, 3),
            "warnings": list(dict.fromkeys(warnings)),
        }

    def _run(
        self,
        mix: _WavMix,
        paths: dict[str, Path],
        mode: Mode,
        device: str,
        segment: float,
        step: Progress,
        warnings: list[str],
    ) -> tuple[str, int, float]:
        """Separate the decoded WAV (read chunk by chunk); CUDA failure -> CPU retry."""
        duration = mix.length / SAMPLE_RATE

        def attempt(dev: str) -> int:
            step(0.04, f"Cargando htdemucs ({'GPU' if dev == 'cuda' else 'CPU'})")
            sep = self._separator(dev)
            writers = _StemWriters(paths)
            try:
                return separate_array(
                    mix,
                    sep,
                    STEMS[mode],
                    writers,
                    segment_s=segment,
                    progress=lambda f, m: step(0.05 + f * 0.93, m),
                )
            finally:
                writers.close()

        try:
            chunks = attempt(device)
        except Exception as exc:
            if device != "cuda":
                raise
            log.warning("htdemucs on CUDA failed (%s); retrying on CPU", exc)
            self.unload()
            if self.budget is not None:
                warnings.extend(self.budget.failed(BUDGET_KEY))
            else:
                warnings.append(GPU_FALLBACK_CPU)
            device = "cpu"
            chunks = attempt(device)
        return device, chunks, duration
