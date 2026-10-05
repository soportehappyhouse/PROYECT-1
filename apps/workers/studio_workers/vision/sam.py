"""SAM 2.1 click-to-mask sessions with chunked propagation (pack sam2, Apache-2.0).

Memory rules for 6 GB (docs/INVESTIGACION-IA-LOCAL.md §1.2): frames go to disk as JPEG once per
session (storage/tmp/sam/<id>/frames, not served); each propagation chunk (default 200 frames)
gets its own predictor state with ``offload_video_to_cpu`` / ``offload_state_to_cpu`` and is reset
afterwards; the last mask of a chunk is the mask prompt of the next one (1 frame overlap). Points
are propagated forward from the first prompted frame to the end and backwards to the start.

Interactive ``points``: a one-frame state (fast) returns the mask for the clicked frame; the
prompts are stored and replayed inside the propagation chunks. Masks are 8-bit PNGs in
storage/renders/sam/<id>/masks/<obj_id>/%05d.png (served by the api /files), indexes relative to
the session range. Model: tiny by default, small when the small checkpoint is present and the GPU
has > 3 GB free (gpu.py). The model is unloaded after each propagation (big models do not stay
resident, §10.2).
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..config import Settings
from ..gpu import GpuBudget, empty_cuda_cache
from ..packs import PackRequiredError, module_present
from .frames import (
    VideoInfo,
    ffmpeg_exe,
    frame_times,
    mask_bbox,
    masks_to_alpha_webm,
    probe,
    write_png,
)
from .trackfile import TrackFile, build_track

log = logging.getLogger("studio_workers")

SAM_FILES = {"tiny": "sam2.1_hiera_tiny.pt", "small": "sam2.1_hiera_small.pt"}
SAM_CONFIGS = {
    "tiny": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "small": "configs/sam2.1/sam2.1_hiera_s.yaml",
}
SAM_VRAM_MB = {"tiny": 1500, "small": 2500}
SMALL_MIN_FREE_MB = 3072
DEFAULT_CHUNK = 200
SESSION_TTL_S = 3600.0
SAM_CPU_SLOW = "sam2_cpu_slow"

Mask = Any  # numpy bool HxW


class SessionBusyError(RuntimeError):
    """The session is propagating (409 SESSION_BUSY): interactive clicks wait for the task."""


def sam_dir(root: Path) -> Path:
    return root / "sam2"


class SamBackend(Protocol):
    device: str

    def init_state(self, frames_dir: Path) -> Any: ...
    def add_points(
        self, state: Any, frame_idx: int, obj_id: int, points: list[tuple[float, float]],
        labels: list[int],
    ) -> Mask: ...  # fmt: skip
    def add_box(
        self, state: Any, frame_idx: int, obj_id: int, box: tuple[float, float, float, float]
    ) -> Mask: ...
    def add_mask(self, state: Any, frame_idx: int, obj_id: int, mask: Mask) -> None: ...
    def propagate(
        self, state: Any, start_idx: int, reverse: bool
    ) -> Iterator[tuple[int, dict[int, Mask]]]: ...
    def reset(self, state: Any) -> None: ...
    def unload(self) -> None: ...


BackendFactory = Callable[[str, str], SamBackend]  # (size, device) -> backend


class Sam2Backend:
    """facebookresearch/sam2 video predictor (installed with SAM2_BUILD_CUDA=0)."""

    def __init__(self, ckpt: Path, config: str, device: str) -> None:
        from sam2.build_sam import build_sam2_video_predictor  # noqa: PLC0415

        self.device = device
        self.predictor = build_sam2_video_predictor(config, str(ckpt), device=device)

    @contextlib.contextmanager
    def _ctx(self) -> Iterator[None]:
        import torch  # noqa: PLC0415

        with contextlib.ExitStack() as stack:
            stack.enter_context(torch.inference_mode())
            if self.device == "cuda":
                stack.enter_context(torch.autocast("cuda", dtype=torch.bfloat16))
            yield

    @staticmethod
    def _pick(obj_ids: Any, logits: Any, obj_id: int) -> Mask:
        ids = list(obj_ids)
        i = ids.index(obj_id) if obj_id in ids else 0
        return (logits[i, 0] > 0.0).cpu().numpy()

    def init_state(self, frames_dir: Path) -> Any:
        with self._ctx():
            return self.predictor.init_state(
                video_path=str(frames_dir),
                offload_video_to_cpu=True,
                offload_state_to_cpu=True,
            )

    def add_points(self, state, frame_idx, obj_id, points, labels):  # type: ignore[no-untyped-def]
        import numpy as np  # noqa: PLC0415

        with self._ctx():
            _, ids, logits = self.predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=np.array(points, dtype=np.float32),
                labels=np.array(labels, dtype=np.int32),
            )
            return self._pick(ids, logits, obj_id)

    def add_box(self, state, frame_idx, obj_id, box):  # type: ignore[no-untyped-def]
        import numpy as np  # noqa: PLC0415

        with self._ctx():
            _, ids, logits = self.predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                box=np.array(box, dtype=np.float32),
            )
            return self._pick(ids, logits, obj_id)

    def add_mask(self, state, frame_idx, obj_id, mask):  # type: ignore[no-untyped-def]
        with self._ctx():
            self.predictor.add_new_mask(state, frame_idx, obj_id, mask.astype(bool))

    def propagate(self, state, start_idx, reverse):  # type: ignore[no-untyped-def]
        with self._ctx():
            for idx, ids, logits in self.predictor.propagate_in_video(
                state, start_frame_idx=start_idx, reverse=reverse
            ):
                yield (
                    idx,
                    {int(oid): (logits[i, 0] > 0.0).cpu().numpy() for i, oid in enumerate(ids)},
                )

    def reset(self, state: Any) -> None:
        self.predictor.reset_state(state)

    def unload(self) -> None:
        self.predictor = None
        empty_cuda_cache()


@dataclass
class Prompt:
    frame: int  # session-local index
    obj_id: int
    points: list[tuple[float, float]] = field(default_factory=list)  # pixels
    labels: list[int] = field(default_factory=list)
    box: tuple[float, float, float, float] | None = None  # x0, y0, x1, y1 pixels
    mask: Mask | None = None


@dataclass
class SamSession:
    id: str
    src: Path
    info: VideoInfo
    start: int  # source frame index of local 0
    end: int  # inclusive
    times: list[float]  # per local frame (s from the source start)
    frames_dir: Path
    out_dir: Path
    asset_id: str = ""
    prompts: list[Prompt] = field(default_factory=list)
    last_used: float = field(default_factory=time.monotonic)
    lock: threading.RLock = field(default_factory=threading.RLock)

    @property
    def n(self) -> int:
        return len(self.times)

    def prompts_at(self, frame: int, obj_id: int) -> Prompt | None:
        return next((p for p in self.prompts if p.frame == frame and p.obj_id == obj_id), None)


def _link_frames(src_dir: Path, dst: Path, indices: list[int]) -> Path:
    dst.mkdir(parents=True, exist_ok=True)
    for k, i in enumerate(indices):
        a, b = src_dir / f"{i:05d}.jpg", dst / f"{k:05d}.jpg"
        try:
            os.link(a, b)  # NTFS hard links need no admin rights
        except OSError:
            shutil.copyfile(a, b)
    return dst


class SamManager:
    def __init__(
        self,
        settings: Settings,
        budget: GpuBudget | None = None,
        backend_factory: BackendFactory | None = None,
    ) -> None:
        self.settings = settings
        self.budget = budget
        self.backend_factory = backend_factory
        self.sessions: dict[str, SamSession] = {}
        self._backend: SamBackend | None = None
        self._key: tuple[str, str] | None = None
        self._lock = threading.RLock()

    # ------------------------------------------------------------------- model
    @property
    def root(self) -> Path:
        return self.settings.models_root

    def available(self) -> bool:
        if self.backend_factory is not None:
            return True
        return (
            module_present("sam2")
            and module_present("torch")
            and (sam_dir(self.root) / SAM_FILES["tiny"]).is_file()
        )

    def require(self) -> None:
        if not self.available():
            raise PackRequiredError("sam2")
        if not module_present("numpy"):
            raise PackRequiredError("sam2")

    def choose_size(self) -> str:
        small_ok = (
            self.backend_factory is not None or (sam_dir(self.root) / SAM_FILES["small"]).is_file()
        )
        if not (small_ok and self.settings.use_cuda and self.budget is not None):
            return "tiny"
        info = self.budget.vram(fresh=True)
        if info is None:
            return "tiny"
        free = info.free_mb
        resident = self.budget.resident
        if resident and not resident.startswith("sam2"):
            free += self.budget.status().get("resident_estimated_mb") or 0  # will be unloaded
        return "small" if free > SMALL_MIN_FREE_MB else "tiny"

    def unload(self) -> None:
        with self._lock:
            if self._backend is not None:
                with contextlib.suppress(Exception):
                    self._backend.unload()
            self._backend = None
            self._key = None

    def _get_backend(self, size: str) -> tuple[SamBackend, str, list[str]]:
        warnings: list[str] = []
        device = "cpu"
        name = f"sam2-{size}"
        if self.settings.use_cuda and self.budget is not None:
            decision = self.budget.acquire(name, SAM_VRAM_MB[size], self.unload)
            device, warnings = decision.device, list(decision.warnings)
        with self._lock:
            if self._backend is None or self._key != (size, device):
                self.unload()
                factory = self.backend_factory or (
                    lambda sz, dev: Sam2Backend(
                        sam_dir(self.root) / SAM_FILES[sz], SAM_CONFIGS[sz], dev
                    )  # fmt: skip
                )
                try:
                    self._backend = factory(size, device)
                except Exception as exc:
                    if device != "cuda":
                        raise
                    log.warning("SAM 2 on CUDA failed (%s); CPU", exc)
                    if self.budget is not None:
                        warnings += self.budget.failed(name)
                    device = "cpu"
                    self._backend = factory(size, device)
                self._key = (size, device)
            if device == "cpu":
                warnings.append(SAM_CPU_SLOW)
            return self._backend, device, list(dict.fromkeys(warnings))

    def release_model(self) -> None:
        self.unload()
        if self.budget is not None:
            for size in SAM_FILES:
                self.budget.release(f"sam2-{size}")

    # ------------------------------------------------------------------- sessions
    def _expire(self) -> None:
        now = time.monotonic()
        for sid, s in list(self.sessions.items()):
            if now - s.last_used > SESSION_TTL_S:
                log.info("SAM session %s expired", sid)
                self.delete(sid)

    def get(self, sid: str) -> SamSession:
        s = self.sessions.get(sid)
        if s is None:
            from ..errors import NotFoundError  # noqa: PLC0415

            raise NotFoundError(f"Sesion SAM desconocida o vencida: {sid}")
        s.last_used = time.monotonic()
        return s

    def create(
        self, src: Path, frame_range: tuple[int, int] | None = None, asset_id: str = ""
    ) -> SamSession:
        self.require()
        self._expire()
        info = probe(src)
        times_all = frame_times(src, info)
        last = max(0, len(times_all) - 1)
        a, b = (0, last) if frame_range is None else frame_range
        a, b = max(0, int(a)), min(last, int(b))
        if b < a:
            raise ValueError(f"Rango de fotogramas invalido: {frame_range}")
        sid = uuid.uuid4().hex[:12]
        frames_dir = self.settings.storage_root / "tmp" / "sam" / sid / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [
                ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                "-vf", f"select='between(n\\,{a}\\,{b})'", "-fps_mode", "passthrough",
                "-q:v", "2", "-start_number", "0", str(frames_dir / "%05d.jpg"),
            ],
            capture_output=True, text=True, timeout=3600,
        )  # fmt: skip
        if proc.returncode != 0:
            shutil.rmtree(frames_dir.parent, ignore_errors=True)
            raise RuntimeError(f"ffmpeg (fotogramas SAM) fallo: {proc.stderr.strip()[-300:]}")
        count = len(list(frames_dir.glob("*.jpg")))
        times = times_all[a : a + count]
        out_dir = self.settings.storage_root / "renders" / "sam" / sid
        out_dir.mkdir(parents=True, exist_ok=True)
        session = SamSession(sid, src, info, a, a + count - 1, times, frames_dir, out_dir, asset_id)
        self.sessions[sid] = session
        return session

    def delete(self, sid: str) -> bool:
        s = self.sessions.pop(sid, None)
        if s is None:
            return False
        with s.lock:
            shutil.rmtree(s.frames_dir.parent, ignore_errors=True)
        if not self.sessions:
            self.release_model()
        return True

    def _rel(self, path: Path) -> str:
        return self.settings.storage_relative(path)

    # ------------------------------------------------------------------- interactive
    def add_prompt(self, s: SamSession, prompt: Prompt, replace: bool = False) -> dict[str, Any]:
        """Store the prompt and return the mask of its frame (one-frame state)."""
        if not 0 <= prompt.frame < s.n:
            raise ValueError(f"Fotograma fuera de la sesion: {prompt.frame} (0..{s.n - 1})")
        if not s.lock.acquire(timeout=0.5):
            raise SessionBusyError("La sesion esta propagando la mascara; espera a que termine")
        try:
            return self._add_prompt_locked(s, prompt, replace)
        finally:
            s.lock.release()

    def _add_prompt_locked(self, s: SamSession, prompt: Prompt, replace: bool) -> dict[str, Any]:
        prev = s.prompts_at(prompt.frame, prompt.obj_id)
        if (
            prev is not None
            and not replace
            and prompt.points
            and prompt.box is None
            and prompt.mask is None
        ):
            prev.points += prompt.points  # clicks accumulate on the same frame/object
            prev.labels += prompt.labels
            prompt = prev
        else:
            if prev is not None:
                s.prompts.remove(prev)
            s.prompts.append(prompt)
        backend, device, warnings = self._get_backend(self.choose_size())
        tmp = s.frames_dir.parent / f"one-{uuid.uuid4().hex[:6]}"
        _link_frames(s.frames_dir, tmp, [prompt.frame])
        try:
            state = backend.init_state(tmp)
            mask = self._apply(backend, state, prompt, 0)
            backend.reset(state)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        png = s.out_dir / "points" / f"{prompt.obj_id}_{prompt.frame:05d}.png"
        write_png(png, (mask > 0).astype("uint8") * 255)
        box = mask_bbox(mask)
        w, h = s.info.width, s.info.height
        bbox = {"x": box[0] / w, "y": box[1] / h, "w": box[2] / w, "h": box[3] / h} if box else None
        return {
            "mask_png_path": self._rel(png),
            "bbox": bbox,
            "bbox_px": dict(zip(("x", "y", "w", "h"), box, strict=True)) if box else None,
            "frame": prompt.frame,
            "obj_id": prompt.obj_id,
            "device": device,
            "warnings": warnings,
        }

    @staticmethod
    def _apply(backend: SamBackend, state: Any, p: Prompt, local: int) -> Mask:
        mask = None
        if p.mask is not None:
            backend.add_mask(state, local, p.obj_id, p.mask)
            mask = p.mask
        if p.box is not None:
            mask = backend.add_box(state, local, p.obj_id, p.box)
        if p.points:
            mask = backend.add_points(state, local, p.obj_id, p.points, p.labels)
        return mask

    # ------------------------------------------------------------------- propagation
    def propagate(
        self,
        s: SamSession,
        *,
        chunk_frames: int = DEFAULT_CHUNK,
        alpha: bool = True,
        progress: Callable[[float, str], None] | None = None,
        method: str = "sam2",
    ) -> dict[str, Any]:
        import numpy as np  # noqa: PLC0415

        notify = progress or (lambda _p, _m: None)
        chunk = max(2, int(chunk_frames))
        with s.lock:
            if not s.prompts:
                raise ValueError("Marca al menos un punto antes de propagar")
            size = self.choose_size()
            backend, device, warnings = self._get_backend(size)
            objs = sorted({p.obj_id for p in s.prompts})
            primary = objs[0]
            mask_root = s.out_dir / "masks"
            shutil.rmtree(mask_root, ignore_errors=True)
            boxes: list[tuple[float, float, float, float] | None] = [None] * s.n
            confs = [0.0] * s.n
            written = [False] * s.n
            anchor = min(p.frame for p in s.prompts)
            plan: list[tuple[int, int, bool]] = []  # (start, end, reverse) local, inclusive
            a = anchor
            while True:
                e = min(s.n - 1, a + chunk - 1)
                plan.append((a, e, False))
                if e >= s.n - 1:
                    break
                a = e
            e = anchor
            while e > 0:
                a = max(0, e - chunk + 1)
                plan.append((a, e, True))
                e = a
            total = sum(e - a + 1 for a, e, _r in plan)
            done = 0
            carry: dict[bool, dict[int, Mask]] = {False: {}, True: {}}
            try:
                for a, e, reverse in plan:
                    tmp = s.frames_dir.parent / f"chunk-{a:05d}-{int(reverse)}"
                    _link_frames(s.frames_dir, tmp, list(range(a, e + 1)))
                    try:
                        state = backend.init_state(tmp)
                        boundary = e if reverse else a
                        first = boundary == anchor
                        for obj, m in carry[reverse].items():
                            backend.add_mask(state, boundary - a, obj, m)
                        for p in s.prompts:
                            inside = a <= p.frame <= e
                            if inside and (first or p.frame != boundary):
                                self._apply(backend, state, p, p.frame - a)
                        start = (e - a) if reverse else 0
                        for local, masks in backend.propagate(state, start, reverse):
                            g = a + local
                            union = None
                            for obj, m in masks.items():
                                mb = np.asarray(m, dtype=bool)
                                if mb.ndim == 3:
                                    mb = mb[0]
                                write_png(mask_root / str(obj) / f"{g:05d}.png",
                                          mb.astype(np.uint8) * 255)  # fmt: skip
                                union = mb if union is None else (union | mb)
                                if obj == primary:
                                    box = mask_bbox(mb)
                                    boxes[g] = box
                                    confs[g] = 1.0 if box else 0.0
                                if g == (a if reverse else e):
                                    carry[reverse][obj] = mb
                            if len(objs) > 1 and union is not None:
                                write_png(mask_root / "all" / f"{g:05d}.png",
                                          union.astype(np.uint8) * 255)  # fmt: skip
                            written[g] = True
                            done += 1
                            if done % 5 == 0:
                                notify(min(0.9, done / total * 0.9), f"fotograma {done}/{total}")
                        backend.reset(state)
                    finally:
                        shutil.rmtree(tmp, ignore_errors=True)
                    if device == "cuda":
                        empty_cuda_cache()
            finally:
                self.release_model()
            # frames the predictor never returned (should not happen): empty masks
            empty = np.zeros((s.info.height, s.info.width), dtype=np.uint8)
            for g in range(s.n):
                if not written[g]:
                    for sub in [str(o) for o in objs] + (["all"] if len(objs) > 1 else []):
                        write_png(mask_root / sub / f"{g:05d}.png", empty)
            masks_dir = mask_root / ("all" if len(objs) > 1 else str(primary))
            notify(0.92, "seguimiento")
            track = build_track(
                s.times, boxes, confs, s.info.width, s.info.height,
                fps=s.info.fps_float, method=method, asset_id=s.asset_id,
            )  # fmt: skip
            track_path = track.save(s.out_dir / "track.json")
            result: dict[str, Any] = {
                "masks_dir": self._rel(masks_dir),
                "track": track.payload(),
                "track_path": self._rel(track_path),
                "frames": s.n,
                "fps": round(s.info.fps_float, 6),
                "frame_range": [s.start, s.end],
                "objects": objs,
                "model": f"sam2.1-{size}",
                "device": device,
                "warnings": warnings,
            }
            if alpha:
                notify(0.95, "video con alfa")
                alpha_path = s.out_dir / "alpha.webm"
                masks_to_alpha_webm(
                    s.src, masks_dir / "%05d.png", s.info.fps, alpha_path, s.start, s.end
                )
                result["alpha_path"] = self._rel(alpha_path)
            return result

    def track_box(
        self,
        src: Path,
        *,
        box: tuple[float, float, float, float] | None,
        mask: Mask | None,
        frame_range: tuple[int, int] | None,
        asset_id: str = "",
        progress: Callable[[float, str], None] | None = None,
    ) -> tuple[TrackFile, dict[str, Any]]:
        """Temporary session: box (x0,y0,x1,y1 px) or mask prompt on the first frame."""
        s = self.create(src, frame_range, asset_id)
        try:
            s.prompts.append(Prompt(frame=0, obj_id=1, box=box, mask=mask))
            res = self.propagate(s, alpha=False, progress=progress)
            return TrackFile.model_validate(res["track"]), res
        finally:
            self.delete(s.id)
            shutil.rmtree(s.out_dir, ignore_errors=True)
