"""AI performance test ("Test de rendimiento IA"): measures this PC -> storage/run/perf.json.

Components whose pack (or Python package) is missing are skipped and listed in ``skipped`` with
the reason, so the UI can show "descargá el paquete X para medirlo".
"""

from __future__ import annotations

import contextlib
import json
import logging
import shutil
import subprocess
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import services
from .config import Settings
from .media import run_ffmpeg
from .packs import is_installed, module_present
from .stt.engine import TURBO_MODEL, installed_models

log = logging.getLogger("studio_workers")

PERF_FILE = "perf.json"
PIPER_TEXT = (
    "Hola, esta es una prueba de rendimiento de la voz local de Studio para medir cuanto tarda."
)[:100].ljust(100, ".")
# Speech-like test signal: harmonics with syllable-rate modulation and pauses (no real words).
SPEECHLIKE = (
    "aevalsrc='(0.4*sin(2*PI*180*t)+0.2*sin(2*PI*360*t)+0.1*sin(2*PI*540*t))"
    "*(0.5+0.5*sin(2*PI*4*t))*between(mod(t\\,3)\\,0\\,2.2)':s=16000:d={d}"
)

Step = Callable[[float, str], None]


def perf_path(settings: Settings) -> Path:
    return settings.storage_root / "run" / PERF_FILE


def read_last(settings: Settings) -> dict[str, Any] | None:
    path = perf_path(settings)
    try:
        return json.loads(path.read_text("utf-8")) if path.is_file() else None
    except (OSError, ValueError):
        return None


def make_speech(dst: Path, seconds: float) -> Path:
    run_ffmpeg(["-f", "lavfi", "-i", SPEECHLIKE.format(d=seconds), "-ac", "1", str(dst)])
    return dst


def make_scenes_video(dst: Path, seconds_each: float = 3.0) -> Path:
    colors = ("red", "blue", "green", "white")
    args: list[str] = []
    for c in colors:
        args += ["-f", "lavfi", "-i", f"color=c={c}:s=640x360:r=25:d={seconds_each}"]
    chain = "".join(f"[{i}:v]" for i in range(len(colors)))
    args += [
        "-filter_complex",
        f"{chain}concat=n={len(colors)}:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        str(dst),
    ]
    run_ffmpeg(args)
    return dst


