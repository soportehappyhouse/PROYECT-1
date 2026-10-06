"""AI model packs: what each feature needs, on-demand sequential downloads, installed detection.

Registry from docs/trabajo/sprint1-contratos.md (sizes/sources: docs/INVESTIGACION-IA-LOCAL.md).
A pack is a list of model files (reusing models_manifest items: resumable, verified downloads that
end up in models/manifest.json) and/or pip requirements installed into the running venv.

- ``GET /packs``: quick status (filesystem + importlib only, never hashes or touches the network).
- ``POST /packs/{id}/download``: queued; ONE download at a time (TaskQueue with one thread).
- ``models_cli --packs list|download <id>...|all``: same code, synchronous (setup.ps1).

``models/packs.json`` is regenerated at startup with the static registry (for doctor/support).
Sizes marked approximate come from the research doc [S]; exact sizes are verified at download time
(Content-Length, Hugging Face X-Linked-Size/sha256, Piper voices.json md5).
"""

from __future__ import annotations

import contextlib
import importlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from importlib import metadata
from importlib.util import find_spec
from pathlib import Path
from typing import Any

import httpx

from .downloads import Expected
from .models_manifest import (
    FileItem,
    Item,
    Manifest,
    WhisperDownloader,
    WhisperItem,
    now_iso,
    piper_items,
    rvc_items,
)

log = logging.getLogger("studio_workers")

PACKS_JSON = "packs.json"
DEFAULT_VOICE = "es_AR-daniela-high"

# Approximate download sizes (bytes) used before the server tells the real one [S].
WHISPER_SIZES = {"base": 145_000_000, "large-v3-turbo": 1_620_000_000}
PIPER_QUALITY_SIZES = {"high": 114_000_000, "medium": 63_000_000, "low": 63_000_000}
PIPER_X_LOW = 28_000_000
RVC_SIZES = {"rmvpe.pt": 181_000_000, "hubert_base/pytorch_model.bin": 190_000_000}

DEEPFILTER_MODEL = "DeepFilterNet3"
# Same file df.enhance.maybe_download_model fetches (deepfilternet 0.5.6 on PyPI [V]); size and
# sha256 measured 2026-10-05 [V]: DeepFilterNet3/{config.ini, checkpoints/model_120.ckpt.best}.
DEEPFILTER_URL = (
    "https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/models/DeepFilterNet3.zip"
)
DEEPFILTER_ZIP_SIZE = 7_986_207
DEEPFILTER_ZIP_SHA256 = "49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2"


class PackRequiredError(RuntimeError):
    """A feature needs a pack that is not installed -> 409 PACK_REQUIRED."""

    def __init__(self, pack_id: str, detail: str | None = None) -> None:
        pack = PACKS.get(pack_id)
        self.pack_id = pack_id
        self.name_es = pack.display_name if pack else pack_id
        self.size_bytes = pack.approx_size if pack else 0
        super().__init__(
            detail or f"Hace falta el paquete '{self.name_es}' ({pack_id}). Descargalo en Ajustes."
        )

    def payload(self) -> dict[str, Any]:
        return {
            "error": "PACK_REQUIRED",
            "code": "PACK_REQUIRED",
            "packId": self.pack_id,
            "name_es": self.name_es,
            "size_bytes": self.size_bytes,
            "detail": str(self),
        }


@dataclass(frozen=True)
class PipReq:
    spec: str  # what pip installs, e.g. "scenedetect==0.7.1"
    module: str  # import name that proves it is installed
    size: int  # wheel size (win_amd64 cp311 on PyPI [V]) or estimate
    no_deps: bool = False
    only_if_missing: bool = False  # e.g. torch: skip when the venv already has it
    cuda_spec: str | None = None  # installed instead of `spec` when USE_CUDA=true
    extra_args: tuple[str, ...] = ()  # e.g. --no-build-isolation
    env: tuple[tuple[str, str], ...] = ()  # environment for that pip run (SAM2_BUILD_CUDA=0)
    # Distribution names (importlib.metadata) behind `module` for the CPU / CUDA builds: both
    # onnxruntime and onnxruntime-gpu install the module `onnxruntime`, so "importable" does not
    # say which one is there (piper-tts / faster-whisper pull the CPU build).
    cpu_dist: str | None = None
    cuda_dist: str | None = None
    needs_git: bool = False  # `git+https://...` spec: pip needs git on PATH


@dataclass(frozen=True)
class Pack:
    id: str
    name_es: str
    description_es: str
    group: str
    license: str
    required_by: tuple[str, ...]
    pip: tuple[PipReq, ...] = ()
    approx_size: int = 0
    items: Callable[[Path, dict | None], list[Item]] | None = None
    post_install: Callable[[Path], None] | None = None
    installed_check: Callable[[Path], bool] | None = None
    notes: str = ""
    # Sprint 2: extra environment set up after the files (matting -> .venv-gpl), with log lines,
    # and the status rows it contributes to GET /packs.
    post_install_env: Callable[[Path, Callable[[str], None]], None] | None = None
    extra_status: Callable[[Path], list[dict[str, Any]]] | None = None
    # Sprint 3: models pulled through the local Ollama service (/api/pull), not our downloader.
    ollama_models: Callable[[], tuple[str, ...]] | None = None
    # Name that depends on the configuration (agent-llm: after AGENT_MODEL); name_es stays the
    # static name of models/packs.json.
    name_fn: Callable[[], str] | None = None

    @property
    def display_name(self) -> str:
        return self.name_fn() if self.name_fn is not None else self.name_es

    def build_items(
        self, root: Path, catalog: dict | None = None, downloader: WhisperDownloader | None = None
    ) -> list[Item]:
        if self.items is None:
            return []
        items = self.items(root, catalog)
        if downloader is not None:
            items = [
                WhisperItem(i.model, downloader) if isinstance(i, WhisperItem) else i for i in items
            ]
        return items


