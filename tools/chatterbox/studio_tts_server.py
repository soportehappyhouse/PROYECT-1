"""Studio bridge to Chatterbox Multilingual TTS (runs inside tools/chatterbox/.venv).

Started by the workers (studio_workers/tts/chatterbox.py) through tools/launch.py as a persistent
subprocess; it loads the model ONCE and answers JSON lines:

    stdin : {"id": "<job>", "op": "synthesize", "text": "...", "language": "es",
             "ref": "C:\\...\\ref.wav" | null, "exaggeration": 0.5, "cfg": 0.5,
             "temperature": 0.8, "seed": 0, "out": "C:\\...\\renders\\<job>.wav"}
            {"op": "ping"} | {"op": "shutdown"}
    stdout: {"event": "ready", "device": "cuda", "load_s": 14.2, "model": "mtl-v3", ...}
            {"event": "progress", "id": "...", "chunk": 2, "chunks": 5}
            {"event": "done", "id": "...", "out": "...", "duration_s": 12.4,
             "sample_rate": 24000, "rtf": 0.62, "chunks": 5}
            {"event": "error", "id": "...", "code": "MODEL_MISSING|REF_INVALID|CUDA_OOM|
             WATERMARK_MISSING|INTERNAL", "message": "..."}

stdout carries ONLY protocol events: file descriptor 1 is moved to stderr before anything else is
imported, so prints of torch/transformers/tqdm end up in the workers' log tail. Paths arrive
absolute, already resolved inside STORAGE_DIR by the workers. The text is split into chunks of at
most 300 characters on sentence boundaries (Chatterbox generates ≤ ~40 s per call) and joined
with 120 ms of silence. The PerTh watermark is applied by the library on every `generate` call
(it cannot be disabled and this script never tries to).

``--mock`` (tests / e2e, no torch): a 220 Hz tone (330 Hz with a reference) of 0.06 s per character.
Runs with HF_HUB_OFFLINE=1 and without HF_TOKEN (the launcher sets that; repeated here).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any

SAMPLE_RATE = 24_000
MAX_CHUNK_CHARS = 300
GAP_S = 0.12
MOCK_SEC_PER_CHAR = 0.06
MODEL_FILES = (
    "ve.pt",
    "s3gen.pt",
    "grapheme_mtl_merged_expanded_v1.json",
    "conds.pt",
    "Cangjie5_TC.json",
)
T3_FILES = {"v3": "t3_mtl23ls_v3.safetensors", "v2": "t3_mtl23ls_v2.safetensors"}
LANGUAGES = frozenset(
    ("ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja")
    + ("ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh")
)

_PROTO = sys.stdout  # replaced by _isolate_stdout() when run as a script


def _isolate_stdout() -> None:
    """Keep the real stdout for protocol events; everything else (fd 1 included) -> stderr."""
    global _PROTO
    try:
        sys.stdout.flush()
        proto_fd = os.dup(1)
        os.dup2(2, 1)
        _PROTO = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1, newline="\n")
    except OSError:  # no real fds (embedded): keep sys.stdout, still route prints to stderr
        _PROTO = sys.stdout
    sys.stdout = sys.stderr


def emit(event: dict[str, Any]) -> None:
    # ASCII-only JSON: the protocol survives any console code page on Windows.
    _PROTO.write(json.dumps(event, ensure_ascii=True) + "\n")
    _PROTO.flush()


def log(message: str) -> None:
    print(f"[chatterbox] {message}", file=sys.stderr, flush=True)


# ------------------------------------------------------------------------------- text chunking

_SENTENCE = re.compile(r"[^.!?…\n]+(?:[.!?…]+[\"'»”)\]]*|\n+|$)")
_SOFT = re.compile(r"[^,;:]+(?:[,;:]+|$)")


def _hard_split(text: str, limit: int) -> list[str]:
    out: list[str] = []
    words = text.split()
    cur = ""
    for word in words:
        while len(word) > limit:  # a single "word" longer than the limit (URLs...)
            if cur:
                out.append(cur)
                cur = ""
            out.append(word[:limit])
            word = word[limit:]
        cand = f"{cur} {word}" if cur else word
        if len(cand) <= limit:
            cur = cand
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def _pieces(sentence: str, limit: int) -> list[str]:
    if len(sentence) <= limit:
        return [sentence]
    parts: list[str] = []
    for soft in (m.group(0).strip() for m in _SOFT.finditer(sentence)):
        if not soft:
            continue
        parts.extend([soft] if len(soft) <= limit else _hard_split(soft, limit))
    return parts


def split_text(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Chunks of at most `limit` characters, cut at sentence ends (then commas, then spaces);
    consecutive short sentences are packed together. Whitespace is normalized."""
    clean = re.sub(r"[ \t\r\f\v]+", " ", text).strip()
    sentences = [m.group(0).strip() for m in _SENTENCE.finditer(clean)]
    pieces: list[str] = []
    for sentence in sentences:
        if sentence:
            pieces.extend(_pieces(sentence.replace("\n", " ").strip(), limit))
    chunks: list[str] = []
    cur = ""
    for piece in pieces:
        cand = f"{cur} {piece}" if cur else piece
        if len(cand) <= limit:
            cur = cand
        else:
            chunks.append(cur)
            cur = piece
    if cur:
        chunks.append(cur)
    return [c for c in chunks if c.strip()]


