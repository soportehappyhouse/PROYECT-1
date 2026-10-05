"""Matting: RVM (pack matting, GPL subprocess) for people in video, BiRefNet-lite (pack
matting-image, MIT, in-process ONNX) for images (and video frame by frame, no temporal memory).

Output: WebM VP9 ``yuva420p`` (foreground RGB + alpha) written in chunks, a RGBA PNG preview and
the source fps. GPU: BiRefNet goes through the GPU budget (one resident model); before RVM the
budget unloads the resident model and the subprocess gets the VRAM left as
``STUDIO_VRAM_BUDGET_MB`` (it falls back to CPU itself and reports ``gpu_fallback_cpu``).
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings
from ..gpu import GPU_FALLBACK_CPU, GpuBudget
from ..packs import PackRequiredError, module_present
from . import gpl
from .frames import (
    ChunkedAlphaWriter,
    FrameReader,
    alpha_preview_png,
    ffmpeg_exe,
    probe,
    read_rgb,
    write_png,
)

log = logging.getLogger("studio_workers")

BIREFNET_FILE = "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"
BIREFNET_VRAM_MB = 1800  # lite fp32 at 1024 [S, docs §10.1: 1.5-2 GB]
RVM_FILES = ("rvm_mobilenetv3_fp16.torchscript", "rvm_mobilenetv3_fp32.torchscript")
RVM_VRAM_MB = 900
CPU_SLOW = "cpu_slow"
BIREFNET_FLICKER = "birefnet_video_flicker"

AlphaFn = Callable[[Any], Any]  # uint8 HxWx3 RGB -> uint8 HxW alpha
AlphaFactory = Callable[[str], AlphaFn]  # device -> model


def birefnet_path(root: Path) -> Path:
    return root / "birefnet" / BIREFNET_FILE


def rvm_dir(root: Path) -> Path:
    return root / "matting"


class BiRefNetOnnx:
    """BiRefNet-general-lite (Swin-T) ONNX from the rembg releases: 1024x1024, ImageNet norm."""

    SIZE = 1024

    def __init__(self, path: Path, device: str) -> None:
        import numpy as np  # noqa: PLC0415
        import onnxruntime as ort  # noqa: PLC0415

        providers = ["CPUExecutionProvider"]
        if device == "cuda":
            if hasattr(ort, "preload_dlls"):  # cuDNN/cuBLAS from torch cu128 (ORT >= 1.21)
                try:
                    ort.preload_dlls()
                except Exception as exc:  # pragma: no cover - driver specific
                    log.info("onnxruntime preload_dlls: %s", exc)
            providers = ["CUDAExecutionProvider", *providers]
        self.session = ort.InferenceSession(str(path), providers=providers)
        self.device = "cuda" if "CUDAExecutionProvider" in self.session.get_providers() else "cpu"
        self.input = self.session.get_inputs()[0].name
        self.mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        self.std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def __call__(self, rgb: Any) -> Any:
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415

        h, w = rgb.shape[:2]
        x = cv2.resize(rgb, (self.SIZE, self.SIZE), interpolation=cv2.INTER_LINEAR)
        x = (x.astype(np.float32) / 255.0 - self.mean) / self.std
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        pred = self.session.run(None, {self.input: x})[0][0, 0]
        pred = 1.0 / (1.0 + np.exp(-pred))
        lo, hi = float(pred.min()), float(pred.max())
        pred = (pred - lo) / (hi - lo) if hi - lo > 1e-6 else pred
        mask = cv2.resize((pred * 255).astype(np.uint8), (w, h), interpolation=cv2.INTER_LINEAR)
        return mask


class MatteEngine:
    def __init__(
        self,
        settings: Settings,
        budget: GpuBudget | None = None,
        alpha_factory: AlphaFactory | None = None,
    ) -> None:
        self.settings = settings
        self.budget = budget
        self.alpha_factory = alpha_factory
        self.rvm_extra_args: list[str] = []  # tests: ["--mock-model"]
        self._model: AlphaFn | None = None
        self._device: str | None = None
        self._lock = threading.RLock()
        self._rvm_proc: subprocess.Popen[str] | None = None

    # ------------------------------------------------------------------------ availability
    @property
    def root(self) -> Path:
        return self.settings.models_root

    def gpl_venv(self) -> Path:
        return (
            Path(self.settings.gpl_venv_dir)
            if self.settings.gpl_venv_dir
            else (gpl.default_venv_dir())
        )

    def gpl_status(self) -> dict[str, Any]:
        return gpl.status(self.gpl_venv(), self.settings.gpl_python)

    def birefnet_device(self) -> str | None:
        """Device of the loaded BiRefNet session (None when not loaded)."""
        with self._lock:
            return self._device if self._model is not None else None

    def birefnet_available(self) -> bool:
        if self.alpha_factory is not None:
            return True
        return (
            all(module_present(m) for m in ("onnxruntime", "numpy", "cv2"))
            and birefnet_path(self.root).is_file()
        )

    def rvm_available(self) -> bool:
        files = all((rvm_dir(self.root) / f).is_file() for f in RVM_FILES)
        mock = "--mock-model" in self.rvm_extra_args
        return (files or mock) and self.gpl_status()["state"] == "ready"

    def require(self, model: str) -> None:
        if model == "rvm" and not self.rvm_available():
            raise PackRequiredError("matting")
        if model == "birefnet" and not self.birefnet_available():
            raise PackRequiredError("matting-image")

    # ------------------------------------------------------------------------ birefnet
    def unload(self) -> None:
        with self._lock:
            self._model = None
            self._device = None

    def _birefnet(self) -> tuple[AlphaFn, str, list[str]]:
        warnings: list[str] = []
        device = "cpu"
        if self.settings.use_cuda and self.budget is not None:
            decision = self.budget.acquire("birefnet-lite", BIREFNET_VRAM_MB, self.unload)
            device = decision.device
            warnings += decision.warnings
        with self._lock:
            if self._model is None or self._device != device:
                factory = self.alpha_factory or (
                    lambda dev: BiRefNetOnnx(birefnet_path(self.root), dev)
                )
                try:
                    self._model = factory(device)
                except Exception as exc:
                    if device != "cuda":
                        raise
                    log.warning("BiRefNet on CUDA failed (%s); CPU", exc)
                    if self.budget is not None:
                        warnings += self.budget.failed("birefnet-lite")
                    device = "cpu"
                    self._model = factory(device)
                real = getattr(self._model, "device", device)
                if real != device and device == "cuda":
                    warnings.append(GPU_FALLBACK_CPU)
                    device = real
                self._device = device
            return self._model, device, warnings

    def matte_image(self, src: Path, out: Path) -> dict[str, Any]:
        import numpy as np  # noqa: PLC0415

        self.require("birefnet")
        fn, device, warnings = self._birefnet()
        rgb, _info = read_rgb(src)
        alpha = fn(rgb)
        write_png(out, np.dstack([rgb, alpha]))
        return {"device": device, "warnings": list(dict.fromkeys(warnings))}

    # ------------------------------------------------------------------------ video
    def matte_video(
        self,
        src: Path,
        out: Path,
        *,
        model: str,
        downsample: float | None = None,
        chunk: int = 300,
        progress: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        self.require(model)
        notify = progress or (lambda _p, _m: None)
        # Deterministic work dir: a job re-submitted after a crash/restart resumes from the
        # chunks already finished (RVM keeps them until the final WebM is written).
        st = src.stat()
        key = f"{src.resolve()}|{st.st_size}|{st.st_mtime_ns}|{out.resolve()}|{model}|{chunk}"
        work = (
            self.settings.storage_root
            / "tmp"
            / "matte"
            / hashlib.sha1(key.encode()).hexdigest()[:16]
        )
        work.mkdir(parents=True, exist_ok=True)
        info = probe(src)
        if model == "rvm":
            res = self._rvm(src, out, work, downsample, chunk, notify)
        else:
            res = self._birefnet_video(src, out, work, chunk, notify)
        shutil.rmtree(work, ignore_errors=True)  # only on success
        notify(0.97, "vista previa")
        preview = out.with_name(out.name.removesuffix(".webm") + ".preview.png")
        alpha_preview_png(out, preview, at=min(info.duration / 2, 1.0) if info.duration else 0.0)
        return {**res, "preview": preview, "fps": round(info.fps_float, 6), "info": info}

    def _birefnet_video(
        self,
        src: Path,
        out: Path,
        work: Path,
        chunk: int,
        notify: Callable[[float, str], None],
    ) -> dict[str, Any]:
        import numpy as np  # noqa: PLC0415

        fn, device, warnings = self._birefnet()
        warnings.append(BIREFNET_FLICKER)
        if device == "cpu":
            warnings.append(CPU_SLOW)
        info = probe(src)
        writer = ChunkedAlphaWriter(work, info.width, info.height, info.fps, chunk)
        n = 0
        try:
            for _i, rgb in FrameReader(src, info):
                writer.write(np.dstack([rgb, fn(rgb)]))
                n += 1
                if n % 5 == 0:
                    notify(min(0.95, n / info.frames * 0.95), f"fotograma {n}/{info.frames}")
            writer.finish(out)
        except BaseException:
            writer.abort()
            raise
        return {"device": device, "frames": n, "warnings": list(dict.fromkeys(warnings))}

    def _kill_rvm(self) -> None:
        proc = self._rvm_proc
        if proc is not None and proc.poll() is None:
            proc.terminate()

    def _rvm(
        self,
        src: Path,
        out: Path,
        work: Path,
        downsample: float | None,
        chunk: int,
        notify: Callable[[float, str], None],
    ) -> dict[str, Any]:
        st = self.gpl_status()
        python = st["python"]
        if st["state"] != "ready" or not python:
            raise PackRequiredError("matting")
        device, vram_left, warnings = "cpu", None, []
        budget = self.budget
        if self.settings.use_cuda and budget is not None:
            budget.release()  # one resident model: free the GPU before the subprocess
            info = budget.vram(fresh=True)
            vram_left = (info.free_mb - budget.reserve_mb) if info else None
            decision = budget.acquire("rvm", RVM_VRAM_MB, self._kill_rvm)
            device = decision.device
            warnings += decision.warnings

        def on_event(ev: dict[str, Any]) -> None:
            if ev.get("event") == "progress":
                fps = ev.get("fps")
                notify(float(ev.get("progress") or 0) * 0.95,
                       f"fotograma {ev.get('frame')}/{ev.get('frames')} ({fps} fps)")  # fmt: skip

        def on_start(proc: subprocess.Popen[str]) -> None:
            self._rvm_proc = proc

        try:
            run = gpl.run_rvm(
                python,
                src=src,
                out=out,
                model_dir=rvm_dir(self.root),
                work_dir=work / "rvm",
                downsample=downsample,
                chunk=chunk,
                device=device,
                vram_budget_mb=vram_left,
                ffmpeg=ffmpeg_exe(),
                on_event=on_event,
                on_start=on_start,
                extra_args=self.rvm_extra_args,
            )
        finally:
            self._rvm_proc = None
            if budget is not None:
                budget.release("rvm")
        warnings += run.warnings
        if run.device == "cpu" and self.settings.use_cuda and GPU_FALLBACK_CPU not in warnings:
            warnings.append(GPU_FALLBACK_CPU)
        return {
            "device": run.device,
            "frames": run.frames,
            "proc_fps": run.proc_fps,
            "precision": run.precision,
            "downsample": run.downsample,
            "warnings": list(dict.fromkeys(warnings)),
        }