def run_perf(
    settings: Settings,
    step: Step | None = None,
    *,
    face_source_path: str | None = None,
    licences: list[str] | None = None,
    face_consent_id: str | None = None,
) -> dict[str, Any]:
    """``face_source_path`` (STORAGE_DIR-relative photo of the first Person with a valid face
    consent), its ``face_consent_id`` and ``licences`` (accepted LicenceIds) come from the api
    (POST /perf/run)."""
    notify = step or (lambda _p, _m: None)
    root = settings.models_root
    budget = services.gpu_budget()
    result: dict[str, Any] = {
        # contract: `gpu` is a label (GPU name or "cpu"); the full /gpu/status goes in gpu_status
        "gpu": None,
        "gpu_status": budget.status(),
        "whisper_turbo_s_per_min": None,
        "whisper_s_per_min": None,
        "whisper_model": None,
        "whisper_device": None,
        "piper_s_per_100chars": None,
        "rvc_s_per_min": None,
        "scenes_fps": None,
        # sprint 2 (vision): None + skipped[...] when the pack is missing
        "rvm_fps": None,
        "rvm_hq_steady_fps": None,  # sprint 3b: matting-hq (resnet50 + refinement)
        "sam2_fps": None,
        "yunet_fps": None,
        # sprint 4 (M3): RVC device, Chatterbox, FaceFusion and the isolated tool venvs
        "rvc_device": None,
        "chatterbox_rtf": None,
        "chatterbox_load_s": None,
        "chatterbox_device": None,
        "chatterbox_model": None,
        "facefusion_fps": None,
        "facefusion_enh_fps": None,
        "facefusion_startup_s": None,
        "facefusion_device": None,
        "facefusion_model": None,
        "tools": {},
        "cpu_fallback_ok": None,
        "ran_at": None,
        "skipped": {},
        "errors": {},
        "warnings": [],
    }
    skipped: dict[str, str] = result["skipped"]
    errors: dict[str, str] = result["errors"]
    work = settings.storage_root / "tmp" / f"perf-{int(time.time())}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        # ------------------------------------------------------------------ whisper (60 s)
        notify(0.05, "Whisper")
        has_whisper = module_present("faster_whisper")
        models = installed_models(root) if has_whisper else []
        if not has_whisper:
            skipped["whisper"] = "falta el paquete Python faster-whisper"
        else:
            try:
                audio = make_speech(work / "speech60.wav", 60)
                engine = services.whisper_engine()
                if TURBO_MODEL in models:
                    t0 = time.perf_counter()
                    tr = engine.transcribe(audio, model=TURBO_MODEL, vad=False)
                    result["whisper_turbo_s_per_min"] = round(time.perf_counter() - t0, 2)
                    result["whisper_device"] = tr.device
                    result["warnings"] += tr.warnings or []
                else:
                    skipped["whisper_turbo"] = "paquete whisper-turbo no instalado"
                small = settings.whisper_model if settings.whisper_model in models else None
                small = small or next((m for m in ("base", "small", "tiny") if m in models), None)
                if small:
                    notify(0.3, f"Whisper {small}")
                    t0 = time.perf_counter()
                    tr = engine.transcribe(audio, model=small, vad=False)
                    result["whisper_s_per_min"] = round(time.perf_counter() - t0, 2)
                    result["whisper_model"] = small
                    result["whisper_device"] = result["whisper_device"] or tr.device
                    # CPU fallback path (what happens when the GPU is busy or missing).
                    notify(0.45, "Whisper en CPU")
                    clip = make_speech(work / "speech5.wav", 5)
                    try:
                        engine.transcribe(clip, model=small, vad=False, force_device="cpu")
                        result["cpu_fallback_ok"] = True
                    except Exception as exc:
                        result["cpu_fallback_ok"] = False
                        errors["cpu_fallback"] = str(exc)
                elif "whisper_turbo" in skipped:
                    skipped["whisper"] = "ningun modelo Whisper descargado (paquete core)"
            except Exception as exc:
                errors["whisper"] = str(exc)

        # ------------------------------------------------------------------ piper (100 chars)
        notify(0.55, "Piper")
        voice = settings.piper_default_voice
        from .tts.piper_catalog import installed_voice_ids  # noqa: PLC0415

        if not module_present("piper"):
            skipped["piper"] = "falta el paquete Python piper-tts"
        elif voice not in installed_voice_ids(root):
            skipped["piper"] = f"voz {voice} no instalada (paquete core)"
        else:
            try:
                from .tts.providers import SynthesisParams  # noqa: PLC0415

                provider = services.tts_providers()["piper"]
                t0 = time.perf_counter()
                provider.synthesize(PIPER_TEXT, voice, SynthesisParams(), work / "piper.wav")
                result["piper_s_per_100chars"] = round(time.perf_counter() - t0, 3)
            except Exception as exc:
                errors["piper"] = str(exc)

        # ------------------------------------------------------------------ rvc (10 s)
        notify(0.7, "RVC")
        from .rvc_engine import ConvertParams, discover_models  # noqa: PLC0415

        voices = discover_models(root)
        if not module_present("infer_rvc_python"):
            skipped["rvc"] = "falta el paquete Python infer-rvc-python"
        elif not is_installed("rvc-base", root):
            skipped["rvc"] = "paquete rvc-base no instalado"
        elif not voices:
            skipped["rvc"] = "no hay modelos de voz RVC en models/rvc/<nombre>/"
        else:
            try:
                engine = services.rvc_engine()
                device, warns = engine.acquire_device(None)
                result["warnings"] += warns
                clip = make_speech(work / "speech10.wav", 10)
                t0 = time.perf_counter()
                try:
                    engine.convert(voices[0], clip, work / "rvc.wav", ConvertParams(), device)
                except Exception:
                    if device != "cuda":
                        raise
                    result["warnings"] += engine.cuda_failed()
                    device = "cpu"
                    t0 = time.perf_counter()
                    engine.convert(voices[0], clip, work / "rvc.wav", ConvertParams(), device)
                result["rvc_s_per_min"] = round((time.perf_counter() - t0) * 6, 2)
                result["rvc_device"] = device
            except Exception as exc:
                errors["rvc"] = str(exc)

        # ------------------------------------------------------------------ scenes
        notify(0.85, "Escenas")
        if not is_installed("scenes", root):
            skipped["scenes"] = "paquete scenes no instalado"
        else:
            try:
                from .analyze import detect_scenes  # noqa: PLC0415

                video = make_scenes_video(work / "scenes.mp4")
                t0 = time.perf_counter()
                res = detect_scenes(video)
                elapsed = time.perf_counter() - t0
                result["scenes_fps"] = round(res["frames"] / elapsed, 1) if elapsed else None
            except Exception as exc:
                errors["scenes"] = str(exc)

        # ------------------------------------------------------------------ vision (sprint 2)
        notify(0.9, "Vision (RVM, SAM 2, YuNet)")
        try:
            from .vision.bench import run_vision_bench  # noqa: PLC0415

            run_vision_bench(settings, work, result)
        except Exception as exc:
            errors["vision"] = str(exc)

        # ------------------------------------------------------------------ sprint 4 tools
        notify(0.93, "Chatterbox")
        try:
            bench_chatterbox(settings, work, result)
        except Exception as exc:
            errors["chatterbox"] = str(exc)
        notify(0.96, "Cambio de cara (FaceFusion)")
        try:
            bench_facefusion(settings, work, result, face_source_path, licences, face_consent_id)
        except Exception as exc:
            errors["facefusion"] = str(exc)
        result["tools"] = tool_states()
    finally:
        shutil.rmtree(work, ignore_errors=True)

    result["warnings"] = list(dict.fromkeys(result["warnings"]))
    status = budget.status()
    result["gpu_status"] = status
    result["gpu"] = status["gpu_name"] if status["mode"] == "gpu" and status["gpu_name"] else "cpu"
    if result["cpu_fallback_ok"] is None:
        # Whisper CPU path not measured: CPU-only components that ran prove the CPU path works.
        result["cpu_fallback_ok"] = bool(
            result["piper_s_per_100chars"] is not None
            or result["scenes_fps"] is not None
            or result["yunet_fps"] is not None
        )
    result["ran_at"] = datetime.now(UTC).replace(microsecond=0).isoformat()
    out = perf_path(settings)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", "utf-8")
    notify(1.0, "Listo")
    return result


