"""RobustVideoMatting CLI (runs in .venv-gpl). SPDX-License-Identifier: GPL-3.0-or-later

    python -m vision_gpl.rvm --input IN --output OUT.webm [--downsample auto|0.25..1]
        [--chunk 300] [--device auto|cuda|cpu] [--model-dir DIR] [--work-dir DIR]
        [--ffmpeg PATH] [--alpha-codec vp9|split|auto] [--pix-fmt auto|yuva420p|rgba]
        [--seq-chunk 0|N] [--channels-last] [--cudnn-benchmark] [--fast-start] [--mock-model]
        [--quality fast|high] [--erode PX] [--feather SIGMA] [--despill on|off] [--temporal K]
        [--mask PNG|DIR] [--mask-dilate PX] [--mask-offset N] [--compare-out PNG]
        [--compare-frame N]

Protocol: one JSON object per stdout line (stderr is free text, never parsed):
  {"event":"start","frames":N,"fps":"30/1","width":W,"height":H,"device":"cuda","downsample":0.25,
   "alpha_codec":"vp9","pix_fmt":"yuva420p","seq_chunk":4,"load_s":2.1}
  {"event":"warning","code":"gpu_fallback_cpu","message":"..."}
  {"event":"chunk","index":k,"start":a,"end":b}
  {"event":"progress","frame":i,"frames":N,"progress":0.42,"fps":31.5,
   "stages":{"decode":4.1,"pre":0.9,"model":11.0,"post":1.2,"encode":21.0}}
  {"event":"done","output":"...","frames":N,"fps":"30/1","device":"cpu","proc_fps":31.2,
   "precision":"fp32","downsample":0.2667,"alpha_codec":"vp9","warnings":[...],
   "timings":{"ms_per_frame":{...},"stage_fps":{...},"wait_ms_per_frame":{...},
              "bottleneck":"encode","load_s":..,"first_batch_s":..,"process_s":..,"concat_s":..}}
  {"event":"error","message":"..."}
Exit code 0 = done, 1 = error. ``done`` also carries ``quality``, ``model`` (mobilenetv3 |
resnet50), and when the alpha is refined (vision_gpl/refine.py) ``refine`` (the parameters),
``halo`` ({before, after, frames}: no-reference edge halo score, lower = cleaner), ``compare_path``
(before | after PNG of one frame) and ``mask_frames`` (frames guided by the SAM mask).

Quality (``--quality``): ``fast`` = mobilenetv3 (downsample auto = 512 / long side), no refinement
by default; ``high`` = resnet50 (fp16 on CUDA, fp32 on CPU; downsample auto = 720 / long side, i.e.
0.375 at 1080p) + refinement defaults (erode 1, feather 0.7, despill, temporal 0.2). Every
refinement flag overrides the quality default (``--despill on`` also works in fast).

Pipeline (each stage overlaps the others): ffmpeg decode (own process, rgb24 over a pipe, prefetch
thread) -> pre (pinned host buffer -> GPU, fp16) -> model (``--seq-chunk`` frames per call: RVM
takes [B,T,C,H,W]) -> post (RGB->YUV 4:2:0 BT.601 + alpha on the GPU, one D2H copy of 2.5 B/px
instead of 4) -> encode (writer thread -> ffmpeg; ``yuva420p`` raw input, so ffmpeg does no colour
conversion). ``stages`` / ``timings`` = busy ms per frame of each stage; the slowest one bounds
the fps (``bottleneck``: decode | inference (pre+model+post) | encode).

Alpha output (``--alpha-codec``): ``vp9`` = WebM VP9 yuva420p (libvpx realtime, default: what the
web preview and the export read); ``split`` = Matroska with two NVENC H.264 streams (colour + alpha
as luma, see ffio.MERGE_GRAPH); ``auto`` = split when NVENC works, else vp9. ``done.output`` is the
file written (``.mkv`` for split).

Env ``STUDIO_VRAM_BUDGET_MB``: VRAM the workers' GPU budget left for this process (they unload
their resident model first). Below ``RVM_VRAM_MB`` (or no CUDA) -> CPU with gpu_fallback_cpu.
Processing goes in chunks of ``--chunk`` frames (one segment each, joined at the end); the
recurrent state is carried across chunks. A CUDA error mid-run restarts the current chunk on CPU
(re-warming the state with the previous frames); CUDA out-of-memory with ``--seq-chunk`` > 1 first
retries on the GPU one frame at a time. Finished segments are kept in --work-dir, so a re-run with
the same input resumes from the last finished chunk.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import sys
import time
import warnings
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from . import ffio, refine

RVM_VRAM_MB = 900  # mobilenetv3 fp16 at 1080p + cuDNN workspace [S, docs §10.1: 0.4-0.8 GB]
# resnet50 fp16 at 1080p (0.375) + refinement temporaries [S: RVM README, ~2x mobilenet]
RVM_HQ_VRAM_MB = 1600
QUALITIES = ("fast", "high")
MODEL_FILES_BY_QUALITY = {
    "fast": {"cuda": "rvm_mobilenetv3_fp16.torchscript", "cpu": "rvm_mobilenetv3_fp32.torchscript"},
    "high": {"cuda": "rvm_resnet50_fp16.torchscript", "cpu": "rvm_resnet50_fp32.torchscript"},
}
MODEL_FILES = MODEL_FILES_BY_QUALITY["fast"]
MODEL_NAMES = {"fast": "mobilenetv3", "high": "resnet50"}
VRAM_MB = {"fast": RVM_VRAM_MB, "high": RVM_HQ_VRAM_MB}
HALO_EVERY = 30  # frames between two halo measurements (plus the compare frame)
WARMUP_FRAMES = 8
GPU_FALLBACK_CPU = "gpu_fallback_cpu"
SEQ_CHUNK_REDUCED = "rvm_seq_chunk_reduced"
CUDA_SEQ_CHUNK = 4  # frames per model call on CUDA (RVM inference docs: seq_chunk for parallelism)
CUDA_SEQ_CHUNK_HQ = 2  # resnet50: half the frames per call (6 GB laptops)
STAGES = ("decode", "pre", "model", "post", "encode")

# BT.601 limited range (what ffmpeg's swscale uses for untagged RGB -> YUV, i.e. the same colours
# the previous rgba -> yuva420p path produced). Rows: Y, Cb, Cr; offsets 16 / 128.
BT601 = (
    (0.256788, 0.504129, 0.097906),
    (-0.148223, -0.290993, 0.439216),
    (0.439216, -0.367788, -0.071427),
)


def emit(**event: Any) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def auto_downsample(w: int, h: int, quality: str = "fast") -> float:
    """RVM README: the downsampled frame should be ~256-512 px (1080p -> ~0.25); high quality
    keeps more detail for resnet50: 720 px (1080p -> 0.375)."""
    side = 720 if quality == "high" else 512
    return round(max(0.125, min(1.0, side / max(w, h))), 4)


# ------------------------------------------------------------------------------ colour


def yuva420p_numpy(rgb: Any, alpha: Any) -> bytes:
    """uint8 HxWx3 RGB + HxW alpha -> raw yuva420p (planar Y, U, V at ceil(w/2)xceil(h/2), A).
    Per-channel multiply-adds (a tiny-inner-dim matmul is ~10x slower in numpy)."""
    import numpy as np  # noqa: PLC0415

    h, w = rgb.shape[:2]
    chans = [rgb[..., c].astype(np.float32) for c in range(3)]

    def mix(row: tuple[float, float, float], planes: list[Any], offset: float) -> bytes:
        acc = planes[0] * np.float32(row[0])
        acc += planes[1] * np.float32(row[1])
        acc += planes[2] * np.float32(row[2])
        acc += np.float32(offset)
        return np.clip(np.rint(acc), 0, 255).astype(np.uint8).tobytes()

    y = mix(BT601[0], chans, 16.0)
    if h % 2 or w % 2:
        chans = [np.pad(c, ((0, h % 2), (0, w % 2)), mode="edge") for c in chans]
    sub = [(c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]) * 0.25 for c in chans]
    u, v = mix(BT601[1], sub, 128.0), mix(BT601[2], sub, 128.0)
    return b"".join([y, u, v, np.ascontiguousarray(alpha, dtype=np.uint8).tobytes()])


def yuva420p_torch(torch: Any, fgr: Any, pha: Any) -> Any:
    """fgr [T,3,H,W] and pha [T,1,H,W] in 0..1 (any float dtype, any device) -> uint8 [T, bytes]
    raw yuva420p, same maths as ``yuva420p_numpy`` (runs on the GPU: no CPU colour conversion)."""
    import torch.nn.functional as F  # noqa: N812, PLC0415

    t, _c, h, w = fgr.shape
    m = torch.tensor(BT601, dtype=torch.float32, device=fgr.device)
    rgb = fgr.float().mul(255.0)
    y = torch.einsum("oc,tchw->tohw", m[:1], rgb).add_(16.0)
    if h % 2 or w % 2:
        rgb = F.pad(rgb, (0, w % 2, 0, h % 2), mode="replicate")
    uv = torch.einsum("oc,tchw->tohw", m[1:], F.avg_pool2d(rgb, 2)).add_(128.0)
    a = pha.float().mul(255.0)
    parts = [y.flatten(1), uv[:, 0].flatten(1), uv[:, 1].flatten(1), a.flatten(1)]
    return torch.cat(parts, dim=1).round_().clamp_(0, 255).to(torch.uint8)


# ------------------------------------------------------------------------------ refinement


@dataclass
class Capture:
    """What the refinement reports across model reloads (CUDA -> CPU fallback): the before |
    after comparison frame (rgb24) and the halo scores."""

    compare_index: int = -1
    compare: tuple[bytes, int, int] | None = None
    before: list[float] = field(default_factory=list)
    after: list[float] = field(default_factory=list)

    def summary(self) -> dict[str, Any] | None:
        if not self.before or not self.after:
            return None
        b, a = sum(self.before) / len(self.before), sum(self.after) / len(self.after)
        return {"before": round(b, 3), "after": round(a, 3), "frames": len(self.after),
                "reduction": round(1 - a / b, 4) if b > 0 else None}  # fmt: skip


class Post:
    """Per-model refinement step: SAM mask guide + vision_gpl.refine on each output frame, the
    comparison frame and the halo samples. Inactive (no params, no mask) = untouched output."""

    def __init__(
        self,
        params: refine.RefineParams,
        ops: Any,
        mask: ffio.MaskReader | None,
        capture: Capture,
        to_mask: Any,
        halo_every: int = HALO_EVERY,
    ) -> None:
        self.params = params
        self.ops = ops
        self.mask = mask
        self.capture = capture
        self.to_mask = to_mask  # gray bytes -> HxW 0..1 in the ops' array type
        self.halo_every = max(1, halo_every)
        self.refiner = refine.Refiner(params, ops)
        self.active = params.active() or mask is not None

    def reset(self) -> None:
        self.refiner.reset()

    def __call__(self, index: int, obs: Any, fgr: Any, pha: Any) -> tuple[Any, Any]:
        raw = self.mask.get(index) if self.mask is not None else None
        mask = self.to_mask(raw) if raw is not None else None
        f2, a2 = self.refiner(obs, fgr, pha, mask)
        cap, ops = self.capture, self.ops
        is_compare = index == cap.compare_index
        if is_compare or index % self.halo_every == 0:
            before = refine.edge_halo(ops, fgr, pha)
            after = refine.edge_halo(ops, f2, a2)
            if before is not None and after is not None:
                cap.before.append(before)
                cap.after.append(after)
        if is_compare:
            img = refine.compose_compare(ops, (fgr, pha), (f2, a2))
            h, w = img.shape[:2]
            cap.compare = (_rgb_bytes(img), w, h)
        return f2, a2


def _rgb_bytes(img: Any) -> bytes:
    """HxWx3 float 0..1 (numpy or torch) -> rgb24 bytes."""
    if hasattr(img, "detach"):
        img = img.detach().float().mul(255).round_().clamp_(0, 255).byte().cpu().numpy()
        return img.tobytes()
    import numpy as np  # noqa: PLC0415

    return np.clip(np.rint(img * 255.0), 0, 255).astype(np.uint8).tobytes()


# ------------------------------------------------------------------------------ models


class MockModel:
    """--mock-model: constant alpha, foreground = source (tests and protocol checks; no torch).
    Colour conversion (numpy) is accounted as ``post`` like the real model's GPU conversion."""

    seq_chunk = 1

    def __init__(
        self, pix_fmt: str, alpha: int = 200, post: Any = None, shape: str = "flat"
    ) -> None:
        self.alpha = alpha
        self.pix_fmt = pix_fmt
        self.post: Post | None = post
        self.shape = shape  # "disk": soft-edged centred disk (refinement tests), else constant

    def reset(self) -> None:
        if self.post is not None:
            self.post.reset()

    def _refined(self, frames: list[bytes], w: int, h: int, first: int) -> list[bytes]:
        import numpy as np  # noqa: PLC0415

        assert self.post is not None
        outs: list[bytes] = []
        for j, rgb in enumerate(frames):
            obs = np.frombuffer(rgb, dtype=np.uint8).reshape(h, w, 3).astype(np.float32) / 255
            pha = np.full((h, w), self.alpha / 255.0, dtype=np.float32)
            if self.shape == "disk":
                yy, xx = np.mgrid[0:h, 0:w]
                dist = np.hypot(yy - h / 2, xx - w / 2)
                pha *= np.clip((0.35 * min(w, h) - dist) / 2 + 0.5, 0, 1).astype(np.float32)
            fgr, pha = self.post(first + j, obs, obs, pha)
            f8 = np.clip(np.rint(fgr * 255), 0, 255).astype(np.uint8)
            a8 = np.clip(np.rint(pha * 255), 0, 255).astype(np.uint8)
            if self.pix_fmt == "yuva420p":
                outs.append(yuva420p_numpy(f8, a8))
            else:
                outs.append(np.dstack([f8, a8]).tobytes())
        return outs

    def __call__(
        self, frames: list[bytes], w: int, h: int, ratio: float, first: int = 0
    ) -> tuple[list[bytes], tuple[float, float, float]]:
        t0 = time.perf_counter()
        outs: list[bytes] = []
        if self.post is not None and self.post.active:
            outs = self._refined(frames, w, h, first)
        elif self.pix_fmt == "yuva420p":
            import numpy as np  # noqa: PLC0415

            alpha = np.full((h, w), self.alpha, dtype=np.uint8)
            for rgb in frames:
                arr = np.frombuffer(rgb, dtype=np.uint8).reshape(h, w, 3)
                outs.append(yuva420p_numpy(arr, alpha))
        else:
            for rgb in frames:
                out = bytearray(w * h * 4)
                out[0::4] = rgb[0::3]
                out[1::4] = rgb[1::3]
                out[2::4] = rgb[2::3]
                out[3::4] = bytes([self.alpha]) * (w * h)
                outs.append(bytes(out))
        return outs, (0.0, 0.0, time.perf_counter() - t0)


