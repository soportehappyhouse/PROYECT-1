"""GPU budget manager: one resident model at a time, unload-before-load, CPU fallback.

Every engine that can put weights on the GPU (Whisper, RVC, DeepFilterNet) asks the budget before
loading: ``acquire(name, estimated_mb, unload)``. The policy (docs/INVESTIGACION-IA-LOCAL.md §10):

- only ONE model is resident on the GPU; loading another first calls the previous one's
  ``unload`` callback (``del model`` + ``torch.cuda.empty_cache()``);
- if the free VRAM (minus a system reserve) does not fit the estimate, the caller runs on CPU and
  the response carries ``warnings: ["gpu_fallback_cpu"]``;
- Piper never asks (CPU only).

VRAM is read with ``nvidia-smi`` (NVML, no CUDA context: creating a torch context just to read the
free memory would cost ~0.3 GB on a 6 GB card) and, when torch already initialized CUDA in this
process, with ``torch.cuda.mem_get_info()``. Unknown VRAM (no nvidia-smi, no torch) does not block
a CUDA attempt: the engines keep their own CUDA -> CPU fallback.

"sysmem_fallback" is best-effort: the Windows driver (536.40+) spills to shared RAM instead of
failing when VRAM is full, which is 5-10x slower. We flag it when a model is resident and free VRAM
is almost zero; doctor.ps1 explains the NVIDIA "CUDA - Sysmem Fallback Policy" setting.
"""

from __future__ import annotations

import gc
import logging
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("studio_workers")

GPU_FALLBACK_CPU = "gpu_fallback_cpu"
DEFAULT_RESERVE_MB = 800  # Windows desktop + browser + NVENC session
_SMI_CACHE_SEC = 2.0

# Rough VRAM per model (MB), fp16 on CUDA (§8.3 / §10.1). int8 variants use ~60 %.
WHISPER_VRAM_MB: dict[str, int] = {
    "tiny": 300,
    "base": 400,
    "small": 900,
    "medium": 2000,
    "large-v1": 4500,
    "large-v2": 4500,
    "large-v3": 4500,
    "large": 4500,
    "large-v3-turbo": 1800,
    "turbo": 1800,
    "distil-large-v2": 1600,
    "distil-large-v3": 1600,
    "distil-large-v3.5": 1600,
}
RVC_VRAM_MB = 1500
DEEPFILTER_VRAM_MB = 300


def whisper_vram_mb(name: str, compute_type: str) -> int:
    base = WHISPER_VRAM_MB.get(name.removesuffix(".en"), 1500)
    return int(base * 0.6) if compute_type.startswith("int8") else base


@dataclass
class VramInfo:
    gpu_name: str | None
    total_mb: int
    free_mb: int
    source: str  # nvidia-smi | torch


@dataclass
class Decision:
    device: str  # cuda | cpu
    warnings: list[str] = field(default_factory=list)


@dataclass
class Resident:
    name: str
    estimated_mb: int
    unload: Callable[[], None]
    loaded_at: float
    last_used: float


VramProbe = Callable[[], VramInfo | None]