# ===================================================================== sprint 4 (M3): tools
# Chatterbox: fixed 150-character Spanish sentence, no voice clone (rtf = generation time / audio
# duration; < 1 = faster than real time). FaceFusion: 3 s at 1080p built from the photo of the
# first Person with a valid face consent, swapped with that same face, without and with GFPGAN.
# Both only with their pack + a ready venv; FaceFusion also only with the licence accepted (the
# mirror) — a face-swap model never runs without it. Missing -> null + skipped[comp] in Spanish.

CHATTERBOX_TEXT = (
    "Che, esta es una prueba de rendimiento de la voz avanzada de Studio: medimos cuánto tarda "
    "en leer una frase en español rioplatense."
)[:150].ljust(150, ".")
CHATTERBOX_PACK = "tts-chatterbox"
FACEFUSION_PACK = "faceswap"
FACEFUSION_MODEL = "hyperswap_1a_256"
CHATTERBOX_VRAM_MB = 4500  # FEATURE_VRAM_MB.chatterbox (shared/ai.ts)
FACEFUSION_VRAM_MB = 3500  # FEATURE_VRAM_MB.faceswap
FF_BENCH_SECONDS = 3
FF_BENCH_FPS = 25
CHATTERBOX_READY_TIMEOUT = 180.0
CHATTERBOX_SYNTH_TIMEOUT = 600.0
FACEFUSION_RUN_TIMEOUT = 1800.0
# e2e (workers-with-mocks.py): ["--mock"] when the Chatterbox mock is on.
CHATTERBOX_EXTRA_ARGS: list[str] = []
# Measure through the workers' own engines (M2 ChatterboxClient, M1 FaceEngine) when they exist;
# False = talk to the tools directly (fallback, tests).
USE_WORKER_ENGINES = True


def tool_states() -> dict[str, Any]:
    """{facefusion|chatterbox: {state, version, variant, providers}} for perf.json / the web."""
    from . import toolvenv  # noqa: PLC0415

    out: dict[str, Any] = {}
    for tool in toolvenv.TOOL_IDS:
        try:
            st = toolvenv.status(tool)
        except Exception as exc:  # a broken recipe must not break the whole test
            out[tool] = {"state": "broken", "error": str(exc)}
            continue
        out[tool] = {
            k: st.get(k)
            for k in ("state", "version", "variant", "providers", "profile")
            if st.get(k) is not None
        }
    return out


def _pack_installed(pack_id: str, root: Path) -> bool:
    from .packs import PACKS  # noqa: PLC0415

    return pack_id in PACKS and is_installed(pack_id, root)


