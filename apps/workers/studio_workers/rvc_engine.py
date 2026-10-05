"""RVC voice conversion (inference only) with infer-rvc-python 1.3.1 (MIT, no fairseq).

Layout (relative to MODELS_DIR):
    rvc/<name>/<anything>.pth (+ optional .index)   user-provided voice models
    rvc/_base/rmvpe.pt                                pitch estimator (required for rmvpe)
    rvc/_base/hubert_base/{config.json, *.bin}       content encoder (transformers format)
    rvc/_base/hubert_base.pt                          legacy fairseq file (optional)

CPU works but is slow (roughly the audio duration or more with rmvpe on a modern CPU); CUDA makes
it several times faster. Folders starting with "_" or "." are not voice models.
"""

from __future__ import annotations

import logging
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .downloads import Expected, ProgressFn, download, file_matches
from .media import to_wav
from .schemas import RvcModel

log = logging.getLogger("studio_workers")

# Official RVC asset repo (docs/trabajo/fuentes-audio.md §2.1).
RVC_ASSETS_BASE = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main"


@dataclass(frozen=True)
class BaseAsset:
    key: str
    remote: str  # path inside RVC_ASSETS_BASE
    local: str  # path relative to models/rvc/_base
    expected: Expected
    legacy: bool = False


BASE_ASSETS: tuple[BaseAsset, ...] = (
    # Sizes are lower bounds (exact sizes not verifiable offline); Content-Length is enforced too.
    BaseAsset("rmvpe", "rmvpe.pt", "rmvpe.pt", Expected(min_bytes=100_000_000)),
    BaseAsset(
        "hubert_config",
        "hubert_base/config.json",
        "hubert_base/config.json",
        Expected(min_bytes=500),
    ),
    BaseAsset(
        "hubert_preprocessor",
        "hubert_base/preprocessor_config.json",
        "hubert_base/preprocessor_config.json",
        Expected(min_bytes=50),
    ),
    BaseAsset(
        "hubert_weights",
        "hubert_base/pytorch_model.bin",
        "hubert_base/pytorch_model.bin",
        Expected(min_bytes=100_000_000),
    ),
    BaseAsset(
        "hubert_legacy", "hubert_base.pt", "hubert_base.pt", Expected(min_bytes=150_000_000), True
    ),
)


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
        size = download(
            f"{RVC_ASSETS_BASE}/{asset.remote}", dst, asset.expected, on_progress=on_progress
        )
        results.append((dst, size, False))
    return results


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


class RvcEngine:
    def __init__(self, settings: Settings, loader_factory: LoaderFactory | None = None) -> None:
        self.settings = settings
        self._factory = loader_factory or _default_loader
        self._loaders: dict[str, Any] = {}
        self._lock = threading.Lock()

    def resolve_device(self, requested: str | None) -> str:
        if requested:
            return requested
        return "cuda" if self.settings.use_cuda else "cpu"

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
        status = base_status(self.settings.models_root)
        if status["hubert"] and (status["rmvpe"] or f0_method != "rmvpe"):
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
            audio, sample_rate = loader.generate_from_cache(str(wav16k), tag=tag)
        sf.write(str(output), audio, int(sample_rate))
        duration = float(len(audio)) / float(sample_rate) if sample_rate else 0.0
        notify(0.99, "Guardando")
        return output, int(sample_rate), duration