class RvmModel:
    def __init__(
        self,
        model_dir: Path,
        device: str,
        *,
        w: int,
        h: int,
        pix_fmt: str,
        seq_chunk: int,
        channels_last: bool = False,
        cudnn_benchmark: bool = False,
        fast_start: bool = False,
        quality: str = "fast",
        post: Any = None,
    ) -> None:
        import torch  # noqa: PLC0415 - only inside .venv-gpl

        # frames arrive as immutable bytes; they are only read (copied into the staging buffer)
        warnings.filterwarnings("ignore", message="The given buffer is not writable")
        self.torch = torch
        self.device = device
        self.w, self.h = w, h
        self.pix_fmt = pix_fmt
        self.seq_chunk = max(1, seq_chunk)
        path = model_dir / MODEL_FILES_BY_QUALITY[quality][device]
        if not path.is_file():
            pack = "matting-hq" if quality == "high" else "matting"
            raise RuntimeError(f"Falta el modelo RVM {path.name} (paquete {pack})")
        self.post: Post | None = post
        if fast_start:  # legacy TorchScript executor: no profiling/fusion compile on first calls
            with contextlib.suppress(Exception):
                torch._C._jit_set_profiling_executor(False)
        model = torch.jit.load(str(path), map_location=device).eval()
        try:  # RVM inference docs: freeze the TorchScript model for speed
            model = torch.jit.freeze(model)
            self.frozen = True
        except Exception:
            self.frozen = False
        if channels_last:
            model = model.to(memory_format=torch.channels_last)
        if device == "cuda" and cudnn_benchmark:
            torch.backends.cudnn.benchmark = True
        self.model = model
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        if device == "cpu":
            torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
        self.out_bytes = ffio.frame_bytes(pix_fmt, w, h)
        self._alloc()
        self.rec: list[Any] = [None] * 4

    def _alloc(self) -> None:
        torch, t = self.torch, self.seq_chunk
        pin = self.device == "cuda"
        self.host_in = torch.empty((t, self.h, self.w, 3), dtype=torch.uint8, pin_memory=pin)
        self.host_out = torch.empty((t, self.out_bytes), dtype=torch.uint8, pin_memory=pin)

    def set_seq_chunk(self, n: int) -> None:
        self.seq_chunk = max(1, n)
        self._alloc()

    def reset(self) -> None:
        self.rec = [None] * 4
        if self.post is not None:
            self.post.reset()

    def _refine(self, i: int, index: int, x: Any, f: Any, a: Any) -> tuple[Any, Any]:
        """Frame i of the batch through Post (HxWx3 / HxW float32 on the model's device)."""
        assert self.post is not None
        obs = x[i].permute(1, 2, 0).float()
        fgr, pha = self.post(index, obs, f[0].permute(1, 2, 0).float(), a[0, 0].float())
        return fgr.permute(2, 0, 1)[None], pha[None, None]

    def __call__(
        self, frames: list[bytes], w: int, h: int, ratio: float, first: int = 0
    ) -> tuple[list[bytes], tuple[float, float, float]]:
        torch = self.torch
        n = len(frames)
        cuda = self.device == "cuda"
        c0 = time.perf_counter()
        for i, buf in enumerate(frames):  # one memcpy into the (pinned) staging buffer
            self.host_in[i].copy_(torch.frombuffer(buf, dtype=torch.uint8).view(h, w, 3))
        copy_in = time.perf_counter() - c0
        with torch.inference_mode():
            if cuda:
                ev = [torch.cuda.Event(enable_timing=True) for _ in range(4)]
                ev[0].record()
            else:
                t0 = time.perf_counter()
            x = self.host_in[:n].to(self.device, non_blocking=True)
            x = x.permute(0, 3, 1, 2).to(self.dtype).div_(255)  # [T,3,H,W]
            src = x.unsqueeze(0) if n > 1 else x  # RVM: [B,T,C,H,W] = T frames in one call
            if cuda:
                ev[1].record()
            else:
                t1 = time.perf_counter()
            fgr, pha, *rec = self.model(src, *self.rec, ratio)
            self.rec = list(rec)
            if n > 1:
                fgr, pha = fgr[0], pha[0]
            if cuda:
                ev[2].record()
            else:
                t2 = time.perf_counter()
            refining = self.post is not None and self.post.active
            for i in range(n):  # one frame at a time: fp32 temporaries stay ~100 MB at 1080p
                f, a = fgr[i : i + 1], pha[i : i + 1]
                if refining:
                    f, a = self._refine(i, first + i, x, f, a)
                if self.pix_fmt == "yuva420p":
                    out = yuva420p_torch(torch, f, a)[0]
                else:
                    out = torch.cat([f, a], dim=1)[0].mul(255).round_().clamp_(0, 255)
                    out = out.to(torch.uint8).permute(1, 2, 0).reshape(-1)
                self.host_out[i].copy_(out, non_blocking=cuda)
            if cuda:
                ev[3].record()
                ev[3].synchronize()
                pre = ev[0].elapsed_time(ev[1]) / 1000 + copy_in
                model_s = ev[1].elapsed_time(ev[2]) / 1000
                post = ev[2].elapsed_time(ev[3]) / 1000
            else:
                t3 = time.perf_counter()
                pre, model_s, post = t1 - t0 + copy_in, t2 - t1, t3 - t2
        c1 = time.perf_counter()
        host = self.host_out.numpy()
        outs = [host[i].tobytes() for i in range(n)]
        return outs, (pre, model_s, post + time.perf_counter() - c1)