def _tool_not_ready(tool: str) -> str | None:
    from . import toolvenv  # noqa: PLC0415

    st = toolvenv.status(tool)  # type: ignore[arg-type]
    if st["state"] == "ready":
        return None
    name = toolvenv.spec_of(tool).name_es
    return f"entorno aislado de {name}: {toolvenv.STATE_ES.get(st['state'], st['state'])}"


class _Lines:
    """Background reader of a pipe into a queue (readline with a timeout)."""

    def __init__(self, stream: Any) -> None:
        import queue  # noqa: PLC0415
        import threading  # noqa: PLC0415

        self.q: queue.Queue[str | None] = queue.Queue()
        self.tail: list[str] = []

        def pump() -> None:
            for line in stream:
                self.q.put(line)
            self.q.put(None)

        threading.Thread(target=pump, daemon=True).start()

    def next_event(self, timeout: float) -> dict[str, Any] | None:
        import queue  # noqa: PLC0415

        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("la herramienta no respondió a tiempo")
            try:
                line = self.q.get(timeout=left)
            except queue.Empty:
                continue
            if line is None:
                return None
            text = line.strip()
            self.tail = [*self.tail[-19:], text]
            if text.startswith("{"):
                try:
                    event = json.loads(text)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    return event


def bench_chatterbox(settings: Settings, work: Path, result: dict[str, Any]) -> None:
    from . import toolvenv  # noqa: PLC0415

    skipped: dict[str, str] = result["skipped"]
    if not _pack_installed(CHATTERBOX_PACK, settings.models_root):
        skipped["chatterbox"] = f"paquete {CHATTERBOX_PACK} no instalado"
        return
    reason = _tool_not_ready("chatterbox")
    if reason:
        skipped["chatterbox"] = reason
        return
    out = work / "chatterbox.wav"
    client_factory = getattr(services, "chatterbox_client", None) if USE_WORKER_ENGINES else None
    if client_factory is not None:
        # The workers' own ChatterboxClient (M2): one model on the GPU, never a second bridge next
        # to a resident one. Stopped first so the cold start (chatterbox_load_s) is measured.
        client = client_factory()
        client.stop()
        services.gpu_budget().release("chatterbox")
        res = client.synthesize(job_id="perf-chatterbox", text=CHATTERBOX_TEXT, out=out)
        result["chatterbox_rtf"] = round(float(res.rtf), 3) if res.rtf is not None else None
        result["chatterbox_load_s"] = (
            round(float(res.load_s), 2) if res.load_s is not None else None
        )
        result["chatterbox_device"] = str(res.device)
        result["chatterbox_model"] = str(res.model)
        result["warnings"] += list(res.warnings or [])
        return
    st = toolvenv.status("chatterbox")
    variant = st.get("variant") or "v3"
    budget = services.gpu_budget()
    holder: dict[str, Any] = {}

    def unload() -> None:
        proc = holder.get("proc")
        if proc is not None and proc.poll() is None:
            toolvenv.kill_tree(proc)

    decision = budget.acquire("chatterbox", CHATTERBOX_VRAM_MB, unload)
    result["warnings"] += decision.warnings
    args = ["--models-dir", str(settings.models_root / "chatterbox"), "--device",
            decision.device, "--t3", str(variant), *CHATTERBOX_EXTRA_ARGS]  # fmt: skip
    t_spawn = time.perf_counter()
    proc = toolvenv.spawn("chatterbox", "studio_tts_server.py", args, stdin=subprocess.PIPE,
                          stderr=subprocess.DEVNULL)  # fmt: skip
    holder["proc"] = proc
    try:
        assert proc.stdout is not None and proc.stdin is not None
        lines = _Lines(proc.stdout)
        ready = lines.next_event(CHATTERBOX_READY_TIMEOUT)
        if not ready or ready.get("event") != "ready":
            raise RuntimeError(_event_error(ready, lines, "Chatterbox no arrancó"))
        result["chatterbox_load_s"] = round(
            float(ready.get("load_s") or (time.perf_counter() - t_spawn)), 2
        )
        result["chatterbox_device"] = str(ready.get("device") or decision.device)
        result["chatterbox_model"] = str(ready.get("model") or f"mtl-{variant}")
        request = {"id": "perf", "op": "synthesize", "text": CHATTERBOX_TEXT, "language": "es",
                   "ref": None, "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8, "seed": 0,
                   "out": str(out)}  # fmt: skip
        t0 = time.perf_counter()
        proc.stdin.write(json.dumps(request, ensure_ascii=True) + "\n")
        proc.stdin.flush()
        while True:
            event = lines.next_event(CHATTERBOX_SYNTH_TIMEOUT)
            if event is None or event.get("event") == "error":
                raise RuntimeError(_event_error(event, lines, "Chatterbox falló"))
            if event.get("event") == "done":
                break
        elapsed = time.perf_counter() - t0
        duration = float(event.get("duration_s") or 0)
        rtf = event.get("rtf")
        rtf = float(rtf) if rtf is not None else (elapsed / duration if duration else None)
        result["chatterbox_rtf"] = round(rtf, 3) if rtf is not None else None
        if result["chatterbox_device"] == "cpu" and settings.use_cuda:
            result["warnings"].append("chatterbox_cpu_slow")
        with contextlib.suppress(OSError, ValueError):
            proc.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
            proc.stdin.flush()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=15)
    finally:
        if proc.poll() is None:
            toolvenv.kill_tree(proc)
        budget.release("chatterbox")