# ------------------------------------------------------------------------------------ engines


class ToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class MockEngine:
    """No torch: deterministic tone, 0.06 s per character (220 Hz, 330 Hz with a reference)."""

    def __init__(self, t3: str, device: str) -> None:
        self.model = f"mtl-{t3}"
        self.device = device
        self.warnings: list[str] = []

    def load(self) -> None:
        delay = float(os.environ.get("STUDIO_CHATTERBOX_MOCK_LOAD_S", "0") or 0)
        if delay > 0:
            time.sleep(delay)

    def generate(self, text: str, opts: dict[str, Any]) -> list[float]:
        freq = 330.0 if opts.get("ref") else 220.0
        n = max(1, int(round(len(text) * MOCK_SEC_PER_CHAR * SAMPLE_RATE)))
        step = 2 * math.pi * freq / SAMPLE_RATE
        return [0.3 * math.sin(step * i) for i in range(n)]


class ChatterboxEngine:
    """ChatterboxMultilingualTTS.from_local(models_dir, device, t3_model=...) (V3 git) or without
    t3_model (V2, PyPI 0.1.7)."""

    def __init__(self, models_dir: Path, t3: str, device: str) -> None:
        self.models_dir = models_dir
        self.t3 = t3
        self.model = f"mtl-{t3}"
        self.device = device
        self.warnings: list[str] = []
        self._tts: Any = None
        self._default_conds: Any = None
        self._torch: Any = None

    def _pick_device(self, torch: Any) -> str:
        if self.device != "cuda":
            return "cpu"
        try:
            if not torch.cuda.is_available():
                self.warnings.append("gpu_fallback_cpu")
                return "cpu"
            major, minor = torch.cuda.get_device_capability(0)
            if f"sm_{major}{minor}" not in set(torch.cuda.get_arch_list()):
                # e.g. RTX 50xx (sm_120) with torch 2.6.0: no kernels for the architecture.
                log(f"torch {torch.__version__} has no kernels for sm_{major}{minor}: CPU")
                self.warnings.append("gpu_arch_unsupported")
                return "cpu"
        except Exception as exc:  # broken driver: CPU
            log(f"CUDA probe failed: {exc}")
            self.warnings.append("gpu_fallback_cpu")
            return "cpu"
        return "cuda"

    def load(self) -> None:
        missing = [
            name
            for name in (*MODEL_FILES, T3_FILES[self.t3])
            if not (self.models_dir / name).is_file()
        ]
        if missing:
            raise ToolError("MODEL_MISSING", "Faltan archivos del modelo: " + ", ".join(missing))
        import torch  # noqa: PLC0415 - heavy, only in the tool venv

        try:
            import perth  # noqa: PLC0415
        except ImportError as exc:
            raise ToolError("WATERMARK_MISSING", f"No se pudo importar PerTh: {exc}") from exc
        if getattr(perth, "PerthImplicitWatermarker", None) is None:
            raise ToolError(
                "WATERMARK_MISSING",
                "PerTh (marca de agua) no cargó: el entorno aislado está roto (setuptools<82)",
            )
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: PLC0415

        self._torch = torch
        self.device = self._pick_device(torch)
        import inspect  # noqa: PLC0415

        kwargs: dict[str, Any] = {}
        params = inspect.signature(ChatterboxMultilingualTTS.from_local).parameters
        if "t3_model" in params:
            kwargs["t3_model"] = self.t3
        elif self.t3 != "v2":
            raise ToolError(
                "MODEL_MISSING",
                "La versión instalada de Chatterbox solo carga Multilingual V2 (respaldo de PyPI)",
            )
        try:
            self._tts = ChatterboxMultilingualTTS.from_local(
                str(self.models_dir), self.device, **kwargs
            )
        except Exception as exc:
            if _is_oom(exc):
                raise ToolError("CUDA_OOM", f"Sin memoria de GPU al cargar: {exc}") from exc
            raise
        self._default_conds = getattr(self._tts, "conds", None)

    def generate(self, text: str, opts: dict[str, Any]) -> Any:
        torch = self._torch
        tts = self._tts
        common = {
            "language_id": opts["language"],
            "exaggeration": opts["exaggeration"],
            "cfg_weight": opts["cfg"],
            "temperature": opts["temperature"],
        }
        try:
            with torch.inference_mode():
                if opts.get("ref") and not hasattr(tts, "prepare_conditionals"):
                    wav = tts.generate(text, audio_prompt_path=opts["ref"], **common)
                else:
                    wav = tts.generate(text, **common)
        except Exception as exc:
            if _is_oom(exc):
                torch.cuda.empty_cache()
                raise ToolError("CUDA_OOM", f"Sin memoria de GPU: {exc}") from exc
            raise
        return wav.squeeze().detach().cpu().float().numpy()

    def prepare(self, opts: dict[str, Any]) -> None:
        """Speaker conditionals once per request (not once per chunk)."""
        tts = self._tts
        if opts.get("seed") is not None:
            self._torch.manual_seed(int(opts["seed"]))
        if opts.get("ref"):
            if hasattr(tts, "prepare_conditionals"):
                try:
                    tts.prepare_conditionals(opts["ref"], exaggeration=opts["exaggeration"])
                except Exception as exc:
                    raise ToolError("REF_INVALID", f"No se pudo leer la referencia: {exc}") from exc
        elif self._default_conds is not None:
            tts.conds = self._default_conds