# ------------------------------------------------------------------------------- item builders


def _core_items(root: Path, catalog: dict | None) -> list[Item]:
    return [*piper_items(root, DEFAULT_VOICE, catalog), WhisperItem("base")]


def _turbo_items(_root: Path, _catalog: dict | None) -> list[Item]:
    return [WhisperItem("large-v3-turbo")]


def _voices_items(root: Path, catalog: dict | None) -> list[Item]:
    from .tts.piper_catalog import SPANISH_VOICES  # noqa: PLC0415

    out: list[Item] = []
    for voice in SPANISH_VOICES:
        if voice.id != DEFAULT_VOICE:
            out.extend(piper_items(root, voice.id, catalog))
    return out


def _rvc_items(root: Path, _catalog: dict | None) -> list[Item]:
    return list(rvc_items(root, legacy=False))


def deepfilter_dir(root: Path) -> Path:
    return root / "deepfilter" / DEEPFILTER_MODEL


def _deepfilter_items(root: Path, _catalog: dict | None) -> list[Item]:
    rel = (root / "deepfilter" / f"{DEEPFILTER_MODEL}.zip").relative_to(root).as_posix()
    return [
        FileItem(
            f"deepfilter:{DEEPFILTER_MODEL}",
            f"{DEEPFILTER_MODEL}.zip",
            rel,
            DEEPFILTER_URL,
            Expected(size_bytes=DEEPFILTER_ZIP_SIZE, sha256=DEEPFILTER_ZIP_SHA256),
        )
    ]


def extract_deepfilter(root: Path) -> None:
    """Unzip DeepFilterNet3.zip -> models/deepfilter/DeepFilterNet3/{config.ini, checkpoints/}."""
    target = deepfilter_dir(root)
    if (target / "config.ini").is_file():
        return
    archive = root / "deepfilter" / f"{DEEPFILTER_MODEL}.zip"
    if not archive.is_file():
        return
    with zipfile.ZipFile(archive) as zf:
        for member in zf.namelist():
            dest = (archive.parent / member).resolve()
            if archive.parent.resolve() not in dest.parents and dest != archive.parent.resolve():
                raise ValueError(f"Zip con rutas inseguras: {member}")
        zf.extractall(archive.parent)
    if not (target / "config.ini").is_file():
        # Some archives have no top folder: move config.ini/checkpoints under DeepFilterNet3/.
        target.mkdir(parents=True, exist_ok=True)
        for name in ("config.ini", "checkpoints"):
            src = archive.parent / name
            if src.exists():
                shutil.move(str(src), str(target / name))


def _deepfilter_ready(root: Path) -> bool:
    d = deepfilter_dir(root)
    return (d / "config.ini").is_file() or (
        root / "deepfilter" / f"{DEEPFILTER_MODEL}.zip"
    ).is_file()


# ----------------------------------------------------------------------- sprint 2 vision packs
# RVM, BiRefNet and YuNet: exact size + sha256 [V] (measured 2026-10-05). SAM 2.1 (fbaipublicfiles,
# blocked in the build sandbox) keeps min_bytes; its first download records size + sha256 in
# models/manifest.json and later checks compare against them (pack_integrity: "first-download").

