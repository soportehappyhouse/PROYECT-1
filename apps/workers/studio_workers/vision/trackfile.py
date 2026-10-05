"""TrackFile (docs/trabajo/sprint2-contratos.md): normalized 0..1 boxes per frame.

``{version: 1, fps, frames: [{t, x, y, w, h, conf}], smoothed, source: {assetId, method}}``
x, y = TOP-LEFT corner of the box, w, h = size; all relative to the source frame (0..1). t in
seconds from the first frame of the source. conf 0..1 (0 = lost: position interpolated or held).
"""

from __future__ import annotations

import bisect
import json
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from .one_euro import TRACK_PARAMS, smooth_zero_lag

LOW_CONF = 0.3


class TrackFrame(BaseModel):
    t: float
    x: float
    y: float
    w: float
    h: float
    conf: float = 1.0


class TrackSource(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    asset_id: str = Field(default="", alias="assetId")
    method: str


class TrackFile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: int = 1
    fps: float
    frames: list[TrackFrame]
    smoothed: bool = False
    source: TrackSource

    def payload(self) -> dict:
        return self.model_dump(by_alias=True)

    def save(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self.payload(), ensure_ascii=False), "utf-8")
        tmp.replace(path)
        return path

    @classmethod
    def load(cls, path: Path) -> TrackFile:
        return cls.model_validate(json.loads(path.read_text("utf-8")))


Box = tuple[float, float, float, float]  # x, y, w, h (pixels or normalized)


def fill_gaps(boxes: Sequence[Box | None], confs: Sequence[float]) -> list[Box | None]:
    """Linear interpolation over frames whose box is missing or below LOW_CONF; edges hold."""
    good = [i for i, b in enumerate(boxes) if b is not None and confs[i] >= LOW_CONF]
    if not good:
        return list(boxes)
    good_set = set(good)
    out: list[Box | None] = list(boxes)
    for i in range(len(out)):
        if i in good_set:
            continue
        pos = bisect.bisect_left(good, i)
        prev = good[pos - 1] if pos > 0 else None
        nxt = good[pos] if pos < len(good) else None
        if prev is None:
            out[i] = boxes[nxt]  # type: ignore[index]
        elif nxt is None:
            out[i] = boxes[prev]
        else:
            a, b = boxes[prev], boxes[nxt]
            assert a is not None and b is not None
            k = (i - prev) / (nxt - prev)
            out[i] = (
                a[0] + (b[0] - a[0]) * k,
                a[1] + (b[1] - a[1]) * k,
                a[2] + (b[2] - a[2]) * k,
                a[3] + (b[3] - a[3]) * k,
            )
    return out


def build_track(
    times: Sequence[float],
    boxes_px: Sequence[Box | None],
    confs: Sequence[float],
    width: int,
    height: int,
    *,
    fps: float,
    method: str,
    asset_id: str = "",
    smoothing: bool = True,
    params: dict[str, float] | None = None,
) -> TrackFile:
    """Pixel boxes per frame -> normalized TrackFile (gaps filled, zero-lag One-Euro smoothing)."""
    filled = fill_gaps(boxes_px, confs)
    rows = [(t, b, c) for t, b, c in zip(times, filled, confs, strict=True) if b is not None]
    if not rows:
        return TrackFile(
            fps=fps,
            frames=[],
            smoothed=smoothing,
            source=TrackSource(asset_id=asset_id, method=method),
        )
    ts = [r[0] for r in rows]
    cx = [(b[0] + b[2] / 2) / width for _, b, _ in rows]
    cy = [(b[1] + b[3] / 2) / height for _, b, _ in rows]
    ws = [b[2] / width for _, b, _ in rows]
    hs = [b[3] / height for _, b, _ in rows]
    if smoothing:
        p = {**TRACK_PARAMS, **(params or {})}
        # Offline (whole clip): forward-backward One-Euro, no lag behind the object.
        cx, cy = smooth_zero_lag(ts, cx, **p), smooth_zero_lag(ts, cy, **p)
        size_p = {**p, "beta": p["beta"] * 0.5}
        ws, hs = smooth_zero_lag(ts, ws, **size_p), smooth_zero_lag(ts, hs, **size_p)
    frames: list[TrackFrame] = []
    for i, (t, _b, c) in enumerate(rows):
        w = min(1.0, max(0.0, ws[i]))
        h = min(1.0, max(0.0, hs[i]))
        x = min(1.0 - w, max(0.0, cx[i] - w / 2))
        y = min(1.0 - h, max(0.0, cy[i] - h / 2))
        frames.append(
            TrackFrame(
                t=round(t, 4), x=round(x, 5), y=round(y, 5), w=round(w, 5), h=round(h, 5),
                conf=round(float(c), 3),
            )
        )  # fmt: skip
    return TrackFile(
        fps=round(fps, 6),
        frames=frames,
        smoothed=smoothing,
        source=TrackSource(asset_id=asset_id, method=method),
    )