def cuda_available(mock: bool) -> bool:
    if mock:
        return os.environ.get("STUDIO_MOCK_CUDA") == "1"
    try:
        import torch  # noqa: PLC0415

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def choose_device(requested: str, mock: bool, vram_mb: int = RVM_VRAM_MB) -> tuple[str, list[str]]:
    if requested == "cpu":
        return "cpu", []
    budget_raw = os.environ.get("STUDIO_VRAM_BUDGET_MB", "").strip()
    budget = int(float(budget_raw)) if budget_raw else None
    if not cuda_available(mock):
        if requested == "cuda":
            emit(event="warning", code=GPU_FALLBACK_CPU, message="CUDA no disponible: CPU")
            return "cpu", [GPU_FALLBACK_CPU]
        return "cpu", []
    if budget is not None and budget < vram_mb:
        emit(
            event="warning",
            code=GPU_FALLBACK_CPU,
            message=f"VRAM libre {budget} MB < {vram_mb} MB: se procesa en CPU (lento)",
        )
        return "cpu", [GPU_FALLBACK_CPU]
    return "cuda", []


def choose_pix_fmt(requested: str, mock: bool) -> str:
    """yuva420p (colour conversion done by us, on the GPU for RVM) unless numpy is missing for
    the mock; ``rgba`` keeps the previous path (ffmpeg converts) for A/B measurements."""
    if requested in ("rgba", "yuva420p"):
        return requested
    if mock:
        try:
            import numpy  # noqa: F401, PLC0415
        except ImportError:
            return "rgba"
    return "yuva420p"