def _probe_nvidia_smi() -> VramInfo | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [
                exe,
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    line = (out.stdout or "").strip().splitlines()[:1]
    if out.returncode != 0 or not line:
        return None
    parts = [p.strip() for p in line[0].split(",")]
    try:
        return VramInfo(parts[0], int(float(parts[1])), int(float(parts[2])), "nvidia-smi")
    except (IndexError, ValueError):
        return None


def _probe_torch() -> VramInfo | None:
    """Only when torch already created a CUDA context in this process (never creates one)."""
    torch = sys.modules.get("torch")
    if torch is None:
        return None
    try:
        if not torch.cuda.is_available() or not torch.cuda.is_initialized():
            return None
        free, total = torch.cuda.mem_get_info()
        return VramInfo(
            torch.cuda.get_device_name(0), int(total // 2**20), int(free // 2**20), "torch"
        )
    except Exception:  # broken driver must never break /gpu/status
        return None


def default_probe() -> VramInfo | None:
    return _probe_nvidia_smi() or _probe_torch()


def empty_cuda_cache() -> None:
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is None:
        return
    try:
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            torch.cuda.empty_cache()
    except Exception:  # pragma: no cover - driver specific
        pass


class GpuBudget:
    def __init__(
        self,
        *,
        use_cuda: bool,
        probe: VramProbe | None = None,
        reserve_mb: int = DEFAULT_RESERVE_MB,
    ) -> None:
        self.use_cuda = use_cuda
        self.reserve_mb = reserve_mb
        self._probe = probe or default_probe
        self._lock = threading.RLock()
        self._resident: Resident | None = None
        self._cache: tuple[float, VramInfo | None] | None = None
        self.last_fallback: str | None = None

    # ------------------------------------------------------------------ vram
    def vram(self, *, fresh: bool = False) -> VramInfo | None:
        now = time.monotonic()
        if not fresh and self._cache and now - self._cache[0] < _SMI_CACHE_SEC:
            return self._cache[1]
        info = self._probe()
        self._cache = (now, info)
        return info

    # ------------------------------------------------------------------ policy
    def acquire(self, name: str, estimated_mb: int, unload: Callable[[], None]) -> Decision:
        """Make room for `name` on the GPU. Returns the device to use and warnings."""
        with self._lock:
            if not self.use_cuda:
                return Decision("cpu")
            res = self._resident
            if res and res.name == name:
                res.last_used = time.monotonic()
                return Decision("cuda")
            if res:
                self._unload_locked()
            info = self.vram(fresh=True)
            if info is not None and info.free_mb - self.reserve_mb < estimated_mb:
                log.warning(
                    "GPU budget: %s needs ~%d MB, free %d MB (reserve %d): CPU fallback",
                    name,
                    estimated_mb,
                    info.free_mb,
                    self.reserve_mb,
                )
                self.last_fallback = name
                return Decision("cpu", [GPU_FALLBACK_CPU])
            now = time.monotonic()
            self._resident = Resident(name, estimated_mb, unload, now, now)
            return Decision("cuda")

    def failed(self, name: str) -> list[str]:
        """The engine could not load `name` on CUDA (DLLs, OOM): forget it, report fallback."""
        with self._lock:
            if self._resident and self._resident.name == name:
                self._resident = None
            self.last_fallback = name
        empty_cuda_cache()
        return [GPU_FALLBACK_CPU]

    def touch(self, name: str) -> None:
        with self._lock:
            if self._resident and self._resident.name == name:
                self._resident.last_used = time.monotonic()

    def release(self, name: str | None = None) -> str | None:
        """Unload the resident model (only if it is `name`, when given)."""
        with self._lock:
            if name is not None and (self._resident is None or self._resident.name != name):
                return None
            return self._unload_locked()

    def make_room(self, need_mb: int) -> str | None:
        """Before an external GPU user (Ollama): unload the resident model when free VRAM is
        under `need_mb` (unknown VRAM counts as not enough). Returns the released model name, or
        None when nothing had to be done."""
        with self._lock:
            if not self.use_cuda or self._resident is None:
                return None
            info = self.vram(fresh=True)
            if info is not None and info.free_mb >= need_mb:
                return None
            return self._unload_locked()

    def _unload_locked(self) -> str | None:
        res = self._resident
        if res is None:
            return None
        self._resident = None
        try:
            res.unload()
        except Exception as exc:  # an unload failure must not block the next model
            log.warning("GPU budget: unloading %s failed: %s", res.name, exc)
        empty_cuda_cache()
        self._cache = None
        log.info("GPU budget: released %s", res.name)
        return res.name

    @property
    def resident(self) -> str | None:
        return self._resident.name if self._resident else None

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        info = self.vram()
        with self._lock:
            resident = self._resident
        cuda = info is not None
        sysmem = bool(
            resident and info and info.total_mb and info.free_mb < max(64, info.total_mb * 0.02)
        )
        return {
            "cuda": cuda,
            "gpu_name": info.gpu_name if info else None,
            "vram_total_mb": info.total_mb if info else None,
            "vram_free_mb": info.free_mb if info else None,
            "resident_model": resident.name if resident else None,
            "mode": "gpu" if (self.use_cuda and cuda) else "cpu",
            "sysmem_fallback": sysmem,
            # additive
            "use_cuda": self.use_cuda,
            "reserve_mb": self.reserve_mb,
            "resident_estimated_mb": resident.estimated_mb if resident else None,
            "last_fallback": self.last_fallback,
            "source": info.source if info else None,
            # shared GpuStatus.warnings: the web indicator shows "la última tarea pasó a CPU"
            "warnings": [GPU_FALLBACK_CPU] if self.last_fallback else [],
        }
