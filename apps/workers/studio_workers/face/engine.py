"""Face swap task: FaceFusion 3.9.1 ``headless-run`` on a trimmed clip (or one frame) with the
photos of a Person who consented (docs/trabajo/sprint4-contratos.md «M1 · Workers»).

Order of the defence-in-depth checks (the api already ran them): licence in the mirror -> isolated
venv ready (TOOL_MISSING) -> model files + their CRC32 (PACK_REQUIRED before launching: FaceFusion
would otherwise try to download them) -> limits (CLIP_TOO_LONG) -> reference face in the chosen
frame (NO_FACE). GPU: ``budget.release()`` + ``acquire("facefusion", 3500, unload=kill)``; without
VRAM FaceFusion runs with ``--execution-providers cpu`` and the result says ``gpu_fallback_cpu``.

Video: ffmpeg trims the range first (re-encoded, frame accurate) to ``source.mp4``; FaceFusion
writes ``ff.mp4``; ``strength < 1`` blends it over the source (ffmpeg ``blend``, H.264 CRF 16);
``faceswap.mp4`` keeps the source audio. Preview: before.png (frame at preview_t) / after.png.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings
from ..gpu import GPU_FALLBACK_CPU, Decision, GpuBudget
from . import tool
from .detect import (
    Detector,
    DetectorFactory,
    default_detector_factory,
    extract_frame,
    find_faces,
    read_image,
)
from .detect import detect as detect_frame
from .runner import HeadlessArgs, classify, headless_args, run_process
from .schemas import FaceSwapWorkerRequest

log = logging.getLogger("studio_workers")

FACEFUSION_VRAM_MB = 3500  # = FEATURE_VRAM_MB.faceswap [S]
MAX_SECONDS = 600.0
MAX_LONG_SIDE = 3840
MAX_SHORT_SIDE = 2160
CPU_SLOW = "facefusion_cpu_slow"

MSG = {
    "LICENCE_REQUIRED": (
        "Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no comerciales "
        "+ OpenRAIL-AS) en pantalla: Ajustes → Paquetes de IA."
    ),
    "CONTENT_BLOCKED": (
        "El analizador de contenido de FaceFusion bloqueó este video o imagen: no se procesa."
    ),
    "CLIP_TOO_LONG": "Se procesan tramos de hasta 10 min y 4K: dividí el clip.",
    "TOOL_MISSING_PYTHON": "Falta Python 3.12: corré scripts\\windows\\setup.ps1 -Update.",
}
STATE_ES = {
    "ready": "listo",
    "stale": "desactualizado",
    "missing": "falta",
    "broken": "roto",
    "python": "falta Python 3.12",
}


class FaceCanceled(RuntimeError):
    pass


def _coded(code: str, detail: str, details: dict | None = None) -> Exception:
    from ..errors import CodedError  # noqa: PLC0415 - errors imports packs/tts/vision (cycle)

    return CodedError(code, detail, details=details)


def tool_missing(state: str) -> Exception:
    msg = (
        MSG["TOOL_MISSING_PYTHON"]
        if state == "python"
        else (
            f"El entorno aislado de FaceFusion no está listo ({STATE_ES.get(state, state)}). "
            "Volvé a descargar el paquete en Ajustes → Paquetes de IA o corré "
            "scripts\\windows\\setup.ps1 -Update."
        )
    )
    return _coded("TOOL_MISSING", msg, {"tool": "facefusion", "state": state, "packId": "faceswap"})


def _ffmpeg(args: list[str], timeout: float = 3600.0) -> None:
    from ..vision.frames import ffmpeg_exe  # noqa: PLC0415

    out = subprocess.run(  # noqa: S603 - fixed argv
        [ffmpeg_exe(), "-y", "-v", "error", *args], capture_output=True, text=True,
        timeout=timeout, check=False,
    )  # fmt: skip
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg falló: {out.stderr.strip()[-400:]}")


def trim_clip(src: Path, start: float, end: float, out: Path) -> Path:
    """Frame-accurate range (re-encoded, high quality) as MP4: FaceFusion's output needs the same
    extension as its target, and the final asset is an .mp4."""
    _ffmpeg([
        "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{max(0.04, end - start):.3f}",
        "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    ])  # fmt: skip
    return out


def finalize_video(swapped: Path, source: Path, out: Path, strength: float) -> Path:
    """faceswap.mp4: FaceFusion's video (strength 1, stream copy) or blended over the source
    (strength < 1: outside the face the pixels are the same), with the source audio."""
    if strength >= 0.999:
        _ffmpeg([
            "-i", str(swapped), "-i", str(source), "-map", "0:v:0", "-map", "1:a:0?",
            "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", str(out),
        ])  # fmt: skip
    else:
        graph = (
            "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];"
            f"[a][b]blend=all_mode=normal:all_opacity={strength:.3f}[v]"
        )
        _ffmpeg([
            "-i", str(swapped), "-i", str(source), "-filter_complex", graph, "-map", "[v]",
            "-map", "1:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
            "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(out),
        ])  # fmt: skip
    return out


def blend_image(swapped: Path, source: Path, strength: float) -> None:
    if strength >= 0.999:
        return
    tmp = swapped.with_name(swapped.stem + "-blend.png")
    graph = f"[0:v][1:v]blend=all_mode=normal:all_opacity={strength:.3f}"
    _ffmpeg(["-i", str(swapped), "-i", str(source), "-filter_complex", graph, str(tmp)])
    tmp.replace(swapped)


class FaceEngine:
    """One FaceFusion run at a time (face queue); cancel kills the process tree."""

    def __init__(
        self,
        settings: Settings,
        budget: GpuBudget,
        *,
        command: Callable[[str, list[str]], tuple[list[str], dict[str, str], Path]] | None = None,
        detector_factory: DetectorFactory | None = None,
        require_models: Callable[[str, bool], None] | None = None,
        tool_state: Callable[[], str] | None = None,
        licence_ok: Callable[[str], bool] | None = None,
        spawn: Callable[..., subprocess.Popen] | None = None,
    ) -> None:
        self.settings = settings
        self.budget = budget
        self.command = command or tool.command
        self.detector_factory = detector_factory or default_detector_factory
        self.require_models = require_models or self._require_models
        self.tool_state = tool_state or tool.tool_state
        self.licence_ok = licence_ok or tool.licence_accepted
        self.spawn = spawn
        self._lock = threading.Lock()
        self._procs: dict[str, subprocess.Popen] = {}
        self._canceled: set[str] = set()
        self._detector: Detector | None = None
        # task id -> (code, details) of the failure (GET /face/tasks/{id} answers it)
        self.task_errors: dict[str, tuple[str, dict | None]] = {}

    # ------------------------------------------------------------------ detection
    def detector(self) -> Detector:
        if self._detector is None:
            self._detector = self.detector_factory(self.settings.models_root)
        return self._detector

    def detect(self, src: Path, t: float) -> dict[str, Any]:
        return detect_frame(self.settings, src, t, self.detector())

    # ------------------------------------------------------------------ control
    def cancel(self, task_id: str) -> bool:
        from .runner import kill_tree  # noqa: PLC0415

        with self._lock:
            self._canceled.add(task_id)
            proc = self._procs.get(task_id)
        if proc is not None:
            kill_tree(proc)
        return proc is not None

    def _kill_all(self) -> None:
        """GpuBudget unload of «facefusion»: terminate the running subprocess."""
        from .runner import kill_tree  # noqa: PLC0415

        with self._lock:
            procs = list(self._procs.values())
        for proc in procs:
            kill_tree(proc)

    def _require_models(self, model: str, enhancer: bool) -> None:
        from ..packs import (  # noqa: PLC0415
            FACEFUSION_MODELS,
            PackRequiredError,
            facefusion_models_for,
            verify_facefusion_models,
        )

        names = facefusion_models_for(model, enhancer)
        bad = verify_facefusion_models(self.settings.models_root, names)
        if bad:
            pack = (
                "faceswap-extra"
                if any(FACEFUSION_MODELS[n].pack == "faceswap-extra" for n in bad)
                else "faceswap"
            )
            raise PackRequiredError(
                pack,
                f"Faltan o están dañados modelos de FaceFusion ({', '.join(bad)}): volvé a "
                "descargar el paquete en Ajustes → Paquetes de IA.",
            )

    def _check_reference(self, target: Path, t: float, index: int, work: Path) -> None:
        """NO_FACE when the chosen frame has fewer than `index` + 1 faces (no YuNet: skipped)."""
        try:
            detector = self.detector()
        except Exception:
            return
        frame = work / "reference.png"
        img_path = target if target.suffix.lower() == ".png" else extract_frame(target, t, frame)
        _w, _h, faces = find_faces(read_image(img_path), detector)
        frame.unlink(missing_ok=True)
        if len(faces) <= index:
            raise _coded(
                "NO_FACE",
                "No se encontró una cara en el fotograma elegido.",
                {"faces": len(faces), "faceIndex": index},
            )

    # ------------------------------------------------------------------ run
    def run(
        self,
        req: FaceSwapWorkerRequest,
        task_id: str,
        progress: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        from ..media import find_ffmpeg  # noqa: PLC0415
        from ..routers.analyze import resolve_input  # noqa: PLC0415
        from ..vision.frames import probe  # noqa: PLC0415

        step = progress or (lambda _p, _m: None)
        s = self.settings
        t_start = time.perf_counter()
        sources = [resolve_input(s, p) for p in req.source_paths]
        target = resolve_input(s, req.target_path)
        if not req.output_base.replace("\\", "/").startswith("renders/"):
            raise ValueError("output_base tiene que estar dentro de renders/")
        out_dir = s.storage_path(req.output_base)
        for lid in req.licence_ids:
            if not self.licence_ok(lid):
                raise _coded("LICENCE_REQUIRED", MSG["LICENCE_REQUIRED"], {"licenceId": lid})
        state = self.tool_state()
        if state != "ready":
            raise tool_missing(state)
        self.require_models(req.model, req.enhancer)
        info = probe(target)
        long_side, short_side = max(info.width, info.height), min(info.width, info.height)
        if long_side > MAX_LONG_SIDE or short_side > MAX_SHORT_SIDE:
            raise _coded("CLIP_TOO_LONG", MSG["CLIP_TOO_LONG"])
        preview = req.preview_t is not None
        start, end = (0.0, info.duration) if req.range is None else req.range
        if not preview:
            end = min(end, info.duration) if info.duration > 0 else end
            if end - start > MAX_SECONDS + 0.5:
                raise _coded("CLIP_TOO_LONG", MSG["CLIP_TOO_LONG"])
            if end - start < 0.04:
                raise ValueError("El tramo a procesar no tiene duración")
        out_dir.mkdir(parents=True, exist_ok=True)
        work = s.storage_root / "tmp" / "ff" / task_id
        jobs = work / "jobs"
        jobs.mkdir(parents=True, exist_ok=True)

        sel = req.selector
        ref_index = sel.face_index or 0
        ref_frame = 0
        if sel.mode == "reference":
            t_ref = sel.t if sel.t is not None else (req.preview_t if preview else start)
            assert t_ref is not None
            self._check_reference(target, t_ref, ref_index, work)
            if not preview:
                ref_frame = max(0, round((t_ref - start) * info.fps_float))

        warnings: list[str] = []
        decision = Decision("cpu")
        if s.use_cuda:
            self.budget.release()
            decision = self.budget.acquire("facefusion", FACEFUSION_VRAM_MB, self._kill_all)
            warnings.extend(decision.warnings)
        device = "cuda" if decision.device == "cuda" else "cpu"
        if device == "cpu" and not preview:
            warnings.append(CPU_SLOW)
        timings: dict[str, float] = {}
        try:
            if preview:
                before = extract_frame(target, float(req.preview_t or 0.0), out_dir / "before.png")
                ff_target, ff_out = before, out_dir / "after.png"
            else:
                step(0.01, "recortando el tramo")
                t0 = time.perf_counter()
                ff_target = trim_clip(target, start, end, out_dir / "source.mp4")
                ff_out = out_dir / "ff.mp4"
                timings["trim_s"] = round(time.perf_counter() - t0, 3)
            ff_out.unlink(missing_ok=True)
            args = headless_args(
                HeadlessArgs(
                    sources=sources,
                    target=ff_target,
                    output=ff_out,
                    model=req.model,
                    enhancer=req.enhancer,
                    enhancer_blend=req.enhancer_blend,
                    selector_mode=sel.mode,
                    reference_frame=ref_frame,
                    reference_index=ref_index,
                    reference_distance=sel.distance,
                    device=device,
                    temp_dir=work,
                    jobs_dir=jobs,
                )
            )
            argv, env, cwd = self.command("facefusion.py", args)
            env = tool.with_ffmpeg_path(dict(env), find_ffmpeg())
            lo, hi = (0.05, 0.95) if preview else (0.08, 0.93)
            step(lo, "iniciando FaceFusion")

            def on_start(proc: subprocess.Popen) -> None:
                with self._lock:
                    self._procs[task_id] = proc

            outcome = run_process(
                argv,
                env,
                cwd,
                on_progress=lambda p: step(lo + p * (hi - lo), f"FaceFusion {round(p * 100)} %"),
                on_start=on_start,
                is_canceled=lambda: task_id in self._canceled,
                spawn=self.spawn,
            )
            timings["facefusion_s"] = outcome.seconds
            if outcome.startup_s is not None:
                timings["startup_s"] = outcome.startup_s
            if outcome.canceled or task_id in self._canceled:
                raise FaceCanceled("Cancelado")
            failure = classify(outcome, ff_out.is_file() and ff_out.stat().st_size > 0)
            if failure is not None:
                log.warning("FaceFusion failed (%s): %s", failure.code, failure.line)
                tail = {"logTail": failure.tail}
                if failure.code == "CONTENT_BLOCKED":
                    raise _coded("CONTENT_BLOCKED", MSG["CONTENT_BLOCKED"], tail)
                raise _coded(
                    "TOOL_FAILED",
                    f"FaceFusion terminó con error: {failure.line.rstrip('.')}.",
                    tail,
                )
            if preview:
                blend_image(ff_out, ff_target, req.strength)
                frames, fps = 1, 0.0
                result_path, before_path = ff_out, ff_target
            else:
                step(0.94, "armando el video final")
                t1 = time.perf_counter()
                final = finalize_video(ff_out, ff_target, out_dir / "faceswap.mp4", req.strength)
                timings["finalize_s"] = round(time.perf_counter() - t1, 3)
                out_info = probe(final)
                frames, fps = out_info.frames, round(out_info.fps_float, 3)
                result_path, before_path = final, None
                ff_out.unlink(missing_ok=True)
                ff_target.unlink(missing_ok=True)
        finally:
            with self._lock:
                self._procs.pop(task_id, None)
                self._canceled.discard(task_id)
            if device == "cuda":
                self.budget.release("facefusion")
            shutil.rmtree(work, ignore_errors=True)
        timings["total_s"] = round(time.perf_counter() - t_start, 3)
        ff_seconds = timings.get("facefusion_s") or 0.0
        return {
            "output_path": s.storage_relative(result_path),
            "before_path": s.storage_relative(before_path) if before_path else None,
            "frames": int(frames),
            "fps": float(fps),
            "proc_fps": round(frames / ff_seconds, 3) if ff_seconds > 0 and not preview else 0.0,
            "device": device,
            "model": req.model,
            "timings": timings,
            "warnings": list(dict.fromkeys(w for w in warnings if w)),
            "log_tail": outcome.lines[-TAIL_RESULT:],
        }


TAIL_RESULT = 10
__all__ = ["GPU_FALLBACK_CPU", "FaceCanceled", "FaceEngine"]