RVM_RELEASE = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0"
RVM_FILES = {  # name -> exact size [V] (github release v1.0.0, measured 2026-10-05)
    "rvm_mobilenetv3_fp16.torchscript": 7_952_067,
    "rvm_mobilenetv3_fp32.torchscript": 15_501_891,
}
RVM_SHA256 = {  # [V] sha256 of the release assets, measured 2026-10-05
    "rvm_mobilenetv3_fp16.torchscript": (
        "847a8b5139498afbf7abde9cc347b41030540f6498db593a0e3d9dde1eccdd96"
    ),
    "rvm_mobilenetv3_fp32.torchscript": (
        "f01e0c9338b9a6a31b881ea6d4360d70c1e549701b3792e14c9ed88d6196c5a1"
    ),
}
BIREFNET_URL = (
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"
    "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"
)
# BiRefNet-general-lite (backbone swin_v1_tiny) exported to ONNX and re-hosted by rembg (the
# official ZhengPeng7/BiRefNet releases publish .pth weights): size + sha256 [V] 2026-10-05.
BIREFNET_SIZE = 224_005_088
BIREFNET_SHA256 = "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333"
SAM2_BASE = "https://dl.fbaipublicfiles.com/segment_anything_2/092824"
# [S] sizes; dl.fbaipublicfiles.com is blocked in the build sandbox (403): no published sha256, so
# the first download records size + sha256 in models/manifest.json (trust on first download) and
# later checks compare against it; doctor shows "verificacion pendiente de primera descarga".
SAM2_FILES = {"sam2.1_hiera_tiny.pt": 156_000_000, "sam2.1_hiera_small.pt": 184_000_000}
# facebookresearch/sam2 has no release tags: pin the main HEAD commit [V git ls-remote 2026-10-05]
# (2024-12-15, setup.py VERSION 1.0, SAM 2.1 code + 12/11/2024 SAM2VideoPredictor update).
SAM2_COMMIT = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
SAM2_GIT = f"SAM-2 @ git+https://github.com/facebookresearch/sam2.git@{SAM2_COMMIT}"
GIT_MISSING_ES = (
    "Falta Git para instalar SAM 2 desde GitHub. Instalá Git (winget install Git.Git) y reintentá"
)
ORT_VERSION = "1.24.4"  # CUDA 12.x + cuDNN 9 build on PyPI (docs/INVESTIGACION-IA-LOCAL.md)
YUNET_URL = (
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
YUNET_SIZE = 232_589  # [V] measured 2026-10-05 (git LFS object)
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
OPENCV_HEADLESS = PipReq("opencv-python-headless==4.11.0.86", "cv2", 39_402_386)
NUMPY = PipReq("numpy", "numpy", 12_000_000, only_if_missing=True)
GPL_VENV_SHARED_SIZE = 25_000_000  # numpy + pip metadata when torch is shared with .venv
GPL_VENV_TORCH_SIZE = 220_000_000  # torch CPU wheel when the main .venv has no torch


def _rvm_items(root: Path, _catalog: dict | None) -> list[Item]:
    return [
        FileItem(
            "matting:rvm",
            name,
            f"matting/{name}",
            f"{RVM_RELEASE}/{name}",
            Expected(size_bytes=size, sha256=RVM_SHA256[name]),
        )
        for name, size in RVM_FILES.items()
    ]


def _birefnet_items(root: Path, _catalog: dict | None) -> list[Item]:
    name = BIREFNET_URL.rsplit("/", 1)[-1]
    return [
        FileItem(
            "matting-image:birefnet-lite",
            name,
            f"birefnet/{name}",
            BIREFNET_URL,
            Expected(size_bytes=BIREFNET_SIZE, sha256=BIREFNET_SHA256),
        )
    ]


def _sam2_items(root: Path, _catalog: dict | None) -> list[Item]:
    return [
        FileItem(
            "sam2:checkpoints",
            name,
            f"sam2/{name}",
            f"{SAM2_BASE}/{name}",
            Expected(min_bytes=100_000_000),
        )  # fmt: skip
        for name in SAM2_FILES
    ]


def _yunet_items(root: Path, _catalog: dict | None) -> list[Item]:
    name = YUNET_URL.rsplit("/", 1)[-1]
    return [
        FileItem(
            "reframe:yunet",
            name,
            f"yunet/{name}",
            YUNET_URL,
            Expected(size_bytes=YUNET_SIZE, sha256=YUNET_SHA256),
        )
    ]


def _gpl_venv_dir() -> Path:
    from .config import get_settings  # noqa: PLC0415
    from .vision.gpl import default_venv_dir  # noqa: PLC0415

    custom = get_settings().gpl_venv_dir
    return Path(custom) if custom else default_venv_dir()


def _gpl_status_rows(_root: Path) -> list[dict[str, Any]]:
    from .config import get_settings  # noqa: PLC0415
    from .vision.gpl import status  # noqa: PLC0415

    st = status(_gpl_venv_dir(), get_settings().gpl_python)
    size = GPL_VENV_SHARED_SIZE if module_present("torch") else GPL_VENV_TORCH_SIZE
    return [
        {"name": "venv:.venv-gpl (torch, numpy)", "size": size, "present": st["state"] == "ready"}
    ]


def _gpl_setup(_root: Path, say: Callable[[str], None]) -> None:
    from .config import get_settings  # noqa: PLC0415
    from .vision.gpl import ensure_venv  # noqa: PLC0415

    settings = get_settings()
    if settings.gpl_python:
        say(f"GPL_PYTHON={settings.gpl_python}: no se crea .venv-gpl")
        return
    ensure_venv(_gpl_venv_dir(), use_cuda=settings.use_cuda, on_line=say)


# ----------------------------------------------------------------------- sprint 3 agent pack

AGENT_PACK_ID = "agent-llm"


def _agent_settings() -> tuple[str, str]:
    from .config import get_settings  # noqa: PLC0415

    st = get_settings()
    return st.agent_model, st.ollama_url


def _agent_allow_remote() -> bool:
    from .config import get_settings  # noqa: PLC0415

    return get_settings().agent_allow_remote_ollama


def _agent_pack_name() -> str:
    """'Asistente local (Ollama + Qwen3 8B)' / '(Ollama + Hermes 3 8B)' / '(Ollama + <tag>)'."""
    from .agent.ollama_client import model_label  # noqa: PLC0415

    return f"Asistente local (Ollama + {model_label(_agent_settings()[0])})"


def _agent_models() -> tuple[str, ...]:
    """The model the agent uses (AGENT_MODEL: qwen3:8b by default, hermes3:8b, qwen3:0.6b)."""
    return (_agent_settings()[0],)


def ollama_installed_models() -> list[str] | None:
    """/api/tags of the local Ollama (None: service not running). Short timeout: GET /packs."""
    from .agent.ollama_client import installed_models_sync  # noqa: PLC0415

    return installed_models_sync(
        _agent_settings()[1], timeout=1.0, allow_remote=_agent_allow_remote()
    )


def _ollama_status_rows(pack: Pack) -> list[dict[str, Any]]:
    from .agent.ollama_client import model_in, model_size  # noqa: PLC0415

    assert pack.ollama_models is not None
    installed = ollama_installed_models()
    service = {"name": "servicio Ollama", "size": 0, "present": installed is not None}
    rows = [service]
    for model in pack.ollama_models():
        present = installed is not None and model_in(model, installed)
        rows.append({"name": f"ollama:{model}", "size": model_size(model), "present": present})
    return rows


def _install_ollama_pack(
    pack: Pack,
    root: Path,
    manifest: Manifest,
    progress: Callable[[int, int, str | None], None],
    say: LineFn,
    report: InstallReport,
    force: bool,
) -> None:
    import asyncio  # noqa: PLC0415

    from .agent.ollama_client import (  # noqa: PLC0415
        OllamaClient,
        OllamaUnavailableError,
        PullProgress,
        model_in,
        model_size,
    )

    assert pack.ollama_models is not None
    url = _agent_settings()[1]
    OllamaClient(url, allow_remote=_agent_allow_remote()).check_url()  # remote URL: refused
    installed = ollama_installed_models()
    if installed is None:
        raise RuntimeError(str(OllamaUnavailableError(url)))
    models = list(pack.ollama_models())
    todo = [m for m in models if force or not model_in(m, installed)]
    for m in models:
        if m not in todo:
            report.skipped.append(f"ollama:{m}")
            say(f"ya descargado en Ollama, se omite: {m}")
    total = sum(model_size(m) for m in todo)
    done = 0
    progress(0, total, None)
    client = OllamaClient(url, allow_remote=_agent_allow_remote())
    for model in todo:
        say(f"ollama pull {model}")
        base = done
        seen: set[str] = set()

        def on_progress(
            p: PullProgress, base: int = base, model: str = model, seen: set[str] = seen
        ) -> None:
            if p.status not in seen:  # one log line per phase, not per chunk
                seen.add(p.status)
                say(f"{model}: {p.status}")
            if p.total:
                progress(base + p.completed, max(total, base + p.total), f"ollama:{model}")

        asyncio.run(client.pull(model, on_progress))
        done = base + model_size(model)
        report.downloaded.append(f"ollama:{model}")
        progress(done, max(total, done), f"ollama:{model}")
    after = ollama_installed_models() or []
    missing = [m for m in models if not model_in(m, after)]
    if missing:
        raise RuntimeError("Ollama no lista los modelos tras descargarlos: " + ", ".join(missing))
    manifest.packs[pack.id] = {"date": now_iso(), "ollama_models": models, "ollama_url": url}
    manifest.save()


# ------------------------------------------------------------------------------------ registry

PACKS: dict[str, Pack] = {
    p.id: p
    for p in (
        Pack(
            id="core",
            name_es="Núcleo (Whisper base + voz Daniela)",
            description_es=(
                "Transcripción básica en CPU (Whisper base) y la voz rioplatense de Piper "
                "es_AR-daniela-high. Se instala siempre."
            ),
            group="core",
            license="MIT (faster-whisper/Whisper) + voz Piper (ver MODEL_CARD)",
            required_by=("transcribe", "tts"),
            approx_size=WHISPER_SIZES["base"] + PIPER_QUALITY_SIZES["high"],
            items=_core_items,
        ),
        Pack(
            id="whisper-turbo",
            name_es="Whisper large-v3-turbo (GPU)",
            description_es=(
                "Transcripción precisa y rápida en GPU (float16, ~1,5-2,5 GB de VRAM). Con este "
                "paquete y CUDA pasa a ser el modelo por defecto."
            ),
            group="transcribe",
            license="MIT",
            required_by=("transcribe",),
            approx_size=WHISPER_SIZES["large-v3-turbo"],
            items=_turbo_items,
            notes="mobiuslabsgmbh/faster-whisper-large-v3-turbo (CTranslate2) [S tamaño]",
        ),
        Pack(
            id="voces-es",
            name_es="Voces Piper en español (7)",
            description_es="Las 7 voces Piper restantes (México y España) para locución local.",
            group="tts",
            license="Licencia de cada voz (rhasspy/piper-voices MODEL_CARD)",
            required_by=("tts",),
            # 1 high + 3 medium + 2 low + 1 x_low (~0.46 GB)
            approx_size=PIPER_QUALITY_SIZES["high"]
            + 3 * PIPER_QUALITY_SIZES["medium"]
            + 2 * PIPER_QUALITY_SIZES["low"]
            + PIPER_X_LOW,
            items=_voices_items,
        ),
        Pack(
            id="rvc-base",
            name_es="RVC base (hubert + rmvpe)",
            description_es=(
                "Codificador de contenido y estimador de tono para convertir voces con RVC."
            ),
            group="voice",
            license="MIT (lj1995/VoiceConversionWebUI)",
            required_by=("rvc",),
            approx_size=sum(RVC_SIZES.values()),
            items=_rvc_items,
        ),
        Pack(
            id="scenes",
            name_es="Detección de escenas (PySceneDetect)",
            description_es="Marca los cortes de escena del video (CPU). Solo paquetes de Python.",
            group="vision",
            license="BSD-3-Clause (PySceneDetect) + Apache-2.0 (OpenCV)",
            required_by=("analyze.scenes",),
            pip=(
                PipReq("numpy", "numpy", 12_000_000, only_if_missing=True),
                PipReq("opencv-python-headless==4.11.0.86", "cv2", 39_402_386),
                PipReq("platformdirs", "platformdirs", 32_493),
                PipReq("tqdm", "tqdm", 80_199),
                PipReq("click>=8,!=8.3.0,<9", "click", 125_251),
                # --no-deps: scenedetect pulls opencv-python (GUI), which collides with headless.
                PipReq("scenedetect==0.7.1", "scenedetect", 146_194, no_deps=True),
            ),
            approx_size=12_000_000 + 39_402_386 + 32_493 + 80_199 + 125_251 + 146_194,
        ),
        Pack(
            id="voz-limpia",
            name_es="Limpieza de voz (DeepFilterNet)",
            description_es=(
                "Quita ruido de fondo de grabaciones de voz. Funciona en CPU casi en tiempo real."
            ),
            group="audio",
            license="MIT / Apache-2.0 (DeepFilterNet)",
            required_by=("audio.denoise",),
            pip=(
                PipReq("torch==2.7.1", "torch", 220_000_000, only_if_missing=True),
                PipReq("torchaudio==2.7.1", "torchaudio", 2_500_000, only_if_missing=True),
                PipReq("loguru>=0.5", "loguru", 61_000),
                PipReq("appdirs>=1.4,<2", "appdirs", 9_600),
                # --no-deps: deepfilternet pins numpy<2 and packaging<24; the venv keeps its own.
                PipReq("deepfilterlib==0.5.6", "libdf", 518_210, no_deps=True),
                PipReq("deepfilternet==0.5.6", "df", 113_208, no_deps=True),
            ),
            approx_size=DEEPFILTER_ZIP_SIZE + 61_000 + 9_600 + 518_210 + 113_208,
            items=_deepfilter_items,
            post_install=extract_deepfilter,
            installed_check=_deepfilter_ready,
            notes="Pesos DeepFilterNet3.zip del repo oficial (tamaño y sha256 verificados)",
        ),
        Pack(
            id="matting",
            name_es="Recorte de personas en video (RobustVideoMatting)",
            description_es=(
                "Quita el fondo de personas en video con memoria temporal (sin parpadeo). Corre en "
                "un proceso y entorno aparte (.venv-gpl) por su licencia GPL-3."
            ),
            group="vision",
            license="GPL-3.0 (RobustVideoMatting; aislado en .venv-gpl, proceso aparte)",
            required_by=("vision.matte.rvm",),
            approx_size=sum(RVM_FILES.values()) + GPL_VENV_SHARED_SIZE,
            items=_rvm_items,
            post_install_env=_gpl_setup,
            extra_status=_gpl_status_rows,
            notes="TorchScript mobilenetv3 fp16 (GPU) + fp32 (CPU), release v1.0.0 [V sha256]",
        ),
        Pack(
            id="matting-image",
            name_es="Quitar fondo de imágenes (BiRefNet-lite)",
            description_es=(
                "Recorte de alta calidad para fotos y miniaturas (pelo, bordes). En video procesa "
                "cuadro a cuadro (puede parpadear: para personas usá el recorte de video)."
            ),
            group="vision",
            license="MIT (BiRefNet) + MIT (onnxruntime) + Apache-2.0 (OpenCV)",
            required_by=("vision.matte.birefnet", "vision.matte-image"),
            pip=(
                NUMPY,
                OPENCV_HEADLESS,
                PipReq(
                    f"onnxruntime=={ORT_VERSION}",
                    "onnxruntime",
                    12_594_863,
                    cuda_spec=f"onnxruntime-gpu=={ORT_VERSION}",
                    cpu_dist="onnxruntime",
                    cuda_dist="onnxruntime-gpu",
                ),
            ),
            approx_size=BIREFNET_SIZE + 12_594_863 + OPENCV_HEADLESS.size,
            items=_birefnet_items,
            notes=(
                "BiRefNet-general-lite swin_v1_tiny ONNX re-host de rembg (tamano y sha256 "
                "verificados); GPU: onnxruntime-gpu 1.24.4 (CUDA 12) reemplaza a onnxruntime"
            ),
        ),
        Pack(
            id="sam2",
            name_es="Máscara por clic en video (SAM 2.1 tiny + small)",
            description_es=(
                "Clic sobre cualquier objeto y su máscara se propaga por el video (por tramos de "
                "200 cuadros). tiny por defecto; small si la GPU tiene más de 3 GB libres."
            ),
            group="vision",
            license="Apache-2.0 (SAM 2.1 código y pesos)",
            required_by=("vision.sam", "vision.track.sam2"),
            pip=(
                PipReq("torch==2.7.1", "torch", 220_000_000, only_if_missing=True),
                PipReq("torchvision==0.22.1", "torchvision", 1_700_000, only_if_missing=True),
                NUMPY,
                PipReq("hydra-core>=1.3.2", "hydra", 168_790),
                PipReq("iopath>=0.1.10", "iopath", 42_226),
                PipReq("pillow>=9.4.0", "PIL", 2_700_000),
                PipReq("tqdm", "tqdm", 80_199),
                # --no-build-isolation builds with the venv's own setuptools/wheel (+ torch).
                PipReq("setuptools>=61,<=80.6.0", "setuptools", 1_200_000, only_if_missing=True),
                PipReq("wheel", "wheel", 72_000, only_if_missing=True),
                # Official repo (the PyPI "sam2" is not Meta's); no CUDA extension (only a minor
                # hole-filling post-process is lost) and torch from the venv (no isolated build).
                PipReq(
                    SAM2_GIT,
                    "sam2",
                    1_500_000,
                    no_deps=True,
                    extra_args=("--no-build-isolation",),
                    env=(("SAM2_BUILD_CUDA", "0"),),
                    needs_git=True,
                ),
            ),
            approx_size=sum(SAM2_FILES.values()) + 1_500_000 + 168_790 + 42_226 + 2_700_000,
            items=_sam2_items,
            notes=(
                f"Checkpoints 092824 de dl.fbaipublicfiles.com [S tamaños, sha256 en la primera "
                f"descarga]; sam2 @ {SAM2_COMMIT[:12]}; requiere Git"
            ),
        ),
        Pack(
            id="reframe",
            name_es="Reencuadre automático y seguimiento (YuNet + OpenCV)",
            description_es=(
                "Detecta caras (YuNet, CPU) para reencuadrar a 9:16/1:1/4:5 y seguir objetos con "
                "OpenCV. Liviano: funciona bien sin GPU."
            ),
            group="vision",
            license="MIT (YuNet, OpenCV Zoo) + Apache-2.0 (OpenCV)",
            required_by=("vision.reframe", "vision.track.csrt"),
            pip=(NUMPY, OPENCV_HEADLESS),
            approx_size=YUNET_SIZE + OPENCV_HEADLESS.size,
            items=_yunet_items,
            notes="face_detection_yunet_2023mar.onnx (tamaño y sha256 verificados)",
        ),
        Pack(
            id=AGENT_PACK_ID,
            name_es="Asistente local (Ollama + Qwen3 8B)",
            description_es=(
                "Modelo de lenguaje local que convierte pedidos en español en planes de edición "
                "(nada sale de tu PC). Necesita el servicio Ollama (lo instala setup.ps1); el "
                "modelo se descarga con Ollama (~5 GB)."
            ),
            group="agent",
            license="MIT (Ollama) + Apache-2.0 (Qwen3) / Llama 3.1 Community (hermes3)",
            required_by=("agent.plan", "agent.eval", "agent.bugreport"),
            approx_size=5_225_000_000,
            ollama_models=_agent_models,
            name_fn=_agent_pack_name,
            notes=(
                "AGENT_MODEL elige el modelo: qwen3:8b (defecto), hermes3:8b o qwen3:0.6b "
                "(CI); Ollama verifica los digests de cada capa"
            ),
        ),
    )
}

FEATURE_PACKS = {feat: p.id for p in PACKS.values() for feat in p.required_by if p.id != "core"}


# ---------------------------------------------------------------------------------- quick state


def module_present(module: str) -> bool:
    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def dist_installed(name: str) -> bool:
    """A pip distribution is installed (importlib.metadata: onnxruntime vs onnxruntime-gpu)."""
    try:
        metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return False
    return True


def dist_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _use_cuda_setting() -> bool:
    try:
        from .config import get_settings  # noqa: PLC0415

        return bool(get_settings().use_cuda)
    except Exception:  # settings unreadable: CPU semantics
        return False


def cuda_swap_needed(req: PipReq, use_cuda: bool) -> bool:
    """USE_CUDA=true and the CUDA build of `req` is not the one installed (or the CPU build is
    installed next to it and shadows its files): uninstall the CPU build, install the CUDA one."""
    if not (use_cuda and req.cuda_dist):
        return False
    if not dist_installed(req.cuda_dist):
        return True
    return bool(req.cpu_dist and dist_installed(req.cpu_dist))


def git_available() -> bool:
    return shutil.which("git") is not None


def pack_integrity(pack: Pack, root: Path, manifest: Manifest, catalog: dict | None = None) -> str:
    """How the pack's model files are verified: "pinned" (published size + hash), "first-download"
    (no published hash: size + sha256 recorded in models/manifest.json at the first download and
    compared from then on), "pending" (no published hash and not downloaded yet), "none" (no files).
    """
    files = [i for i in pack.build_items(root, catalog) if isinstance(i, FileItem)]
    if not files:
        return "none"
    unpinned = [i for i in files if not (i.expected.sha256 or i.expected.md5)]
    if not unpinned:
        return "pinned"
    if all((manifest.get(i.rel) or {}).get("sha256") for i in unpinned):
        return "first-download"
    return "pending"


def _approx_item_size(item: Item, catalog: dict | None) -> int:
    if isinstance(item, WhisperItem):
        return WHISPER_SIZES.get(item.model, 500_000_000)
    exp = item.expected
    if exp.size_bytes:
        return int(exp.size_bytes)
    if item.group.startswith("piper:"):
        if item.name.endswith(".json"):
            return 5_000
        quality = item.group.split("-")[-1]
        return PIPER_QUALITY_SIZES.get(quality, PIPER_X_LOW)
    for key, size in RVC_SIZES.items():
        if item.rel.endswith(key):
            return size
    return max(int(exp.min_bytes or 0), 1_000)


def item_state(item: Item, root: Path, catalog: dict | None = None) -> dict[str, Any]:
    """{name, size, present, partial} without hashing (cheap enough for every GET /packs)."""
    if isinstance(item, WhisperItem):
        snap = item.snapshot(root)
        if snap is not None:
            size = sum(p.stat().st_size for p in snap.iterdir() if p.is_file())
            return {
                "name": f"whisper {item.model}",
                "size": size,
                "present": True,
                "partial": False,
            }
        partial = any((item.cache_dir(root) / "blobs").glob("*.incomplete"))
        return {
            "name": f"whisper {item.model}",
            "size": _approx_item_size(item, catalog),
            "present": False,
            "partial": partial,
        }
    path = root / item.rel
    exp = item.expected
    if path.is_file():
        size = path.stat().st_size
        ok = size > 0
        if exp.size_bytes is not None and size != exp.size_bytes:
            ok = False
        if exp.min_bytes is not None and size < exp.min_bytes:
            ok = False
        return {"name": item.rel, "size": size, "present": ok, "partial": not ok}
    part = path.with_name(path.name + ".part")
    return {
        "name": item.rel,
        "size": _approx_item_size(item, catalog),
        "present": False,
        "partial": part.is_file(),
    }


def _catalog_offline(root: Path) -> dict | None:
    from .tts.piper_catalog import cached_voices_json  # noqa: PLC0415

    return cached_voices_json(root)


def pack_status(
    pack: Pack,
    root: Path,
    catalog: dict | None = None,
    *,
    use_cuda: bool | None = None,
    manifest: Manifest | None = None,
) -> dict[str, Any]:
    if use_cuda is None:
        use_cuda = _use_cuda_setting()
    files: list[dict[str, Any]] = []
    partial = False
    model_files: list[bool] = []
    for item in pack.build_items(root, catalog):
        st = item_state(item, root, catalog)
        partial = partial or st["partial"]
        model_files.append(st["present"])
        files.append({"name": st["name"], "size": st["size"], "present": st["present"]})
    for req in pack.pip:
        present = module_present(req.module)
        spec = req.spec
        if use_cuda and req.cuda_spec:  # CUDA machine: only the -gpu build counts as installed
            spec = req.cuda_spec
            present = present and not cuda_swap_needed(req, use_cuda)
        if req.only_if_missing and not present:
            files.append({"name": f"pip:{spec}", "size": req.size, "present": False})
        elif not req.only_if_missing:
            files.append({"name": f"pip:{spec}", "size": req.size, "present": present})
    if pack.extra_status is not None:
        files.extend(pack.extra_status(root))
    if pack.ollama_models is not None:
        files.extend(_ollama_status_rows(pack))
    installed = all(f["present"] for f in files) if files else False
    if installed and pack.installed_check is not None:
        installed = pack.installed_check(root)
    # pip dependencies shared with other packages (numpy, click...) do not make a pack "partial":
    # only an interrupted download (.part) or some of its model files on disk do.
    some_models = any(model_files)
    pip_main = pack.pip[-1] if pack.pip else None
    pip_started = bool(pip_main and module_present(pip_main.module))
    size = sum(f["size"] for f in files) or pack.approx_size
    return {
        "id": pack.id,
        "name_es": pack.display_name,
        "description_es": pack.description_es,
        "size_bytes": int(size),
        "installed": installed,
        "partial": (not installed) and (partial or some_models or pip_started),
        "files": files,
        "required_by": list(pack.required_by),
        "license": pack.license,
        "group": pack.group,
        # additive: "pinned" | "first-download" | "pending" | "none" (doctor.ps1)
        "integrity": pack_integrity(pack, root, manifest or Manifest.load(root), catalog),
    }


def list_packs(root: Path) -> list[dict[str, Any]]:
    catalog = _catalog_offline(root)
    use_cuda = _use_cuda_setting()
    manifest = Manifest.load(root)
    return [
        pack_status(p, root, catalog, use_cuda=use_cuda, manifest=manifest) for p in PACKS.values()
    ]


def is_installed(pack_id: str, root: Path) -> bool:
    return bool(pack_status(PACKS[pack_id], root)["installed"])


def summary(root: Path) -> dict[str, str]:
    out = {}
    for row in list_packs(root):
        out[row["id"]] = (
            "installed" if row["installed"] else "partial" if row["partial"] else "missing"
        )
    return out


def require_pack(pack_id: str, root: Path) -> None:
    if not is_installed(pack_id, root):
        raise PackRequiredError(pack_id)


def write_registry(root: Path) -> Path:
    """models/packs.json: the static registry (ids, files, sources, licenses, approx sizes)."""
    data = []
    for p in PACKS.values():
        files = []
        for item in p.build_items(root, None):
            if isinstance(item, WhisperItem):
                files.append(
                    {
                        "name": f"whisper {item.model}",
                        "source": f"https://huggingface.co/{item.repo}",
                        "dest": item.cache_dir(root).relative_to(root).as_posix(),
                        "approx_size": _approx_item_size(item, None),
                    }
                )
            else:
                files.append(
                    {
                        "name": item.name,
                        "source": item.url,
                        "dest": item.rel,
                        "approx_size": _approx_item_size(item, None),
                    }
                )
        for model in p.ollama_models() if p.ollama_models else ():
            from .agent.ollama_client import model_size  # noqa: PLC0415

            files.append(
                {
                    "name": f"ollama {model}",
                    "source": f"ollama pull {model} (registry.ollama.ai)",
                    "dest": "Ollama (%USERPROFILE%\\.ollama\\models)",
                    "approx_size": model_size(model),
                }
            )
        data.append(
            {
                "id": p.id,
                "name_es": p.name_es,
                "description_es": p.description_es,
                "group": p.group,
                "license": p.license,
                "required_by": list(p.required_by),
                "approx_size": p.approx_size,
                "files": files,
                "pip": [
                    {"spec": r.spec, "module": r.module, "no_deps": r.no_deps, "size": r.size}
                    for r in p.pip
                ],
                "notes": p.notes,
            }
        )
    root.mkdir(parents=True, exist_ok=True)
    path = root / PACKS_JSON
    payload = {"schemaVersion": 1, "generated": now_iso(), "packs": data}
    tmp = path.with_name(PACKS_JSON + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(path)
    return path


# ------------------------------------------------------------------------------------- install

LineFn = Callable[[str], None]
PipRunner = Callable[[list[str], LineFn], int]


def pip_command(args: list[str]) -> list[str]:
    """pip of the running interpreter (the workers .venv); uv when the venv has no pip.

    ``args`` are install arguments, or ``["uninstall", <dist>...]`` for an uninstall.
    """
    if args[:1] == ["uninstall"]:
        if module_present("pip"):
            return [sys.executable, "-m", "pip", "uninstall", "-y", *args[1:]]
        uv = shutil.which("uv")
        if uv:
            return [uv, "pip", "uninstall", "--python", sys.executable, *args[1:]]
        raise RuntimeError("pip no esta disponible en el entorno de los workers (setup.ps1)")
    base = ["install", "--disable-pip-version-check", "--progress-bar", "off", *args]
    if module_present("pip"):
        return [sys.executable, "-m", "pip", *base]
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", sys.executable, *args]
    raise RuntimeError("pip no esta disponible en el entorno de los workers (setup.ps1)")


def default_pip_runner(args: list[str], on_line: LineFn) -> int:
    cmd = pip_command(args)
    on_line("> " + " ".join(cmd[2:] if cmd[1] == "-m" else cmd[1:]))
    proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line)
    return proc.wait()


@contextlib.contextmanager
def _pip_env(pairs: tuple[tuple[str, str], ...]) -> Iterator[None]:
    old = {k: os.environ.get(k) for k, _ in pairs}
    os.environ.update(dict(pairs))
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@dataclass
class InstallReport:
    pack: str
    downloaded: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    pip: list[str] = field(default_factory=list)
    bytes: int = 0


class _DirWatcher:
    """Progress for huggingface_hub snapshots (no byte callback): poll the cache folder size."""

    def __init__(self, folder: Path, on_size: Callable[[int], None]) -> None:
        self.folder = folder
        self.on_size = on_size
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(1.0):
            try:
                total = sum(p.stat().st_size for p in self.folder.rglob("*") if p.is_file())
            except OSError:
                continue
            self.on_size(total)

    def __enter__(self) -> _DirWatcher:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()


def install_pack(
    pack_id: str,
    root: Path,
    *,
    on_progress: Callable[[int, int, str | None], None] | None = None,
    on_line: LineFn | None = None,
    client: httpx.Client | None = None,
    pip_runner: PipRunner | None = None,
    catalog: dict | None = None,
    whisper_downloader: WhisperDownloader | None = None,
    force: bool = False,
    use_cuda: bool | None = None,
) -> InstallReport:
    """Download every missing file of the pack, then pip-install what is missing (sequential)."""
    pack = PACKS.get(pack_id)
    if pack is None:
        raise KeyError(pack_id)
    say = on_line or (lambda _l: None)
    progress = on_progress or (lambda _d, _t, _f: None)
    runner = pip_runner or default_pip_runner
    report = InstallReport(pack_id)
    root.mkdir(parents=True, exist_ok=True)
    manifest = Manifest.load(root)
    if pack.ollama_models is not None:
        _install_ollama_pack(pack, root, manifest, progress, say, report, force)
        return report
    items = pack.build_items(root, catalog, whisper_downloader)

    todo: list[Item] = []
    for item in items:
        st = item.status(root, manifest)
        if st.state == "present" and not force:
            report.skipped.append(st.name)
            say(f"ya descargado, se omite: {st.name}")
        else:
            todo.append(item)
    if use_cuda is None:
        from .config import get_settings  # noqa: PLC0415

        use_cuda = get_settings().use_cuda
    pip_todo = [
        r
        for r in pack.pip
        if not module_present(r.module)
        or (force and not r.only_if_missing)
        or cuda_swap_needed(r, use_cuda)
    ]
    if any(r.needs_git for r in pip_todo) and not git_available():
        # Before any download: pip would fail later with an obscure "git not found".
        raise RuntimeError(GIT_MISSING_ES)
    total = sum(_approx_item_size(i, catalog) for i in todo) + sum(r.size for r in pip_todo)
    done = 0
    progress(0, total, None)

    for item in todo:
        name = item.name if isinstance(item, FileItem) else f"whisper {item.model}"
        say(f"bajando {name}")
        base = done

        def cb(d: int, _t: int | None, base: int = base, name: str = name) -> None:
            progress(base + d, max(total, base + d), name)

        if isinstance(item, WhisperItem):
            with _DirWatcher(item.cache_dir(root), lambda s, cb=cb: cb(s, None)):
                size = item.fetch(root, manifest, client, cb)
        else:
            size = item.fetch(root, manifest, client, cb)
        manifest.save()  # after every file: an interrupted run keeps what it finished
        done = base + (size or _approx_item_size(item, catalog))
        report.downloaded.append(name)
        report.bytes += size
        progress(done, max(total, done), name)

    for req in pip_todo:
        spec = req.cuda_spec if (use_cuda and req.cuda_spec) else req.spec
        if cuda_swap_needed(req, use_cuda):
            # piper-tts / faster-whisper pulled the CPU onnxruntime: both builds share the module
            # folder, so the CPU one goes first (and a half-shadowed -gpu is reinstalled clean).
            stale = [d for d in (req.cpu_dist, req.cuda_dist) if d and dist_installed(d)]
            if stale:
                say(f"{', '.join(stale)} instalado: se reemplaza por {spec} (CUDA)")
                code = runner(["uninstall", *stale], say)
                if code != 0:
                    raise RuntimeError(f"pip uninstall {' '.join(stale)} fallo (codigo {code})")
        args = (["--no-deps"] if req.no_deps else []) + list(req.extra_args) + [spec]
        say(f"pip install {' '.join(args)}")
        progress(done, total, f"pip:{req.spec}")
        with _pip_env(req.env):
            code = runner(args, say)
        if code != 0:
            raise RuntimeError(f"pip install {spec} fallo (codigo {code})")
        done += req.size
        report.pip.append(req.spec)
        progress(done, max(total, done), f"pip:{req.spec}")
    importlib.invalidate_caches()

    if pack.post_install is not None:
        pack.post_install(root)
    if pack.post_install_env is not None:
        pack.post_install_env(root, say)
    missing = [
        r.spec
        for r in pack.pip
        if not module_present(r.module) or cuda_swap_needed(r, bool(use_cuda))
    ]
    if missing:
        raise RuntimeError("Paquetes Python no importables tras instalar: " + ", ".join(missing))
    manifest.packs[pack_id] = {
        "date": now_iso(),
        "files": len(items),
        "pip": [r.spec for r in pack.pip],
    }
    manifest.save()
    return report
