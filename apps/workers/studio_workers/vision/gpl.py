"""Bridge to the GPL-isolated RVM runner (apps/workers/vision_gpl) - no GPL code is imported here.

``.venv-gpl`` (next to ``.venv``) is created by the workers themselves when the ``matting`` pack is
downloaded from the app, or by ``setup.ps1`` (``models_cli --gpl-venv``): ``python -m venv`` with
the workers' interpreter + ``pip install -r vision_gpl/requirements.txt``. When the main venv
already has torch, a ``studio-main.pth`` appends the main site-packages AFTER the GPL venv's own
(no second 2.5 GB torch; pip then sees torch as installed). A stamp file records the requirements
hash: a changed requirements.txt makes the next ensure re-run pip ("stale").

The runner is ``<venv-gpl python> -m vision_gpl.rvm ...`` with cwd ``apps/workers``; its stdout is
JSON lines (see vision_gpl/rvm.py). ``GPL_PYTHON`` in .env/tests overrides the interpreter.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import subprocess
import sys
import sysconfig
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from ..tasks import kill_process_tree, new_group_kwargs, on_cancel_kill

log = logging.getLogger("studio_workers")

WORKERS_DIR = Path(__file__).resolve().parents[2]  # apps/workers
GPL_PKG_DIR = WORKERS_DIR / "vision_gpl"
GPL_REQUIREMENTS = GPL_PKG_DIR / "requirements.txt"
STAMP = ".studio-gpl-install"
SHARE_PTH = "studio-main.pth"
CU128_INDEX = "https://download.pytorch.org/whl/cu128"

LineFn = Callable[[str], None]
Runner = Callable[[list[str], LineFn], int]


def default_venv_dir() -> Path:
    return WORKERS_DIR / ".venv-gpl"


def venv_python(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def requirements_hash() -> str:
    return hashlib.sha256(GPL_REQUIREMENTS.read_bytes()).hexdigest()[:16]


def _stamp_line(use_cuda: bool) -> str:
    return f"{requirements_hash()} {'cuda' if use_cuda else 'cpu'}"


def status(venv: Path, override_python: str = "") -> dict[str, Any]:
    """{state: ready|stale|missing, python, dir} (filesystem only, cheap)."""
    if override_python:
        return {"state": "ready", "python": override_python, "dir": None, "override": True}
    py = venv_python(venv)
    if not py.is_file():
        return {"state": "missing", "python": None, "dir": str(venv)}
    stamp = venv / STAMP
    try:
        line = stamp.read_text("utf-8").strip() if stamp.is_file() else ""
    except OSError:
        line = ""
    ok = bool(line) and line.split(" ")[0] == requirements_hash()
    return {"state": "ready" if ok else "stale", "python": str(py), "dir": str(venv)}


def default_runner(cmd: list[str], on_line: LineFn) -> int:
    on_line("> " + " ".join(Path(cmd[0]).name if i == 0 else c for i, c in enumerate(cmd)))
    proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(WORKERS_DIR),
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line)
    return proc.wait()


def _site_packages(py: Path) -> Path | None:
    try:
        out = subprocess.run(
            [str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            capture_output=True, text=True, timeout=60,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return None
    path = out.stdout.strip()
    return Path(path) if out.returncode == 0 and path else None


def ensure_venv(
    venv: Path,
    *,
    use_cuda: bool,
    on_line: LineFn | None = None,
    runner: Runner | None = None,
    force: bool = False,
    share_torch: bool | None = None,
) -> str:
    """Create/update .venv-gpl. Returns 'omitido' (already ready) or 'ejecutado'."""
    say = on_line or (lambda _l: None)
    run = runner or default_runner
    st = status(venv)
    py = venv_python(venv)
    check = [str(py), "-c", "import numpy, torch; print('torch', torch.__version__)"]
    if st["state"] == "ready" and not force:
        # The stamp only says pip ran with these requirements: torch comes from the main .venv
        # through studio-main.pth (an absolute path) and can break later (main torch swapped for
        # the cu128 build, folder moved/renamed...). setup.ps1 used to say «ready» while doctor
        # said «import torch fallo»: check it, and repair (rewrite the .pth + pip) when it fails.
        lines: list[str] = []
        if run(check, lines.append) == 0:
            say(f"entorno GPL listo: {venv}")
            return "omitido"
        detail = next((ln.strip() for ln in reversed(lines) if ln.strip()), "sin detalle")
        say(f"entorno GPL: import torch falló ({detail}); se repara")
    if not py.is_file():
        say(f"creando entorno aislado GPL (.venv-gpl) en {venv}")
        # sys.executable may itself be a venv python: venv uses its base interpreter.
        if run([sys.executable, "-m", "venv", str(venv)], say) != 0:
            raise RuntimeError("python -m venv .venv-gpl fallo")
    share = find_spec("torch") is not None if share_torch is None else share_torch
    site = _site_packages(py) if py.is_file() else None
    if site is not None:
        pth = site / SHARE_PTH
        if share:
            main_site = sysconfig.get_paths()["purelib"]
            # A plain path line: appended to sys.path (after the venv's own packages); .pth files
            # inside the main site-packages are NOT processed (no editable studio_workers hooks).
            pth.write_text(main_site + "\n", "utf-8")
            say(f"torch compartido con el entorno principal ({main_site})")
        else:
            pth.unlink(missing_ok=True)
    args = [str(py), "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"]
    args += ["-r", str(GPL_REQUIREMENTS)]
    if use_cuda and not share:
        args += ["--extra-index-url", CU128_INDEX]
    if run(args, say) != 0:
        raise RuntimeError("pip install -r vision_gpl/requirements.txt fallo en .venv-gpl")
    if run(check, say) != 0:
        raise RuntimeError(".venv-gpl: import torch/numpy fallo")
    (venv / STAMP).write_text(_stamp_line(use_cuda) + "\n", "utf-8")
    return "ejecutado"


# ------------------------------------------------------------------------------------ runner


@dataclass
class RvmRun:
    output: Path
    frames: int = 0
    fps: str = ""
    device: str = "cpu"
    proc_fps: float = 0.0
    precision: str = ""  # fp16 (CUDA) | fp32 (CPU)
    downsample: float | None = None
    alpha_codec: str = "vp9"  # vp9 (WebM yuva420p) | split (MKV: NVENC colour + alpha streams)
    # per-stage ms/frame, bottleneck, load/first-batch/process/concat seconds (vision_gpl.rvm)
    # + startup_s (spawn -> start event: interpreter, torch import, model load) and total_s
    timings: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    # Sprint 3b «Recorte de calidad alta»: fast (mobilenetv3) | high (resnet50 + refinement)
    quality: str = "fast"
    model: str = ""
    refine: dict[str, Any] | None = None  # parameters used (None = alpha untouched)
    halo: dict[str, Any] | None = None  # {before, after, frames, reduction} (no-reference)
    compare_path: Path | None = None  # before | after PNG of one frame
    mask_frames: int | None = None  # frames guided by the SAM mask


def refine_args(
    quality: str = "fast",
    refine: dict[str, Any] | None = None,
    mask_path: Path | None = None,
    compare_out: Path | None = None,
    compare_frame: int | None = None,
) -> list[str]:
    """CLI flags of vision_gpl.rvm for the quality mode, the alpha refinement (keys erode,
    feather, despill, temporal, mask_dilate; absent = default of the quality), the SAM mask guide
    and the before/after comparison frame."""
    args = ["--quality", quality]
    r = refine or {}
    for key, flag in (("erode", "--erode"), ("feather", "--feather"), ("temporal", "--temporal"),
                      ("mask_dilate", "--mask-dilate")):  # fmt: skip
        if r.get(key) is not None:
            args += [flag, str(r[key])]
    if r.get("despill") is not None:
        args += ["--despill", "on" if r["despill"] else "off"]
    if mask_path is not None:
        args += ["--mask", str(mask_path)]
    if compare_out is not None:
        args += ["--compare-out", str(compare_out)]
        if compare_frame is not None:
            args += ["--compare-frame", str(int(compare_frame))]
    return args


class GplProcessError(RuntimeError):
    pass


def run_rvm(
    python: str,
    *,
    src: Path,
    out: Path,
    model_dir: Path,
    work_dir: Path,
    downsample: float | None,
    chunk: int,
    device: str,
    vram_budget_mb: int | None,
    ffmpeg: str | None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    on_start: Callable[[subprocess.Popen[str]], None] | None = None,
    extra_args: list[str] | None = None,
    timeout: float | None = None,
    alpha_codec: str = "vp9",
) -> RvmRun:
    cmd = [
        python, "-m", "vision_gpl.rvm", "--input", str(src), "--output", str(out),
        "--downsample", "auto" if downsample is None else str(downsample),
        "--chunk", str(chunk), "--device", device, "--model-dir", str(model_dir),
        "--work-dir", str(work_dir), "--alpha-codec", alpha_codec,
    ]  # fmt: skip
    if ffmpeg:
        cmd += ["--ffmpeg", ffmpeg]
    cmd += extra_args or []
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(WORKERS_DIR)  # vision_gpl is not pip-installed: run from apps/workers
    if vram_budget_mb is not None:
        env["STUDIO_VRAM_BUDGET_MB"] = str(int(vram_budget_mb))
    t_spawn = time.perf_counter()
    started: float | None = None
    proc = subprocess.Popen(  # noqa: S603 - fixed argv
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(WORKERS_DIR),
        env=env,
        **new_group_kwargs(),
    )
    # Cancel (TaskQueue.cancel) kills the GPL tree so its VRAM is freed right away.
    on_cancel_kill(proc)
    if on_start:
        on_start(proc)
    tail: deque[str] = deque(maxlen=40)

    def drain() -> None:  # stderr must be read concurrently or a chatty torch could block
        assert proc.stderr is not None
        try:
            for err_line in proc.stderr:
                tail.append(err_line.rstrip())
        except (OSError, ValueError):  # pipe closed by the finally below
            pass

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    result: dict[str, Any] | None = None
    error: str | None = None
    warnings: list[str] = []
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                log.info("vision_gpl: %s", line)
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("event")
            if kind == "start" and started is None:
                started = time.perf_counter() - t_spawn
            if kind == "done":
                result = event
            elif kind == "error":
                error = str(event.get("message") or "error")
            elif kind == "warning" and event.get("code"):
                warnings.append(str(event["code"]))
            if on_event:
                on_event(event)  # may raise TaskCanceled (progress after a cancel)
        code = proc.wait(timeout=timeout)
    finally:
        # Canceled (TaskCanceled from on_event), timeout or any error: never leave the GPL
        # subprocess alive holding VRAM. No-op when it already exited.
        kill_process_tree(proc)
        reader.join(timeout=5)
        for pipe in (proc.stdout, proc.stderr):
            if pipe is not None:
                with contextlib.suppress(OSError):
                    pipe.close()
    stderr = "\n".join(tail)
    if code != 0 or result is None:
        detail = error or stderr.strip()[-500:] or f"codigo {code}"
        raise GplProcessError(f"Recorte RVM fallo: {detail}")
    timings = dict(result.get("timings") or {})
    if started is not None:
        timings["startup_s"] = round(started, 3)
    timings["total_s"] = round(time.perf_counter() - t_spawn, 3)
    return RvmRun(
        output=Path(result.get("output") or out),
        frames=int(result.get("frames") or 0),
        fps=str(result.get("fps") or ""),
        device=str(result.get("device") or "cpu"),
        proc_fps=float(result.get("proc_fps") or 0.0),
        precision=str(result.get("precision") or ""),
        downsample=float(result["downsample"]) if result.get("downsample") else None,
        alpha_codec=str(result.get("alpha_codec") or "vp9"),
        timings=timings,
        warnings=list(dict.fromkeys([*warnings, *(result.get("warnings") or [])])),
        quality=str(result.get("quality") or "fast"),
        model=str(result.get("model") or ""),
        refine=result.get("refine") if isinstance(result.get("refine"), dict) else None,
        halo=result.get("halo") if isinstance(result.get("halo"), dict) else None,
        compare_path=Path(result["compare_path"]) if result.get("compare_path") else None,
        mask_frames=int(result["mask_frames"]) if result.get("mask_frames") is not None else None,
    )