# ------------------------------------------------------------------------------ timings


@dataclass
class Stages:
    """Busy seconds per stage. Model stages exclude the first batch (TorchScript profiling and
    cuDNN set-up), reported apart as ``first_batch_s``."""

    busy: dict[str, float] = field(default_factory=lambda: dict.fromkeys(STAGES, 0.0))
    frames: dict[str, int] = field(default_factory=lambda: dict.fromkeys(STAGES, 0))
    wait: dict[str, float] = field(default_factory=lambda: {"decode": 0.0, "encode": 0.0})
    first_batch_s: float | None = None
    load_s: float = 0.0
    process_s: float = 0.0
    concat_s: float = 0.0

    def add(self, stage: str, seconds: float, frames: int) -> None:
        self.busy[stage] += seconds
        self.frames[stage] += frames

    def ms_per_frame(self) -> dict[str, float]:
        return {
            k: round(self.busy[k] * 1000 / self.frames[k], 2) if self.frames[k] else 0.0
            for k in STAGES
        }

    def summary(self) -> dict[str, Any]:
        ms = self.ms_per_frame()
        enc_frames = max(1, self.frames["encode"])
        dec_frames = max(1, self.frames["decode"])
        lanes = {
            "decode": ms["decode"],
            "inference": ms["pre"] + ms["model"] + ms["post"],
            "encode": ms["encode"],
        }
        return {
            "ms_per_frame": ms,
            "stage_fps": {k: round(1000 / v, 1) if v else None for k, v in ms.items()},
            "wait_ms_per_frame": {
                "decode": round(self.wait["decode"] * 1000 / dec_frames, 2),
                "encode": round(self.wait["encode"] * 1000 / enc_frames, 2),
            },
            "bottleneck": max(lanes, key=lambda k: lanes[k]),
            "load_s": round(self.load_s, 3),
            "first_batch_s": round(self.first_batch_s, 3) if self.first_batch_s else None,
            "process_s": round(self.process_s, 3),
            "concat_s": round(self.concat_s, 3),
        }