def _event_error(event: dict[str, Any] | None, lines: _Lines, what: str) -> str:
    if event and event.get("message"):
        return f"{what}: {event.get('code') or ''} {event['message']}".strip()
    tail = " | ".join(t for t in lines.tail[-5:] if t)
    return f"{what}{': ' + tail if tail else ''}"


def facefusion_args(
    sources: list[Path], target: Path, output: Path, temp: Path, device: str, *, enhancer: bool
) -> list[str]:
    """headless-run argv of FaceFusion 3.9.1 (sprint4-contratos.md M1, verified flags)."""
    processors = ["face_swapper", "face_enhancer"] if enhancer else ["face_swapper"]
    return [
        "headless-run",
        "--source-paths", *[str(s) for s in sources],
        "--target-path", str(target),
        "--output-path", str(output),
        "--processors", *processors,
        "--face-swapper-model", FACEFUSION_MODEL,
        "--face-enhancer-model", "gfpgan_1.4",
        "--face-enhancer-blend", "80",
        "--face-selector-mode", "one",
        "--face-selector-order", "left-right",
        "--face-detector-model", "yolo_face",
        "--face-mask-types", "box", "occlusion",
        "--execution-providers", device,
        "--execution-device-ids", "0",
        "--execution-thread-count", "4",
        "--video-memory-strategy", "moderate",
        "--output-video-encoder", "libx264",
        "--output-video-quality", "80",
        "--output-audio-encoder", "aac",
        "--temp-path", str(temp),
        "--jobs-path", str(temp / "jobs"),
        "--download-providers", "github",
        "--log-level", "info",
    ]  # fmt: skip


def _run_facefusion(args: list[str], holder: dict[str, Any]) -> tuple[float, list[str]]:
    from . import toolvenv  # noqa: PLC0415

    t0 = time.perf_counter()
    proc = toolvenv.spawn("facefusion", "facefusion.py", args, stderr=subprocess.STDOUT)
    holder["proc"] = proc
    tail: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            tail = [*tail[-39:], line.rstrip()]
        code = proc.wait(timeout=FACEFUSION_RUN_TIMEOUT)
    finally:
        if proc.poll() is None:
            toolvenv.kill_tree(proc)
        holder.pop("proc", None)
    if code != 0:
        useful = [t for t in tail if t.strip()][-1:] or [f"código {code}"]
        raise RuntimeError(f"FaceFusion terminó con error: {useful[0]}")
    return time.perf_counter() - t0, tail


