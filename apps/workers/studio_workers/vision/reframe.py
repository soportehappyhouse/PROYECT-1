"""Auto-reframe 16:9 -> 9:16 / 1:1 / 4:5 (docs/INVESTIGACION-IA-LOCAL.md §5, AutoFlip-like).

Per scene (cuts from the request, else PySceneDetect when the scenes pack is installed, else the
whole video): faces with YuNet (``cv2.FaceDetectorYN``, CPU, ~8 detections/s at 640 px) or the
boxes of a TrackFile; the subject is the biggest face, preferring the one near the previous pick;
frames without a subject hold the last position; a scene without any subject is centered.
The crop center goes through One-Euro -> dead zone (4 % of the width) -> max pan speed, clamped
inside the frame, then Ramer-Douglas-Peucker keeps a few keyframes.

Output keyframes (shared ``Keyframe``): ``{t, v: {x, y, w, h}, ease}`` with the crop in PERCENT
(0..100) of the source frame, t in seconds from the source start. The last keyframe of each scene
has ``ease: "hold"`` so the crop jumps at the cut instead of sweeping across it.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .one_euro import REFRAME_PARAMS, deadzone, limit_speed, rdp, smooth

TARGETS = {"9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5)}
DEADZONE = 0.04  # fraction of the source size on the moving axis (§5: ~5 %)
MAX_PAN_PER_S = 0.6  # fraction of the source size per second
RDP_EPS = 0.004
DETECT_PER_S = 8.0
DETECT_WIDTH = 640
YUNET_FILE = "face_detection_yunet_2023mar.onnx"

FaceBox = tuple[float, float, float, float, float]  # x, y, w, h (px), score
Sample = tuple[float, list[FaceBox]]  # (t, candidates)


def yunet_path(root: Path) -> Path:
    return root / "yunet" / YUNET_FILE


@dataclass(frozen=True)
class Crop:
    w: int
    h: int
    axis: str  # "x" | "y" | "none"


def crop_size(width: int, height: int, target: str) -> Crop:
    tw, th = TARGETS[target]
    aspect = tw / th
    if width / height > aspect + 1e-6:
        w = min(width, int(round(height * aspect / 2)) * 2)
        return Crop(w, height, "x")
    if width / height < aspect - 1e-6:
        h = min(height, int(round(width / aspect / 2)) * 2)
        return Crop(width, h, "y")
    return Crop(width, height, "none")


def _pick(cands: list[FaceBox], prev: float | None, axis: str, w: int, h: int) -> float | None:
    """Normalized subject center on the moving axis."""
    best, best_score = None, -1.0
    for x, y, bw, bh, score in cands:
        c = (x + bw / 2) / w if axis == "x" else (y + bh / 2) / h
        s = bw * bh * max(score, 0.05)
        if prev is not None:
            s /= 1.0 + 4.0 * abs(c - prev)
        if s > best_score:
            best, best_score = c, s
    if best is not None and axis == "y":
        # vertical crops: keep the face in the upper third rather than dead center
        best = best + 0.12
    return best


def plan_reframe(
    samples: Sequence[Sample],
    *,
    width: int,
    height: int,
    target: str,
    duration: float,
    scenes: Sequence[tuple[float, float]] | None = None,
    subject: str = "face",
    fps: float = 30.0,
) -> dict[str, Any]:
    """Pure function (tests inject detector results): samples -> crop keyframes per scene."""
    crop = crop_size(width, height, target)
    span = crop.w / width if crop.axis == "x" else crop.h / height
    lo, hi = span / 2, 1 - span / 2
    pct = {
        "w": round(crop.w / width * 100, 4),
        "h": round(crop.h / height * 100, 4),
    }
    scene_list = list(scenes) if scenes else [(0.0, duration)]
    keyframes: list[dict[str, Any]] = []
    per_scene: list[dict[str, Any]] = []
    frame = 1.0 / fps if fps > 0 else 1 / 30
    ordered = sorted(samples, key=lambda s: s[0])

    def value(c: float) -> dict[str, float]:
        c = min(hi, max(lo, c)) if crop.axis != "none" else 0.5
        if crop.axis == "x":
            return {"x": round((c - span / 2) * 100, 4), "y": 0.0, **pct}
        if crop.axis == "y":
            return {"x": 0.0, "y": round((c - span / 2) * 100, 4), **pct}
        return {"x": 0.0, "y": 0.0, **pct}

    for si, (start, end) in enumerate(scene_list):
        last_scene = si == len(scene_list) - 1
        inside = [s for s in ordered if start <= s[0] < end or (last_scene and s[0] == end)]
        ts: list[float] = []
        cs: list[float | None] = []
        prev: float | None = None
        hits = 0
        for t, cands in inside:
            c = _pick(cands, prev, crop.axis, width, height) if crop.axis != "none" else None
            if c is not None:
                hits += 1
                prev = c
            ts.append(t)
            cs.append(c)
        info: dict[str, Any] = {
            "start": round(start, 4),
            "end": round(end, 4),
            "samples": len(ts),
            "detections": hits,
            "subject": subject if hits else "center",
            "fallback": None if hits else "center",
        }
        if not hits or crop.axis == "none":
            series_t, series_c = [start], [0.5]
        else:
            first = next(c for c in cs if c is not None)
            held: list[float] = []
            cur = first
            for c in cs:
                cur = c if c is not None else cur
                held.append(cur)
            series_t = [start, *ts] if not ts or ts[0] > start else list(ts)
            series_c = [held[0], *held] if len(series_t) > len(held) else held
            series_c = smooth(series_t, series_c, **REFRAME_PARAMS)
            series_c = deadzone(series_c, DEADZONE)
            series_c = limit_speed(series_t, series_c, MAX_PAN_PER_S)
            series_c = [min(hi, max(lo, c)) for c in series_c]
        end_t = max(series_t[-1], end - frame) if not last_scene else max(series_t[-1], end)
        if end_t > series_t[-1]:
            series_t = [*series_t, end_t]
            series_c = [*series_c, series_c[-1]]
        keep = rdp(list(zip(series_t, series_c, strict=True)), RDP_EPS)
        kfs = [
            {"t": round(series_t[i], 4), "v": value(series_c[i]), "ease": "linear"} for i in keep
        ]
        kfs[-1]["ease"] = "hold"
        info["keyframes"] = len(kfs)
        keyframes.extend(kfs)
        per_scene.append(info)
    return {
        "keyframes": keyframes,
        "per_scene": per_scene,
        "target": target,
        "crop_px": {"w": crop.w, "h": crop.h},
        "axis": crop.axis,
    }


# ------------------------------------------------------------------------------- detection


class YuNetDetector:
    def __init__(self, model: Path, score: float = 0.6) -> None:
        import cv2  # noqa: PLC0415

        self.det = cv2.FaceDetectorYN.create(str(model), "", (320, 320), score, 0.3, 5000)
        self._size: tuple[int, int] | None = None

    def __call__(self, bgr: Any) -> list[FaceBox]:
        h, w = bgr.shape[:2]
        if self._size != (w, h):
            self.det.setInputSize((w, h))
            self._size = (w, h)
        _, faces = self.det.detect(bgr)
        if faces is None:
            return []
        return [(float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])) for f in faces]


Detector = Callable[[Any], list[FaceBox]]


def detect_samples(
    path: Path,
    detector: Detector,
    *,
    per_second: float = DETECT_PER_S,
    progress: Callable[[float, str], None] | None = None,
) -> tuple[list[Sample], Any]:
    """Run the detector every N frames at 640 px; boxes scaled back to source pixels."""
    from .frames import FrameReader, fit_size, frame_times, probe, time_at  # noqa: PLC0415

    notify = progress or (lambda _p, _m: None)
    info = probe(path)
    times = frame_times(path, info)
    every = max(1, int(round(info.fps_float / per_second)))
    size = fit_size(info.width, info.height, DETECT_WIDTH)
    sx, sy = info.width / size[0], info.height / size[1]
    samples: list[Sample] = []
    total = max(1, math.ceil(info.frames / every))
    reader = FrameReader(path, info, pix_fmt="bgr24", size=size, every=every)
    for idx, frame in reader:
        faces = [(x * sx, y * sy, w * sx, h * sy, s) for x, y, w, h, s in detector(frame)]
        samples.append((time_at(times, idx, info), faces))
        if len(samples) % 10 == 0:
            notify(min(0.9, len(samples) / total * 0.9), f"analizando {len(samples)}/{total}")
    return samples, info


def samples_from_track(track: dict[str, Any], width: int, height: int) -> list[Sample]:
    out: list[Sample] = []
    for f in track.get("frames") or []:
        conf = float(f.get("conf", 1.0))
        box = (f["x"] * width, f["y"] * height, f["w"] * width, f["h"] * height, conf)
        out.append((float(f["t"]), [box] if conf >= 0.3 else []))
    return out