# ------------------------------------------------------------------------------ run


@dataclass
class Job:
    ffmpeg: str
    src: Path
    w: int
    h: int
    fps: Fraction
    total: int
    chunk: int
    ratio: float
    work: Path
    pix_fmt: str
    alpha_codec: str
    split_encoder: str
    stages: Stages

    @property
    def ext(self) -> str:
        return ffio.SEGMENT_EXT[self.alpha_codec]

    def segment(self, k: int) -> Path:
        return self.work / f"seg_{k:05d}{self.ext}"

    def done_marker(self, k: int) -> Path:
        return self.work / f"seg_{k:05d}.done"

    def finished_frames(self) -> int:
        k = 0
        while self.done_marker(k).is_file():
            k += 1
        return k * self.chunk


def refine_params(args: argparse.Namespace) -> refine.RefineParams:
    despill = None if args.despill in (None, "auto") else args.despill == "on"
    return refine.resolve(
        args.quality, erode=args.erode, feather=args.feather, despill=despill,
        temporal=args.temporal, bg_tile=args.bg_tile, mask_dilate=args.mask_dilate,
    )  # fmt: skip


def _gray_to_numpy(w: int, h: int) -> Any:
    def conv(raw: bytes) -> Any:
        import numpy as np  # noqa: PLC0415

        return np.frombuffer(raw, dtype=np.uint8).reshape(h, w).astype(np.float32) / 255

    return conv


