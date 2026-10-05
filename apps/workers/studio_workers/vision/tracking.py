"""Object tracking -> TrackFile: OpenCV CSRT (CPU) or SAM 2 masks -> boxes (sam.py).

``opencv-python-headless`` (packs scenes/reframe) has no CSRT/KCF (they live in opencv-contrib);
the chain is CSRT (contrib, main or ``cv2.legacy``) -> normalized cross-correlation template
matching with a slowly refreshed template (more accurate than MIL, the only tracker left in the
headless main module, on our tests: MIL drifted ~15 px in 2 s); ``source.method`` says which ran.
Frames are tracked at <= 960 px (long side) and the boxes scaled back to the source size.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..packs import PackRequiredError, module_present
from .frames import FrameReader, fit_size, frame_times, probe, time_at
from .trackfile import Box, TrackFile, build_track

TRACK_MAX_SIDE = 960


def _factory(cv2: Any, name: str) -> Callable[[], Any] | None:
    for owner in (cv2, getattr(cv2, "legacy", None)):
        if owner is None:
            continue
        fn = getattr(owner, f"Tracker{name}_create", None)
        if fn is not None:
            return fn
        cls = getattr(owner, f"Tracker{name}", None)
        if cls is not None and hasattr(cls, "create"):
            return cls.create
    return None


class TemplateTracker:
    """Fallback: TM_CCOEFF_NORMED inside a search window around the last box."""

    def __init__(self, search: float = 1.5) -> None:
        self.search = search
        self.tpl: Any = None
        self.box: tuple[int, int, int, int] = (0, 0, 0, 0)

    def init(self, frame: Any, box: tuple[int, int, int, int]) -> None:
        x, y, w, h = box
        self.tpl = frame[y : y + h, x : x + w].copy()
        self.box = box

    def update(self, frame: Any) -> tuple[bool, tuple[int, int, int, int]]:
        import cv2  # noqa: PLC0415

        x, y, w, h = self.box
        fh, fw = frame.shape[:2]
        mx, my = int(w * self.search), int(h * self.search)
        x0, y0 = max(0, x - mx), max(0, y - my)
        x1, y1 = min(fw, x + w + mx), min(fh, y + h + my)
        win = frame[y0:y1, x0:x1]
        if win.shape[0] < h or win.shape[1] < w:
            return False, self.box
        res = cv2.matchTemplate(win, self.tpl, cv2.TM_CCOEFF_NORMED)
        _min, score, _minloc, loc = cv2.minMaxLoc(res)
        if score < 0.4:
            return False, self.box
        self.box = (x0 + loc[0], y0 + loc[1], w, h)
        if score > 0.85:  # slow template refresh on confident matches
            self.tpl = cv2.addWeighted(self.tpl, 0.8, frame[self.box[1] : self.box[1] + h,
                                       self.box[0] : self.box[0] + w], 0.2, 0)  # fmt: skip
        return True, self.box


def make_tracker() -> tuple[Any, str]:
    import cv2  # noqa: PLC0415

    fn = _factory(cv2, "CSRT")
    if fn is not None:
        return fn(), "csrt"
    return TemplateTracker(), "template"


def track_opencv(
    path: Path,
    box_px: Box,
    *,
    frame_range: tuple[int, int] | None = None,
    asset_id: str = "",
    smoothing: bool = True,
    progress: Callable[[float, str], None] | None = None,
    tracker: tuple[Any, str] | None = None,
) -> TrackFile:
    if not (module_present("cv2") and module_present("numpy")):
        raise PackRequiredError("reframe")
    notify = progress or (lambda _p, _m: None)
    info = probe(path)
    times = frame_times(path, info)
    last = max(0, info.frames - 1, len(times) - 1)
    a, b = (0, last) if frame_range is None else (max(0, frame_range[0]), frame_range[1])
    size = fit_size(info.width, info.height, TRACK_MAX_SIDE)
    sx, sy = size[0] / info.width, size[1] / info.height
    trk, method = tracker or make_tracker()
    ts: list[float] = []
    boxes: list[Box | None] = []
    confs: list[float] = []
    total = max(1, min(b, last) - a + 1)
    for idx, frame in FrameReader(path, info, pix_fmt="bgr24", size=size, start=a, end=b):
        t = time_at(times, idx, info)
        if not boxes:
            x, y, w, h = box_px
            init = (int(round(x * sx)), int(round(y * sy)),
                    max(2, int(round(w * sx))), max(2, int(round(h * sy))))  # fmt: skip
            trk.init(frame, init)
            ok, cur = True, init
        else:
            ok, cur = trk.update(frame)
        ts.append(t)
        if ok:
            bx, by, bw, bh = (float(v) for v in cur)
            boxes.append((bx / sx, by / sy, bw / sx, bh / sy))
            confs.append(1.0)
        else:
            boxes.append(None)
            confs.append(0.0)
        if len(ts) % 10 == 0:
            notify(min(0.95, len(ts) / total), f"fotograma {len(ts)}/{total}")
    return build_track(
        ts, boxes, confs, info.width, info.height, fps=info.fps_float,
        method=method, asset_id=asset_id, smoothing=smoothing,
    )  # fmt: skip