def _is_oom(exc: BaseException) -> bool:
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


# ------------------------------------------------------------------------------------ requests


def _to_pcm16(samples: Any) -> bytes:
    try:
        import numpy as np  # noqa: PLC0415

        arr = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
        return (arr * 32767.0).astype("<i2").tobytes()
    except ImportError:  # mock without numpy
        from array import array  # noqa: PLC0415

        out = array("h", (int(max(-1.0, min(1.0, s)) * 32767.0) for s in samples))
        if sys.byteorder != "little":
            out.byteswap()
        return out.tobytes()


def _options(msg: dict[str, Any]) -> dict[str, Any]:
    language = str(msg.get("language") or "es")
    if language not in LANGUAGES:
        raise ToolError("INTERNAL", f"Idioma no soportado: {language}")
    ref = msg.get("ref") or None
    if ref is not None and not Path(ref).is_file():
        raise ToolError("REF_INVALID", "No existe la muestra de voz de referencia")
    out = msg.get("out")
    if not out or not Path(out).is_absolute():
        raise ToolError("INTERNAL", "Falta la ruta de salida absoluta (out)")
    return {
        "language": language,
        "ref": ref,
        "exaggeration": float(msg.get("exaggeration", 0.5)),
        "cfg": float(msg.get("cfg", 0.5)),
        "temperature": float(msg.get("temperature", 0.8)),
        "seed": msg.get("seed"),
        "out": Path(out),
    }