def _gray_to_torch(torch: Any, device: str, w: int, h: int) -> Any:
    def conv(raw: bytes) -> Any:
        t = torch.frombuffer(bytearray(raw), dtype=torch.uint8).view(h, w)
        return t.to(device).float().div_(255)

    return conv


def _load(
    args: argparse.Namespace,
    device: str,
    w: int,
    h: int,
    pix_fmt: str,
    params: refine.RefineParams | None = None,
    mask: ffio.MaskReader | None = None,
    capture: Capture | None = None,
) -> Any:
    params = params or refine.FAST_DEFAULTS
    capture = capture or Capture()
    if args.mock_model:
        post = Post(params, refine.NumpyOps(), mask, capture, _gray_to_numpy(w, h),
                    args.halo_every)  # fmt: skip
        return MockModel(pix_fmt, alpha=args.mock_alpha, post=post, shape=args.mock_shape)
    cuda_seq = CUDA_SEQ_CHUNK_HQ if args.quality == "high" else CUDA_SEQ_CHUNK
    seq = args.seq_chunk or (cuda_seq if device == "cuda" else 1)
    model = RvmModel(
        Path(args.model_dir or "."), device, w=w, h=h, pix_fmt=pix_fmt, seq_chunk=seq,
        channels_last=args.channels_last, cudnn_benchmark=args.cudnn_benchmark,
        fast_start=args.fast_start, quality=args.quality,
    )  # fmt: skip
    torch = model.torch
    model.post = Post(params, refine.TorchOps(torch), mask, capture,
                      _gray_to_torch(torch, device, w, h), args.halo_every)  # fmt: skip
    return model


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
    auto = args.downsample in (None, "auto")
    ratio = auto_downsample(w, h, args.quality) if auto else float(args.downsample)
    ratio = max(0.125, min(1.0, ratio))
    chunk = max(1, int(args.chunk))
    device, warnings = choose_device(args.device, args.mock_model, VRAM_MB[args.quality])
    if device == "cpu" and not args.mock_model:
        warnings.append("cpu_slow")
    alpha_codec = ffio.choose_alpha_codec(ffmpeg, args.alpha_codec)
    if alpha_codec == ffio.ALPHA_SPLIT:
        out = out.with_suffix(".mkv")
    pix_fmt = "yuva420p" if alpha_codec == ffio.ALPHA_SPLIT else None
    pix_fmt = pix_fmt or choose_pix_fmt(args.pix_fmt, args.mock_model)
    work = Path(args.work_dir) if args.work_dir else out.with_name(out.name + ".parts")
    work.mkdir(parents=True, exist_ok=True)
    st = src.stat()
    params = refine_params(args)
    mask = ffio.MaskReader(ffmpeg, Path(args.mask), w, h, args.mask_offset) if args.mask else None
    capture = Capture()
    if args.compare_out and (params.active() or mask is not None):
        idx = args.compare_frame
        capture.compare_index = idx if idx is not None and idx >= 0 else min(
            total // 2, round(float(fps)))  # fmt: skip
    meta = {"input": str(src.resolve()), "size": st.st_size, "mtime": st.st_mtime_ns,
            "chunk": chunk, "w": w, "h": h, "ratio": ratio, "alpha_codec": alpha_codec,
            "pix_fmt": pix_fmt, "quality": args.quality, "refine": params.as_dict(),
            "mask": str(args.mask or ""), "mask_offset": args.mask_offset}  # fmt: skip
    start_at = _resume_point(work, meta, chunk)
    stages = Stages()
    t_load = time.perf_counter()
    model = _load(args, device, w, h, pix_fmt, params, mask, capture)
    stages.load_s = time.perf_counter() - t_load
    emit(event="start", frames=total, fps=f"{fps.numerator}/{fps.denominator}", width=w,
         height=h, device=device, downsample=ratio, resume_from=start_at,
         quality=args.quality, model=MODEL_NAMES[args.quality],
         alpha_codec=alpha_codec, pix_fmt=pix_fmt, seq_chunk=model.seq_chunk,
         load_s=round(stages.load_s, 3))  # fmt: skip
    job = Job(ffmpeg, src, w, h, fps, total, chunk, ratio, work, pix_fmt, alpha_codec,
              args.split_encoder, stages)  # fmt: skip
    t0 = time.perf_counter()
    processed = 0
    frames_out = 0
    while True:
        try:
            done, frames_out = _process(job, model, start_at, t0)
            processed += done
            break
        except RuntimeError as exc:
            msg = str(exc).upper()
            if device != "cuda" or "CUDA" not in msg:
                raise
            if "OUT OF MEMORY" in msg and getattr(model, "seq_chunk", 1) > 1:
                model.torch.cuda.empty_cache()
                model.set_seq_chunk(1)
                emit(event="warning", code=SEQ_CHUNK_REDUCED,
                     message="Memoria de GPU justa: se procesa de a un fotograma")  # fmt: skip
                warnings.append(SEQ_CHUNK_REDUCED)
            else:
                emit(event="warning", code=GPU_FALLBACK_CPU, message=f"Error CUDA ({exc}): CPU")
                warnings.append(GPU_FALLBACK_CPU)
                device = "cpu"
                model = _load(args, device, w, h, pix_fmt, params, mask, capture)
            start_at = job.finished_frames()
    if mask is not None:
        mask.close()
    segments = sorted(work.glob(f"seg_*{job.ext}"))
    if not segments:
        raise RuntimeError("No se proceso ningun fotograma")
    stages.process_s = time.perf_counter() - t0
    t_concat = time.perf_counter()
    ffio.concat(ffmpeg, segments, out)
    stages.concat_s = time.perf_counter() - t_concat
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
        "alpha_codec": alpha_codec,
        "pix_fmt": pix_fmt,
        "seq_chunk": getattr(model, "seq_chunk", 1),
        "quality": args.quality,
        "model": MODEL_NAMES[args.quality],
        "timings": stages.summary(),
        "warnings": list(dict.fromkeys(warnings)),
    }
    if params.active() or mask is not None:
        result["refine"] = params.as_dict()
        halo = capture.summary()
        if halo:
            result["halo"] = halo
        if mask is not None:
            result["mask_frames"] = mask.used
        if capture.compare is not None and args.compare_out:
            rgb, cw, ch = capture.compare
            png = ffio.write_png(ffmpeg, rgb, cw, ch, Path(args.compare_out))
            result["compare_path"] = str(png)
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return result


