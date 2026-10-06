"""RVC voice conversion (inference only) with infer-rvc-python 1.3.1 (MIT, no fairseq).

Layout (relative to MODELS_DIR):
    rvc/<name>/<anything>.pth (+ optional .index)   user-provided voice models
    rvc/_base/rmvpe.pt                                pitch estimator (required for rmvpe)
    rvc/_base/hubert_base/{config.json, *.bin}       content encoder (transformers format)
    rvc/_base/hubert_base.pt                          legacy fairseq file (optional)

CPU works but is slow (roughly the audio duration or more with rmvpe on a modern CPU); CUDA makes
it several times faster. Folders starting with "_" or "." are not voice models.

Sprint 4 (M3, RVC en CUDA): the library has no ``device``/``fp16`` arguments: with
``only_cpu=False`` and a CUDA torch it uses ``cuda:0`` and fp16 by itself (fuentes-sprint4 §3.2).
So CUDA = (1) USE_CUDA and a torch build that sees the GPU (a CPU wheel -> CPU + warning
``torch_cpu_build``), (2) the GPU budget (``GpuBudget.acquire("rvc")`` before inferring, released
after ``RVC_IDLE_S`` without use, default 300 s), (3) CPU fallback with ``gpu_fallback_cpu`` when
CUDA fails. ``torch.load`` keeps torch >= 2.6's ``weights_only=True``: a voice model that only
loads as an arbitrary pickle is refused with 422 ``RVC_MODEL_INCOMPATIBLE`` (they are user files).

Base assets (pack ``rvc-base``): hubert in transformers format from ``lj1995/VoiceConversionWebUI``
``hubert_base/`` (the folder RVC-Project's own docs download, fuentes-audio.md §2 [V]; also used by
public RVC tools [S]); when that path answers 404 the download falls back to ``r3gm/hubert_base``,
the repo infer-rvc-python loads by default [V code]. ``rmvpe.pt`` (181 189 687 B, same file in
both repos [S]) the same way. models/manifest.json records which URL each file came from (doctor
shows the hubert origin). ``preprocessor_config.json`` is not downloaded any more: neither
transformers' HubertModel nor the library reads it.
"""

from __future__ import annotations

import logging
import pickle
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .config import Settings
from .downloads import DownloadError, Expected, ProgressFn, download, file_matches
from .gpu import GPU_FALLBACK_CPU, RVC_VRAM_MB, GpuBudget
from .media import to_wav
from .models_manifest import FileItem, Manifest, fetch_file
from .schemas import RvcModel

log = logging.getLogger("studio_workers")

# Official RVC asset repo (docs/trabajo/fuentes-audio.md §2.1).
RVC_ASSETS_BASE = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main"
# Defaults of infer-rvc-python 1.3.1 (main.py: load_hu_bert / BASE_DOWNLOAD_LINK) [V code].
HUBERT_FALLBACK_BASE = "https://huggingface.co/r3gm/hubert_base/resolve/main"
RMVPE_FALLBACK_URL = "https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/rmvpe.pt"
RMVPE_SIZE = 181_189_687  # [S] identical in lj1995/VoiceConversionWebUI and r3gm (contract M3)
TORCH_CPU_BUILD = "torch_cpu_build"
DEFAULT_IDLE_S = 300.0


@dataclass(frozen=True)
class BaseAsset:
    key: str
    remote: str  # path inside RVC_ASSETS_BASE
    local: str  # path relative to models/rvc/_base
    expected: Expected
    legacy: bool = False
    # Mirrors tried in order when the official URL answers 404/401/403.
    fallbacks: tuple[str, ...] = ()

    @property
    def url(self) -> str:
        return f"{RVC_ASSETS_BASE}/{self.remote}"

    def urls(self) -> tuple[str, ...]:
        return (self.url, *self.fallbacks)


BASE_ASSETS: tuple[BaseAsset, ...] = (
    BaseAsset(
        "rmvpe",
        "rmvpe.pt",
        "rmvpe.pt",
        Expected(size_bytes=RMVPE_SIZE),
        fallbacks=(RMVPE_FALLBACK_URL,),
    ),
    BaseAsset(
        "hubert_config",
        "hubert_base/config.json",
        "hubert_base/config.json",
        Expected(min_bytes=500),
        fallbacks=(f"{HUBERT_FALLBACK_BASE}/config.json",),
    ),
    BaseAsset(
        "hubert_weights",
        "hubert_base/pytorch_model.bin",
        "hubert_base/pytorch_model.bin",
        # [S] ~190 MB (exact size unknown offline): Content-Length + HF sha256 are enforced too.
        Expected(min_bytes=100_000_000),
        fallbacks=(f"{HUBERT_FALLBACK_BASE}/pytorch_model.bin",),
    ),
    BaseAsset(
        "hubert_legacy", "hubert_base.pt", "hubert_base.pt", Expected(min_bytes=150_000_000), True
    ),
)
MIRROR_STATUSES = ("HTTP 404", "HTTP 401", "HTTP 403")


