"""RobustVideoMatting CLI (runs in .venv-gpl). SPDX-License-Identifier: GPL-3.0-or-later

    python -m vision_gpl.rvm --input IN --output OUT.webm [--downsample auto|0.25..1]
        [--chunk 300] [--device auto|cuda|cpu] [--model-dir DIR] [--work-dir DIR]
        [--ffmpeg PATH] [--mock-model]

Protocol: one JSON object per stdout line (stderr is free text, never parsed):
  {"event":"start","frames":N,"fps":"30/1","width":W,"height":H,"device":"cuda","downsample":0.25}
  {"event":"warning","code":"gpu_fallback_cpu","message":"..."}
  {"event":"chunk","index":k,"start":a,"end":b}
  {"event":"progress","frame":i,"frames":N,"progress":0.42,"fps":31.5}
  {"event":"done","output":"...","frames":N,"fps":"30/1","device":"cpu","proc_fps":31.2,
   "precision":"fp32","downsample":0.2667,"warnings":[...]}
  {"event":"error","message":"..."}
Exit code 0 = done, 1 = error.

Env ``STUDIO_VRAM_BUDGET_MB``: VRAM the workers' GPU budget left for this process (they unload
their resident model first). Below ``RVM_VRAM_MB`` (or no CUDA) -> CPU with gpu_fallback_cpu.
Processing goes in chunks of ``--chunk`` frames (one WebM segment each, joined at the end); the
recurrent state is carried across chunks. A CUDA error mid-run restarts the current chunk on CPU
(re-warming the state with the previous frames). Finished segments are kept in --work-dir, so a
re-run with the same input resumes from the last finished chunk.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

from . import ffio

RVM_VRAM_MB = 900  # mobilenetv3 fp16 at 1080p + cuDNN workspace [S, docs §10.1: 0.4-0.8 GB]
MODEL_FILES = {
    "cuda": "rvm_mobilenetv3_fp16.torchscript",
    "cpu": "rvm_mobilenetv3_fp32.torchscript",
}
WARMUP_FRAMES = 8
GPU_FALLBACK_CPU = "gpu_fallback_cpu"


def emit(**event: Any) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def auto_downsample(w: int, h: int) -> float:
    """RVM README: the downsampled frame should be ~256-512 px (1080p -> ~0.25)."""
    return round(max(0.125, min(1.0, 512 / max(w, h))), 4)


class MockModel:
    """--mock-model: constant alpha, foreground = source (tests and protocol checks)."""

    def __init__(self, alpha: int = 200) -> None:
        self.alpha = alpha

    def reset(self) -> None:
        return None

    def __call__(self, rgb: bytes, w: int, h: int, ratio: float) -> bytes:
        out = bytearray(w * h * 4)
        out[0::4] = rgb[0::3]
        out[1::4] = rgb[1::3]
        out[2::4] = rgb[2::3]
        out[3::4] = bytes([self.alpha]) * (w * h)
        return bytes(out)


class RvmModel:
    def __init__(self, model_dir: Path, device: str) -> None:
        import torch  # noqa: PLC0415 - only inside .venv-gpl

        self.torch = torch
        self.device = device
        path = model_dir / MODEL_FILES[device]
        if not path.is_file():
            raise RuntimeError(f"Falta el modelo RVM {path.name} (paquete matting)")
        self.model = torch.jit.load(str(path), map_location=device).eval()
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        if device == "cpu":
            torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
        self.rec: list[Any] = [None] * 4

    def reset(self) -> None:
        self.rec = [None] * 4

    def __call__(self, rgb: bytes, w: int, h: int, ratio: float) -> bytes:
        torch = self.torch
        with torch.inference_mode():
            src = torch.frombuffer(bytearray(rgb), dtype=torch.uint8).view(h, w, 3)
            x = src.to(self.device).permute(2, 0, 1).unsqueeze(0).to(self.dtype).div_(255)
            fgr, pha, *rec = self.model(x, *self.rec, ratio)
            self.rec = list(rec)
            out = torch.cat([fgr, pha], dim=1)[0].mul(255).round_().clamp_(0, 255)
            out = out.to(torch.uint8).permute(1, 2, 0).contiguous().cpu()
        return out.numpy().tobytes()


def cuda_available(mock: bool) -> bool:
    if mock:
        return os.environ.get("STUDIO_MOCK_CUDA") == "1"
    try:
        import torch  # noqa: PLC0415

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def choose_device(requested: str, mock: bool) -> tuple[str, list[str]]:
    if requested == "cpu":
        return "cpu", []
    budget_raw = os.environ.get("STUDIO_VRAM_BUDGET_MB", "").strip()
    budget = int(float(budget_raw)) if budget_raw else None
    if not cuda_available(mock):
        if requested == "cuda":
            emit(event="warning", code=GPU_FALLBACK_CPU, message="CUDA no disponible: CPU")
            return "cpu", [GPU_FALLBACK_CPU]
        return "cpu", []
    if budget is not None and budget < RVM_VRAM_MB:
        emit(
            event="warning",
            code=GPU_FALLBACK_CPU,
            message=f"VRAM libre {budget} MB < {RVM_VRAM_MB} MB: se procesa en CPU (lento)",
        )
        return "cpu", [GPU_FALLBACK_CPU]
    return "cuda", []


def _load(model_dir: Path, device: str, mock: bool) -> Any:
    return MockModel() if mock else RvmModel(model_dir, device)


def _resume_point(work: Path, meta: dict, chunk: int) -> int:
    meta_path = work / "meta.json"
    try:
        old = json.loads(meta_path.read_text("utf-8")) if meta_path.is_file() else None
    except (OSError, ValueError):
        old = None
    if old != meta:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(meta), "utf-8")
        return 0
    k = 0
    while (work / f"seg_{k:05d}.done").is_file():
        k += 1
    return k * chunk


def run(args: argparse.Namespace) -> dict[str, Any]:
    ffmpeg = ffio.find_tool("ffmpeg", args.ffmpeg)
    ffprobe = ffio.find_tool("ffprobe", args.ffmpeg)
    src = Path(args.input)
    out = Path(args.output)
    info = ffio.probe(ffprobe, src)
    w, h, fps, total = info["width"], info["height"], info["fps"], info["frames"]
    ratio = auto_downsample(w, h) if args.downsample in (None, "auto") else float(args.downsample)
    ratio = max(0.125, min(1.0, ratio))
    chunk = max(1, int(args.chunk))
    device, warnings = choose_device(args.device, args.mock_model)
    if device == "cpu" and not args.mock_model:
        warnings.append("cpu_slow")
    work = Path(args.work_dir) if args.work_dir else out.with_name(out.name + ".parts")
    work.mkdir(parents=True, exist_ok=True)
    st = src.stat()
    meta = {"input": str(src.resolve()), "size": st.st_size, "mtime": st.st_mtime_ns,
            "chunk": chunk, "w": w, "h": h, "ratio": ratio}  # fmt: skip
    start_at = _resume_point(work, meta, chunk)
    emit(event="start", frames=total, fps=f"{fps.numerator}/{fps.denominator}", width=w,
         height=h, device=device, downsample=ratio, resume_from=start_at)  # fmt: skip
    model = _load(Path(args.model_dir or "."), device, args.mock_model)
    t0 = time.perf_counter()
    processed = 0
    frames_out = 0
    while True:
        try:
            done, frames_out = _process(ffmpeg, src, w, h, fps, total, chunk, ratio, model,
                                        work, start_at, t0)  # fmt: skip
            processed += done
            break
        except RuntimeError as exc:
            if device != "cuda" or "CUDA" not in str(exc).upper():
                raise
            emit(event="warning", code=GPU_FALLBACK_CPU, message=f"Error CUDA ({exc}): CPU")
            warnings.append(GPU_FALLBACK_CPU)
            device = "cpu"
            model = _load(Path(args.model_dir or "."), device, args.mock_model)
            k = 0
            while (work / f"seg_{k:05d}.done").is_file():
                k += 1
            start_at = k * chunk
    segments = sorted(work.glob("seg_*.webm"))
    if not segments:
        raise RuntimeError("No se proceso ningun fotograma")
    ffio.concat(ffmpeg, segments, out)
    elapsed = max(1e-6, time.perf_counter() - t0)
    result = {
        "output": str(out),
        "frames": frames_out,
        "fps": f"{fps.numerator}/{fps.denominator}",
        "device": device,
        "proc_fps": round(processed / elapsed, 2),
        # model weights used (fp16 TorchScript on CUDA, fp32 on CPU) and RVM downsample_ratio
        "precision": "fp16" if device == "cuda" else "fp32",
        "downsample": ratio,
        "warnings": list(dict.fromkeys(warnings)),
    }
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return result


def _process(
    ffmpeg: str,
    src: Path,
    w: int,
    h: int,
    fps: Fraction,
    total: int,
    chunk: int,
    ratio: float,
    model: Any,
    work: Path,
    start_at: int,
    t0: float,
) -> tuple[int, int]:
    """Returns (frames processed now, frames in the output)."""
    model.reset()
    writer: ffio.Writer | None = None
    seg_index = -1
    idx = 0
    done = 0
    last_emit = 0.0
    try:
        for buf in ffio.read_frames(ffmpeg, src, w, h):
            if idx < start_at:
                if idx >= start_at - WARMUP_FRAMES:
                    model(buf, w, h, ratio)  # re-warm the recurrent state, output discarded
                idx += 1
                continue
            k = idx // chunk
            if k != seg_index:
                if writer is not None:
                    writer.close()
                    (work / f"seg_{seg_index:05d}.done").touch()
                seg_index = k
                writer = ffio.Writer(ffmpeg, work / f"seg_{k:05d}.webm", w, h, fps)
                emit(event="chunk", index=k, start=k * chunk,
                     end=min(total, (k + 1) * chunk) - 1)  # fmt: skip
            assert writer is not None
            writer.write(model(buf, w, h, ratio))
            idx += 1
            done += 1
            now = time.perf_counter()
            if now - last_emit > 0.5 or idx >= total:
                last_emit = now
                emit(event="progress", frame=idx, frames=total,
                     progress=round(min(1.0, idx / max(1, total)), 4),
                     fps=round(done / max(1e-6, now - t0), 2))  # fmt: skip
        if writer is not None:
            writer.close()
            (work / f"seg_{seg_index:05d}.done").touch()
            writer = None
    finally:
        if writer is not None and writer.proc.poll() is None:
            writer.proc.kill()
            writer.proc.wait()
    return done, idx


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m vision_gpl.rvm", description=__doc__)
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--downsample", default="auto")
    p.add_argument("--chunk", type=int, default=300)
    p.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    p.add_argument("--model-dir", default=None)
    p.add_argument("--work-dir", default=None)
    p.add_argument("--ffmpeg", default=None)
    p.add_argument("--keep-work", action="store_true")
    p.add_argument("--mock-model", action="store_true", help="alfa constante, sin torch")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        result = run(args)
    except Exception as exc:  # protocol: every failure is one JSON error line
        emit(event="error", message=str(exc) or exc.__class__.__name__)
        return 1
    emit(event="done", **result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