def synthesize(engine: Any, msg: dict[str, Any]) -> dict[str, Any]:
    job = str(msg.get("id") or "")
    text = str(msg.get("text") or "").strip()
    if not text:
        raise ToolError("INTERNAL", "Texto vacío")
    opts = _options(msg)
    chunks = split_text(text)
    t0 = time.perf_counter()
    if hasattr(engine, "prepare"):
        engine.prepare(opts)
    gap = b"\x00\x00" * int(SAMPLE_RATE * GAP_S)
    out: Path = opts["out"]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    frames = 0
    emit({"event": "progress", "id": job, "chunk": 0, "chunks": len(chunks)})
    with wave.open(str(tmp), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        for i, chunk in enumerate(chunks):
            pcm = _to_pcm16(engine.generate(chunk, opts))
            if i:
                wav.writeframes(gap)
                frames += len(gap) // 2
            wav.writeframes(pcm)
            frames += len(pcm) // 2
            emit({"event": "progress", "id": job, "chunk": i + 1, "chunks": len(chunks)})
    os.replace(tmp, out)
    duration = frames / SAMPLE_RATE
    elapsed = time.perf_counter() - t0
    return {
        "event": "done",
        "id": job,
        "out": str(out),
        "duration_s": round(duration, 3),
        "sample_rate": SAMPLE_RATE,
        "rtf": round(elapsed / duration, 3) if duration > 0 else None,
        "chunks": len(chunks),
        "seconds": round(elapsed, 3),
    }


def serve(engine: Any, stdin: Any = None) -> int:
    for raw in stdin or sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                raise ValueError("not an object")
        except ValueError as exc:
            emit({"event": "error", "id": None, "code": "INTERNAL", "message": f"JSON: {exc}"})
            continue
        op = msg.get("op")
        if op == "shutdown":
            emit({"event": "bye"})
            return 0
        if op == "ping":
            emit({"event": "pong", "device": engine.device, "model": engine.model})
            continue
        if op != "synthesize":
            emit({"event": "error", "id": msg.get("id"), "code": "INTERNAL", "message": f"op {op}"})
            continue
        try:
            emit(synthesize(engine, msg))
        except ToolError as exc:
            emit({"event": "error", "id": msg.get("id"), "code": exc.code, "message": str(exc)})
        except Exception as exc:  # keep serving: one bad request must not kill the model
            log(f"synthesize failed: {type(exc).__name__}: {exc}")
            emit(
                {
                    "event": "error",
                    "id": msg.get("id"),
                    "code": "CUDA_OOM" if _is_oom(exc) else "INTERNAL",
                    "message": f"{type(exc).__name__}: {exc}"[:500],
                }
            )
    return 0  # stdin closed: the workers went away


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cpu")
    parser.add_argument("--t3", choices=("v3", "v2"), default="v3")
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args(argv)
    os.environ.pop("HF_TOKEN", None)
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    _isolate_stdout()
    t0 = time.perf_counter()
    engine: Any = (
        MockEngine(args.t3, args.device)
        if args.mock
        else ChatterboxEngine(Path(args.models_dir), args.t3, args.device)
    )
    try:
        engine.load()
    except ToolError as exc:
        emit({"event": "error", "id": None, "code": exc.code, "message": str(exc)})
        return 3
    except Exception as exc:
        log(f"load failed: {type(exc).__name__}: {exc}")
        emit(
            {
                "event": "error",
                "id": None,
                "code": "CUDA_OOM" if _is_oom(exc) else "INTERNAL",
                "message": f"{type(exc).__name__}: {exc}"[:500],
            }
        )
        return 3
    load_s = round(time.perf_counter() - t0, 3)
    log(f"ready: {engine.model} on {engine.device} in {load_s} s (mock={args.mock})")
    emit(
        {
            "event": "ready",
            "device": engine.device,
            "load_s": load_s,
            "model": engine.model,
            "sample_rate": SAMPLE_RATE,
            "warnings": engine.warnings,
            "mock": bool(args.mock),
        }
    )
    return serve(engine)


if __name__ == "__main__":
    sys.exit(main())