def _mirror_worthy(exc: DownloadError) -> bool:
    return any(code in str(exc) for code in MIRROR_STATUSES)


@dataclass(frozen=True)
class MirroredFileItem(FileItem):
    """A FileItem with fallback URLs (pack rvc-base): the manifest records the URL that worked."""

    fallbacks: tuple[str, ...] = field(default=())

    def fetch(
        self, root: Path, manifest: Manifest, client: httpx.Client | None, progress: ProgressFn
    ) -> int:
        dest = root / self.rel
        last: DownloadError | None = None
        for i, url in enumerate((self.url, *self.fallbacks)):
            try:
                res = fetch_file(url, dest, self.expected, client=client, on_progress=progress)
            except DownloadError as exc:
                if not _mirror_worthy(exc):
                    raise
                last = exc
                dest.with_name(dest.name + ".part").unlink(missing_ok=True)
                if i < len(self.fallbacks):
                    log.warning("%s: %s; trying the mirror %s", self.name, exc, self.fallbacks[i])
                continue
            entry = manifest.record(
                self.rel, name=self.name, group=self.group, source=url, sha256=res.sha256
            )
            if not (self.expected.sha256 or self.expected.md5):
                entry["verified"] = "first-download"
            if i:
                entry["mirror"] = True
            return res.size
        assert last is not None
        raise last


def base_items(root: Path, *, legacy: bool) -> list[FileItem]:
    """Model items of the rvc-base pack / models_cli --rvc-base (models_manifest.rvc_items)."""
    items: list[FileItem] = []
    for asset in BASE_ASSETS:
        if asset.legacy and not legacy:
            continue
        dst = base_dir(root) / asset.local
        items.append(
            MirroredFileItem(
                "rvc:legacy" if asset.legacy else "rvc:base",
                asset.local,
                dst.relative_to(root).as_posix(),
                asset.url,
                asset.expected,
                fallbacks=asset.fallbacks,
            )
        )
    return items


def hubert_source(models_root: Path) -> dict[str, Any]:
    """Where the installed hubert came from (models/manifest.json): doctor and GET /rvc/models."""
    manifest = Manifest.load(models_root)
    rel = (base_dir(models_root) / "hubert_base" / "pytorch_model.bin").relative_to(models_root)
    entry = manifest.get(rel.as_posix()) or {}
    url = str(entry.get("source") or "")
    repo = None
    for name in ("lj1995/VoiceConversionWebUI", "r3gm/hubert_base"):
        if name in url:
            repo = name
    present = (models_root / rel).is_file()
    return {"present": present, "repo": repo, "url": url or None, "sha256": entry.get("sha256")}


def rvc_root(models_root: Path) -> Path:
    return models_root / "rvc"


def base_dir(models_root: Path) -> Path:
    return rvc_root(models_root) / "_base"


def rmvpe_path(models_root: Path) -> Path:
    return base_dir(models_root) / "rmvpe.pt"


def hubert_dir(models_root: Path) -> Path:
    return base_dir(models_root) / "hubert_base"


def base_status(models_root: Path) -> dict[str, bool]:
    hub = hubert_dir(models_root)
    return {
        "rmvpe": rmvpe_path(models_root).is_file(),
        "hubert": (hub / "config.json").is_file()
        and any((hub / f).is_file() for f in ("pytorch_model.bin", "model.safetensors")),
        "hubertLegacy": (base_dir(models_root) / "hubert_base.pt").is_file(),
    }


def base_ready(models_root: Path, f0_method: str = "rmvpe") -> bool:
    """hubert (+ rmvpe when it is the pitch method) present: pack ``rvc-base`` usable."""
    status = base_status(models_root)
    return status["hubert"] and (status["rmvpe"] or f0_method != "rmvpe")