def _process(job: Job, model: Any, start_at: int, t0: float) -> tuple[int, int]:
    """Returns (frames processed now, frames in the output)."""
    model.reset()
    stages = job.stages
    first = max(0, start_at - WARMUP_FRAMES)  # re-warm the recurrent state before a resume

    def open_segment(k: int) -> ffio.Writer:
        return ffio.Writer(job.ffmpeg, job.segment(k), job.w, job.h, job.fps,
                           pix_fmt=job.pix_fmt, alpha_codec=job.alpha_codec,
                           split_encoder=job.split_encoder)  # fmt: skip

    reader = ffio.FramePrefetcher(job.ffmpeg, job.src, job.w, job.h)
    encoder = ffio.EncodeWorker(open_segment, lambda k: job.done_marker(k).touch())
    batch: list[bytes] = []
    batch_start = first
    idx = 0
    done = 0
    seg_index = -1
    last_emit = 0.0

    def flush() -> None:
        nonlocal batch, batch_start, done, seg_index, last_emit
        if not batch:
            return
        outs, (pre, model_s, post) = model(batch, job.w, job.h, job.ratio, batch_start)
        if stages.first_batch_s is None:
            stages.first_batch_s = pre + model_s + post
        else:
            for name, sec in (("pre", pre), ("model", model_s), ("post", post)):
                stages.add(name, sec, len(batch))
        for j, frame in enumerate(outs):
            i = batch_start + j
            if i < start_at:
                continue  # warm-up output discarded
            k = i // job.chunk
            if k != seg_index:
                seg_index = k
                emit(event="chunk", index=k, start=k * job.chunk,
                     end=min(job.total, (k + 1) * job.chunk) - 1)  # fmt: skip
            encoder.put(k, frame)
            done += 1
        batch_start += len(batch)
        batch = []
        now = time.perf_counter()
        if now - last_emit > 0.5 or batch_start >= job.total:
            last_emit = now
            emit(event="progress", frame=batch_start, frames=job.total,
                 progress=round(min(1.0, batch_start / max(1, job.total)), 4),
                 fps=round(done / max(1e-6, now - t0), 2),
                 stages=_live(stages, reader, encoder))  # fmt: skip

    try:
        for buf in reader:
            if idx < first:
                idx += 1
                continue
            batch.append(buf)
            idx += 1
            if len(batch) >= model.seq_chunk:
                flush()
        flush()
        encoder.finish()
    except BaseException:
        encoder.abort()
        raise
    finally:
        reader.close()
        _commit(stages, reader, encoder)
    return done, idx


