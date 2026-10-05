"""AI performance test ("Test de rendimiento IA"): measures this PC -> storage/run/perf.json.

Components whose pack (or Python package) is missing are skipped and listed in ``skipped`` with
the reason, so the UI can show "descargá el paquete X para medirlo".
"""

from __future__ import annotations

import json
import logging
import shutil
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


def run_perf(settings: Settings, step: Step | None = None) -> dict[str, Any]:
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
                engine.convert(voices[0], clip, work / "rvc.wav", ConvertParams(), device)
                result["rvc_s_per_min"] = round((time.perf_counter() - t0) * 6, 2)
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
    finally:
        shutil.rmtree(work, ignore_errors=True)

    result["warnings"] = list(dict.fromkeys(result["warnings"]))
    status = budget.status()
    result["gpu_status"] = status
    result["gpu"] = status["gpu_name"] if status["mode"] == "gpu" and status["gpu_name"] else "cpu"
    if result["cpu_fallback_ok"] is None:
        # Whisper CPU path not measured: CPU-only components that ran prove the CPU path works.
        result["cpu_fallback_ok"] = bool(
            result["piper_s_per_100chars"] is not None or result["scenes_fps"] is not None
        )
    result["ran_at"] = datetime.now(UTC).replace(microsecond=0).isoformat()
    out = perf_path(settings)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", "utf-8")
    notify(1.0, "Listo")
    return result