def bench_facefusion(
    settings: Settings,
    work: Path,
    result: dict[str, Any],
    face_source_path: str | None,
    licences: list[str] | None,
    consent_id: str | None = None,
) -> None:
    from . import toolvenv  # noqa: PLC0415

    skipped: dict[str, str] = result["skipped"]
    if not _pack_installed(FACEFUSION_PACK, settings.models_root):
        skipped["facefusion"] = f"paquete {FACEFUSION_PACK} no instalado"
        return
    accepted = toolvenv.licence_accepted("faceswap")
    if not accepted or (licences is not None and "faceswap" not in licences):
        skipped["facefusion"] = "licencia no aceptada"
        return
    if not face_source_path:
        skipped["facefusion"] = "registrá una Persona con consentimiento para medir"
        return
    reason = _tool_not_ready("facefusion")
    if reason:
        skipped["facefusion"] = reason
        return
    photo = settings.storage_path(face_source_path)
    if not photo.is_file():
        skipped["facefusion"] = "registrá una Persona con consentimiento para medir"
        return
    ff = work / "facefusion"
    ff.mkdir(parents=True, exist_ok=True)
    frame = ff / "frame.png"
    video = ff / "bench1080.mp4"
    fit = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"
    run_ffmpeg(["-i", str(photo), "-vf", f"{fit},format=rgb24", "-frames:v", "1", str(frame)])
    run_ffmpeg(["-loop", "1", "-i", str(frame), "-t", str(FF_BENCH_SECONDS), "-r",
                str(FF_BENCH_FPS), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
                "yuv420p", str(video)])  # fmt: skip
    frames = FF_BENCH_SECONDS * FF_BENCH_FPS
    engine_factory = getattr(services, "face_engine", None) if USE_WORKER_ENGINES else None
    if engine_factory is not None:
        _bench_with_face_engine(settings, engine_factory(), photo, video, result, consent_id)
        return
    budget = services.gpu_budget()
    holder: dict[str, Any] = {}

    def unload() -> None:
        proc = holder.get("proc")
        if proc is not None and proc.poll() is None:
            toolvenv.kill_tree(proc)

    decision = budget.acquire("facefusion", FACEFUSION_VRAM_MB, unload)
    result["warnings"] += decision.warnings
    device = decision.device
    result["facefusion_device"] = device
    result["facefusion_model"] = FACEFUSION_MODEL
    temp = ff / "tmp"
    try:
        # 1 frame: interpreter + model loading ≈ the fixed cost of every swap
        startup: float | None = None
        try:
            startup, _ = _run_facefusion(
                facefusion_args([photo], frame, ff / "one.png", temp, device, enhancer=False),
                holder,
            )
            result["facefusion_startup_s"] = round(startup, 2)
        except Exception as exc:
            result["errors"]["facefusion_startup"] = str(exc)
        for key, enhancer in (("facefusion_fps", False), ("facefusion_enh_fps", True)):
            out = ff / f"swap-{'enh' if enhancer else 'plain'}.mp4"
            elapsed, _ = _run_facefusion(
                facefusion_args([photo], video, out, temp, device, enhancer=enhancer), holder
            )
            proc_s = elapsed - (startup or 0.0)
            if proc_s <= 0.05:
                proc_s = elapsed
            result[key] = round(frames / proc_s, 2)
    finally:
        budget.release("facefusion")


def _bench_with_face_engine(
    settings: Settings,
    engine: Any,
    photo: Path,
    video: Path,
    result: dict[str, Any],
    consent_id: str | None,
) -> None:
    """Through the workers' own FaceEngine (M1): same argv, model checks, GPU budget and finalize
    as a real face.swap job. fps = frames / (FaceFusion seconds - its startup)."""
    from .face.schemas import FaceSelector, FaceSwapWorkerRequest  # noqa: PLC0415 - M1

    stamp = int(time.time())
    out_root = settings.storage_root / "renders" / "perf"
    try:
        for key, enhancer in (("facefusion_fps", False), ("facefusion_enh_fps", True)):
            name = f"{stamp}-{'enh' if enhancer else 'plain'}"
            req = FaceSwapWorkerRequest(
                source_paths=[str(photo)],
                target_path=str(video),
                output_base=f"renders/perf/{name}",
                selector=FaceSelector(mode="one"),
                model=FACEFUSION_MODEL,
                enhancer=enhancer,
                consent_id=consent_id or "perf-bench",
                licence_ids=["faceswap"],
            )
            res = engine.run(req, f"perf-ff-{name}")
            timings = res.get("timings") or {}
            ff_s = float(timings.get("facefusion_s") or 0.0)
            startup = timings.get("startup_s")
            frames = int(res.get("frames") or FF_BENCH_SECONDS * FF_BENCH_FPS)
            if startup is not None and ff_s - float(startup) > 0.05:
                fps = frames / (ff_s - float(startup))
            else:
                fps = float(res.get("proc_fps") or 0.0)
            result[key] = round(fps, 2) if fps > 0 else None
            if not enhancer and startup is not None:
                result["facefusion_startup_s"] = round(float(startup), 2)
            result["facefusion_device"] = str(res.get("device") or "cpu")
            result["facefusion_model"] = str(res.get("model") or FACEFUSION_MODEL)
            result["warnings"] += list(res.get("warnings") or [])
    finally:
        for sub in out_root.glob(f"{stamp}-*"):
            shutil.rmtree(sub, ignore_errors=True)