def _live(
    stages: Stages, reader: ffio.FramePrefetcher, encoder: ffio.EncodeWorker
) -> dict[str, float]:
    """Running ms/frame per stage (finished attempts + the current reader/encoder threads)."""
    ms = stages.ms_per_frame()
    for name, worker in (("decode", reader), ("encode", encoder)):
        frames = stages.frames[name] + worker.frames
        if frames:
            ms[name] = round((stages.busy[name] + worker.busy) * 1000 / frames, 2)
    return ms


def _commit(stages: Stages, reader: ffio.FramePrefetcher, encoder: ffio.EncodeWorker) -> None:
    stages.add("decode", reader.busy, reader.frames)
    stages.add("encode", encoder.busy, encoder.frames)
    stages.wait["decode"] += reader.wait
    stages.wait["encode"] += encoder.wait


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
    p.add_argument("--alpha-codec", choices=("vp9", "split", "auto"), default="vp9")
    p.add_argument("--split-encoder", default=ffio.SPLIT_ENCODER, help=argparse.SUPPRESS)
    p.add_argument("--pix-fmt", choices=("auto", "yuva420p", "rgba"), default="auto")
    p.add_argument("--seq-chunk", type=int, default=0, help="0 = 4 en CUDA, 1 en CPU")
    p.add_argument("--channels-last", action="store_true")
    p.add_argument("--cudnn-benchmark", action="store_true")
    p.add_argument("--fast-start", action="store_true", help="sin perfilado TorchScript")
    p.add_argument("--mock-model", action="store_true", help="alfa constante, sin torch")
    p.add_argument("--mock-alpha", type=int, default=200, help=argparse.SUPPRESS)
    p.add_argument("--mock-shape", choices=("flat", "disk"), default="flat", help=argparse.SUPPRESS)
    # recorte de calidad alta (vision_gpl/refine.py); None = default of --quality
    p.add_argument("--quality", choices=QUALITIES, default="fast")
    p.add_argument("--erode", type=int, default=None, help="px de erosion del alfa")
    p.add_argument("--feather", type=float, default=None, help="sigma gaussiano del borde (px)")
    p.add_argument("--despill", choices=("auto", "on", "off"), default="auto")
    p.add_argument("--temporal", type=float, default=None, help="EMA de bordes 0..0.9")
    p.add_argument("--bg-tile", type=int, default=None, help=argparse.SUPPRESS)
    p.add_argument("--mask", default=None, help="mascara SAM: PNG o carpeta %%05d.png")
    p.add_argument("--mask-dilate", type=int, default=None)
    p.add_argument("--mask-offset", type=int, default=0, help="fotograma fuente de la mascara 0")
    p.add_argument("--compare-out", default=None, help="PNG antes | despues de un fotograma")
    p.add_argument("--compare-frame", type=int, default=None)
    p.add_argument("--halo-every", type=int, default=HALO_EVERY, help=argparse.SUPPRESS)
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