def download_base_assets(
    models_root: Path,
    *,
    include_legacy: bool = False,
    force: bool = False,
    on_progress: ProgressFn | None = None,
) -> list[tuple[Path, int, bool]]:
    results: list[tuple[Path, int, bool]] = []
    for asset in BASE_ASSETS:
        if asset.legacy and not include_legacy:
            continue
        dst = base_dir(models_root) / asset.local
        if not force and file_matches(dst, asset.expected):
            results.append((dst, dst.stat().st_size, True))
            continue
        error: DownloadError | None = None
        for url in asset.urls():
            try:
                size = download(url, dst, asset.expected, on_progress=on_progress)
            except DownloadError as exc:
                if not _mirror_worthy(exc):
                    raise
                error = exc
                continue
            results.append((dst, size, False))
            error = None
            break
        if error is not None:
            raise error
    return results


def torch_cuda_available() -> bool:
    """The installed torch sees a CUDA GPU (False for the CPU wheel, missing torch or driver)."""
    try:
        import torch  # noqa: PLC0415 - heavy, only when RVC runs
    except Exception:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def is_unpickling_error(exc: BaseException) -> bool:
    """torch.load(weights_only=True) refused the checkpoint (pickle.UnpicklingError, also when the
    library wrapped it)."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, pickle.UnpicklingError) or type(cur).__name__ == "UnpicklingError":
            return True
        if "Weights only load failed" in str(cur):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def model_incompatible_error(model_id: str) -> Exception:
    from .errors import CodedError  # noqa: PLC0415 - errors.py imports a lot

    return CodedError(
        "RVC_MODEL_INCOMPATIBLE",
        f"El modelo RVC «{model_id}» no se puede cargar de forma segura (formato incompatible).",
        details={"modelId": model_id},
    )


def discover_models(models_root: Path) -> list[RvcModel]:
    root = rvc_root(models_root)
    if not root.is_dir():
        return []
    models: list[RvcModel] = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        if folder.name.startswith(("_", ".")):
            continue
        pths = sorted(folder.glob("*.pth"))
        if not pths:
            continue
        preferred = [p for p in pths if p.stem == folder.name]
        pth = (preferred or pths)[0]
        indexes = sorted(folder.glob("*.index"), key=lambda p: ("added" not in p.name, p.name))
        models.append(
            RvcModel(
                id=folder.name,
                name=folder.name.replace("_", " ").replace("-", " ").strip(),
                model_path=pth.relative_to(models_root).as_posix(),
                index_path=indexes[0].relative_to(models_root).as_posix() if indexes else None,
            )
        )
    return models


LoaderFactory = Callable[[bool, str | None, str | None], Any]


def _default_loader(only_cpu: bool, hubert: str | None, rmvpe: str | None) -> Any:
    from infer_rvc_python import BaseLoader  # noqa: PLC0415 - optional heavy dependency

    return BaseLoader(only_cpu=only_cpu, hubert_path=hubert, rmvpe_path=rmvpe)


@dataclass
class ConvertParams:
    pitch_shift: int = 0
    index_rate: float = 0.75
    f0_method: str = "rmvpe"
    filter_radius: int = 3
    rms_mix_rate: float = 0.25
    protect: float = 0.33


BUDGET_KEY = "rvc"


class RvcEngine:
    def __init__(
        self,
        settings: Settings,
        loader_factory: LoaderFactory | None = None,
        budget: GpuBudget | None = None,
        *,
        cuda_probe: Callable[[], bool] | None = None,
        idle_s: float | None = None,
    ) -> None:
        self.settings = settings
        self._factory = loader_factory or _default_loader
        self._loaders: dict[str, Any] = {}
        self._lock = threading.Lock()
        self.budget = budget
        self._cuda_probe = cuda_probe or torch_cuda_available
        if idle_s is None:
            from .toolvenv import tool_settings  # noqa: PLC0415

            idle_s = tool_settings().seconds("rvc_idle_s", DEFAULT_IDLE_S)
        from .toolvenv import IdleTimer  # noqa: PLC0415

        self.idle = IdleTimer(idle_s, self.release_gpu)

    def resolve_device(self, requested: str | None) -> str:
        if requested:
            return requested
        return "cuda" if self.settings.use_cuda else "cpu"

    def acquire_device(self, requested: str | None) -> tuple[str, list[str]]:
        """Device after the GPU budget (unload-before-load, CPU fallback when VRAM is short).

        USE_CUDA with a torch that does not see the GPU (CPU wheel, missing driver) -> CPU with
        ``torch_cpu_build`` (setup.ps1 -WithCuda reinstalls the cu128 build)."""
        device = self.resolve_device(requested)
        if device == "cuda" and not self._cuda_probe():
            log.warning("RVC: USE_CUDA but torch.cuda.is_available() is False -> CPU")
            return "cpu", [TORCH_CPU_BUILD]
        if device == "cuda" and self.budget is not None:
            decision = self.budget.acquire(
                BUDGET_KEY, RVC_VRAM_MB, lambda: self.unload_device("cuda")
            )
            if decision.device == "cuda":
                self.idle.touch()
            return decision.device, decision.warnings
        return device, []

    def release_gpu(self) -> None:
        """RVC_IDLE_S without use: give the VRAM back (budget.release calls unload_device)."""
        if self.budget is not None:
            if self.budget.release(BUDGET_KEY) is None:
                self.unload_device("cuda")
        else:
            self.unload_device("cuda")

    def cuda_failed(self) -> list[str]:
        """CUDA conversion raised (DLLs, OOM): forget the CUDA loader, report the fallback."""
        self.unload_device("cuda")
        self.idle.cancel()
        warnings = self.budget.failed(BUDGET_KEY) if self.budget else []
        return list(dict.fromkeys(warnings or [GPU_FALLBACK_CPU]))

    def unload_device(self, device: str) -> None:
        with self._lock:
            self._loaders.pop(device, None)

    def _loader(self, device: str) -> Any:
        with self._lock:
            if device not in self._loaders:
                root = self.settings.models_root
                hub = hubert_dir(root)
                rm = rmvpe_path(root)
                self._loaders[device] = self._factory(
                    device == "cpu",
                    str(hub) if base_status(root)["hubert"] else None,
                    str(rm) if rm.is_file() else None,
                )
            return self._loaders[device]

    def ensure_assets(self, f0_method: str, on_progress: ProgressFn | None = None) -> None:
        if base_ready(self.settings.models_root, f0_method):
            return
        log.info("RVC base assets missing; downloading to %s", base_dir(self.settings.models_root))
        download_base_assets(self.settings.models_root, on_progress=on_progress)

    def convert(
        self,
        model: RvcModel,
        input_audio: Path,
        output: Path,
        params: ConvertParams,
        device: str,
        on_progress: Callable[[float, str], None] | None = None,
    ) -> tuple[Path, int, float]:
        """Convert input_audio with model; writes a WAV. Returns (path, sample_rate, duration)."""
        import soundfile as sf  # noqa: PLC0415 - dependency of infer-rvc-python

        root = self.settings.models_root
        notify = on_progress or (lambda _p, _m: None)
        notify(0.05, "Preparando activos RVC")
        self.ensure_assets(params.f0_method)
        loader = self._loader(device)
        tag = f"{model.id}:{params.f0_method}:{params.pitch_shift}:{params.index_rate}"
        loader.apply_conf(
            tag=tag,
            file_model=str(root / model.model_path),
            pitch_algo=params.f0_method,
            pitch_lvl=params.pitch_shift,
            file_index=str(root / model.index_path) if model.index_path else "",
            index_influence=params.index_rate,
            respiration_median_filtering=params.filter_radius,
            envelope_ratio=params.rms_mix_rate,
            consonant_breath_protection=params.protect,
        )
        notify(0.15, "Decodificando audio")
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output.parent) as tmp:
            wav16k = Path(tmp) / "input_16k.wav"
            to_wav(input_audio, wav16k, sample_rate=16000, mono=True)
            notify(0.25, f"Convirtiendo voz ({device}; en CPU puede tardar)")
            try:
                audio, sample_rate = loader.generate_from_cache(str(wav16k), tag=tag)
            except Exception as exc:
                if is_unpickling_error(exc):
                    # Never weights_only=False: .pth files come from the user (arbitrary pickles).
                    with self._lock:
                        self._loaders.pop(device, None)  # drop the half-configured loader
                    raise model_incompatible_error(model.id) from exc
                raise
            finally:
                if device == "cuda":
                    self.idle.touch()
                    if self.budget is not None:
                        self.budget.touch(BUDGET_KEY)
        sf.write(str(output), audio, int(sample_rate))
        duration = float(len(audio)) / float(sample_rate) if sample_rate else 0.0
        notify(0.99, "Guardando")
        return output, int(sample_rate), duration
