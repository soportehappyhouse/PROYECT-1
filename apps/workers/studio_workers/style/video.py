"""Video side of the style analysis: probe, cuts, shot stats, motion heuristics, contact sheet.

Everything runs on FFmpeg + the standard library (no numpy/OpenCV needed), so it works on a
core install; PySceneDetect is used for the cuts only when the ``scenes`` pack is installed.

Motion heuristic (documented in docs/trabajo/modulo-sprint3b-estilo.md): FFmpeg samples the video
at ``MOTION_FPS`` as tiny gray frames (``MOTION_W`` x ``MOTION_H``). For every consecutive pair
inside a shot we search the camera move that best explains the second frame from the first:
shift (dx, dy in pixels, pan/tilt) and scale (zoom about the center), nearest-neighbour sampling,
mean absolute difference over the central region. A pair is

- *static* when the plain difference is below ``STATIC_ERR`` gray levels;
- a *pan* / *zoom* step when the best move explains it (error < ``EXPLAINED`` x the plain one);
- a *content change* otherwise (people moving, new content): ignored.

Consecutive zoom steps in one direction make a ``zoom_in`` / ``zoom_out`` event (total scale
>= ``ZOOM_EVENT_MIN``). At each cut, if the frame after is the frame before scaled up 1.1-1.45x,
the cut is a *punch-in* (same shot, closer). It is a heuristic: handheld shake reads as pan,
fast action as content change. Good enough to tell "static talking head" from "zoom every few
seconds" in a reference.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from pathlib import Path
from statistics import median
from typing import Any

from ..packs import module_present
from ..vision.frames import ffmpeg_exe, ffprobe_exe

SCENE_THRESHOLD = 0.3  # FFmpeg scene score (0-1) for a hard cut in the fallback detector
MIN_SCENE_S = 0.4
HISTOGRAM_EDGES = (1.0, 2.0, 4.0, 8.0, 15.0)

MOTION_FPS = 3
MOTION_W, MOTION_H = 40, 22
STATIC_ERR = 2.0
EXPLAINED = 0.8
SHIFTS = range(-2, 3)
STEP_SCALES = (0.91, 0.95, 0.97, 1.03, 1.05, 1.1)
PUNCH_SCALES = (1.1, 1.2, 1.3, 1.45)
ZOOM_EVENT_MIN = 1.05


# ----------------------------------------------------------------------------------- probe


def probe_media(path: Path) -> dict[str, Any]:
    """{width, height, fps, frames, duration, has_video, has_audio} (ffprobe, all streams)."""
    out = subprocess.run(
        [ffprobe_exe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    if out.returncode != 0:
        raise ValueError(f"No se pudo leer el video: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise ValueError(f"El archivo no tiene video: {path.name}")
    w, h = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = 0
    for sd in video.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    rotation = int((video.get("tags") or {}).get("rotate", rotation) or 0)
    if abs(rotation) % 180 == 90:
        w, h = h, w
    fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")) or 25.0
    if fps > 240:
        fps = _rate(video.get("r_frame_rate")) or 25.0
    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or video.get("duration") or 0.0)
    frames = int(video.get("nb_frames") or 0) or max(1, round(duration * fps))
    return {
        "width": w,
        "height": h,
        "fps": round(fps, 3),
        "frames": frames,
        "duration": round(duration, 3),
        "has_video": True,
        "has_audio": audio is not None,
    }


def _rate(value: Any) -> float | None:
    try:
        num, _, den = str(value or "0").partition("/")
        r = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return r if r > 0 else None


def aspect_label(w: int, h: int) -> str:
    """'16:9' | '9:16' | '1:1' | '4:5' | 'W:H' (reduced)."""
    if not w or not h:
        return "?"
    r = w / h
    for label, value in (("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0), ("4:5", 0.8)):
        if abs(r - value) < 0.02:
            return label
    g = math.gcd(w, h)
    return f"{w // g}:{h // g}"


# ------------------------------------------------------------------------------------ cuts

_PTS = re.compile(r"pts_time:([\d.]+)")
_SCORE = re.compile(r"lavfi\.scene_score=([\d.]+)")


def parse_scene_metadata(text: str) -> list[tuple[float, float]]:
    """(t, score) pairs out of ``select=gt(scene,…),metadata=print`` output."""
    out: list[tuple[float, float]] = []
    t: float | None = None
    for line in text.splitlines():
        if m := _PTS.search(line):
            t = float(m.group(1))
        elif (m := _SCORE.search(line)) and t is not None:
            out.append((t, float(m.group(1))))
            t = None
    return out


def ffmpeg_scene_cuts(path: Path, threshold: float = SCENE_THRESHOLD) -> list[float]:
    """Cut times from FFmpeg's scene-change score on a 320 px copy (fallback detector)."""
    proc = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-nostats", "-loglevel", "error", "-i", str(path), "-an",
         "-vf", f"scale=320:-2,select='gt(scene\\,{threshold})',metadata=print:file=-",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )  # fmt: skip
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg (escenas) falló: {proc.stderr.strip()[-400:]}")
    return [t for t, _ in parse_scene_metadata(proc.stdout)]


def scenes_from_cuts(cuts: list[float], duration: float) -> list[dict[str, float]]:
    """[{start, end}] from cut times; cuts closer than MIN_SCENE_S to the previous one merge."""
    bounds = [0.0]
    for c in sorted(cuts):
        if MIN_SCENE_S <= c < duration - MIN_SCENE_S / 2 and c - bounds[-1] >= MIN_SCENE_S:
            bounds.append(round(c, 3))
    bounds.append(round(duration, 3))
    return [{"start": a, "end": b} for a, b in zip(bounds, bounds[1:], strict=False) if b > a]


def detect_cuts(path: Path, duration: float) -> tuple[list[dict[str, float]], str]:
    """Scenes + method: PySceneDetect when the ``scenes`` pack is installed, else FFmpeg."""
    if module_present("scenedetect") and module_present("cv2"):
        from ..analyze import detect_scenes  # noqa: PLC0415

        raw = detect_scenes(path)["scenes"]
        cuts = [float(s["start"]) for s in raw if float(s["start"]) > 0]
        return scenes_from_cuts(cuts, duration), "scenedetect"
    return scenes_from_cuts(ffmpeg_scene_cuts(path), duration), "ffmpeg"


def shot_stats(scenes: list[dict[str, float]], duration: float) -> dict[str, Any]:
    lengths = [s["end"] - s["start"] for s in scenes] or [duration]
    edges = [*HISTOGRAM_EDGES, None]
    histogram = []
    lo = 0.0
    for edge in edges:
        n = sum(1 for x in lengths if x >= lo and (edge is None or x < edge))
        histogram.append({"max_s": edge, "count": n})
        lo = edge or lo
    cuts = max(0, len(scenes) - 1)
    return {
        "count": len(scenes),
        "mean_s": round(sum(lengths) / len(lengths), 3),
        "median_s": round(median(lengths), 3),
        "cuts_per_min": round(cuts / duration * 60, 2) if duration > 0 else 0.0,
        "histogram": histogram,
    }


# ---------------------------------------------------------------------------------- motion


def gray_frames(path: Path, fps: int = MOTION_FPS) -> list[bytes]:
    """Tiny gray frames (MOTION_W x MOTION_H) sampled at ``fps``; frame i is at t = i / fps."""
    size = MOTION_W * MOTION_H
    proc = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-an",
         "-vf", f"fps={fps},scale={MOTION_W}:{MOTION_H}:flags=area,format=gray",
         "-f", "rawvideo", "-"],
        capture_output=True, timeout=1800,
    )  # fmt: skip
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")[-300:]
        raise RuntimeError(f"ffmpeg (movimiento) falló: {err}")
    data = proc.stdout
    return [data[i : i + size] for i in range(0, len(data) - size + 1, size)]


_REGION = [
    (x, y)
    for y in range(MOTION_H // 5, MOTION_H - MOTION_H // 5)
    for x in range(MOTION_W // 6, MOTION_W - MOTION_W // 6)
]
_CX, _CY = (MOTION_W - 1) / 2, (MOTION_H - 1) / 2


def move_error(a: bytes, b: bytes, scale: float, dx: int, dy: int) -> float:
    """Mean |b - warp(a)| over the central region; warp = zoom ``scale`` about the center, then
    shift (dx, dy). b(x) ~ a(c + (x - c) / scale - d)."""
    total = 0
    w, h = MOTION_W, MOTION_H
    inv = 1.0 / scale
    for x, y in _REGION:
        sx = int(round(_CX + (x - _CX) * inv - dx))
        sy = int(round(_CY + (y - _CY) * inv - dy))
        sx = 0 if sx < 0 else (w - 1 if sx >= w else sx)
        sy = 0 if sy < 0 else (h - 1 if sy >= h else sy)
        total += abs(b[y * w + x] - a[sy * w + sx])
    return total / len(_REGION)


def best_move(
    a: bytes, b: bytes, scales: tuple[float, ...] = STEP_SCALES
) -> tuple[str, float, int, int, float, float]:
    """(kind, scale, dx, dy, best_error, plain_error); kind static | pan | zoom | change."""
    e0 = move_error(a, b, 1.0, 0, 0)
    if e0 < STATIC_ERR:
        return "static", 1.0, 0, 0, e0, e0
    best = (e0, 1.0, 0, 0)
    for dx in SHIFTS:
        for dy in SHIFTS:
            if dx or dy:
                e = move_error(a, b, 1.0, dx, dy)
                if e < best[0]:
                    best = (e, 1.0, dx, dy)
    for s in scales:
        for dx, dy in dict.fromkeys([(0, 0), (best[2], best[3])]):
            e = move_error(a, b, s, dx, dy)
            if e < best[0]:
                best = (e, s, dx, dy)
    if best[1] != 1.0:  # refine the shift at the chosen scale
        _e, s, bx, by = best
        for dx in (bx - 1, bx, bx + 1):
            for dy in (by - 1, by, by + 1):
                e = move_error(a, b, s, dx, dy)
                if e < best[0]:
                    best = (e, s, dx, dy)
    err, s, dx, dy = best
    if err > EXPLAINED * e0:
        return "change", 1.0, 0, 0, err, e0
    return ("zoom" if s != 1.0 else "pan"), s, dx, dy, err, e0


def analyze_motion(
    frames: list[bytes], scenes: list[dict[str, float]], fps: int = MOTION_FPS
) -> dict[str, Any]:
    """zoom_events + pan_estimate out of the sampled frames (see module doc)."""
    cuts = [s["start"] for s in scenes[1:]]

    def shot_of(t: float) -> int:
        return sum(1 for c in cuts if c <= t)

    events: list[dict[str, Any]] = []
    pairs = moving = 0
    speed_sum = 0.0
    run: tuple[str, float, float] | None = None  # (kind, start t, product)

    def close_run() -> None:
        nonlocal run
        if run is not None:
            kind, t0, prod = run
            if prod >= ZOOM_EVENT_MIN or prod <= 1 / ZOOM_EVENT_MIN:
                events.append({"t": round(t0, 2), "kind": kind, "scale": round(prod, 3)})
        run = None

    for i in range(len(frames) - 1):
        t_a, t_b = i / fps, (i + 1) / fps
        if shot_of(t_a) != shot_of(t_b):
            close_run()
            continue
        kind, s, dx, dy, _err, _e0 = best_move(frames[i], frames[i + 1])
        pairs += 1
        if kind == "change" or (kind == "zoom" and s >= STEP_SCALES[-1]):
            # A jump the small steps cannot explain: a punch-in inside what reads as one shot?
            pk, ps, *_r, perr, pe0 = best_move(frames[i], frames[i + 1], PUNCH_SCALES)
            if pk == "zoom" and ps > STEP_SCALES[-1] and perr < 0.5 * pe0:
                close_run()
                t_mid = (t_a + t_b) / 2
                events.append({"t": round(t_mid, 2), "kind": "punch_in", "scale": round(ps, 3)})
                continue
        if kind in ("pan", "zoom"):
            moving += 1
            speed_sum += math.hypot(dx, dy) / MOTION_W * fps
        if kind == "zoom":
            zk = "zoom_in" if s > 1 else "zoom_out"
            if run is not None and run[0] == zk:
                run = (zk, run[1], run[2] * s)
            else:
                close_run()
                run = (zk, t_a, s)
        else:
            close_run()
    close_run()

    for c in cuts:  # punch-in: the shot after the cut is the shot before, closer
        before = int(math.floor(c * fps - 0.15))
        after = int(math.ceil(c * fps + 0.15))
        if before < 0 or after >= len(frames):
            continue
        kind, s, *_rest, err, e0 = best_move(frames[before], frames[after], PUNCH_SCALES)
        if kind == "zoom" and s > 1 and err < 0.5 * e0:
            events.append({"t": round(c, 2), "kind": "punch_in", "scale": round(s, 3)})

    ratio = moving / pairs if pairs else 0.0
    speed = speed_sum / pairs if pairs else 0.0
    level = "static" if ratio < 0.15 else ("high" if ratio > 0.5 or speed > 0.15 else "low")
    return {
        "zoom_events": sorted(events, key=lambda e: (e["t"], e["kind"])),
        "pan_estimate": {
            "moving_ratio": round(ratio, 3),
            "mean_speed": round(speed, 4),
            "level": level,
        },
        "method": f"frame-diff-heuristic ({MOTION_W}x{MOTION_H} gris a {fps} fps)",
    }


# --------------------------------------------------------------------------- contact sheet

SHEET_COLUMNS, SHEET_ROWS = 4, 6
TILE_BOX = 320  # each tile fits in 320 x 320 (16:9 -> 320x180, 9:16 -> 180x320)
THUMB_BOX = 640
SHEET_PADDING = 4
SHEET_MARGIN = 4


def frame_indices(frames: int, count: int) -> list[int]:
    """`count` evenly spaced frame numbers (centers of equal slices), unique, ascending."""
    if frames <= 0:
        return []
    picks = sorted({min(frames - 1, int((i + 0.5) * frames / count)) for i in range(count)})
    return picks


def tile_size(w: int, h: int, box: int = TILE_BOX) -> tuple[int, int]:
    """Size FFmpeg gives a w x h frame with scale=box:box:force_original_aspect_ratio=decrease,
    rounded down to even numbers."""
    if not w or not h:
        return box, box
    f = min(box / w, box / h)
    tw, th = max(2, int(w * f)), max(2, int(h * f))
    return tw - tw % 2, th - th % 2


def sheet_size(tw: int, th: int) -> tuple[int, int]:
    """Size of the tile=4x6 sheet (FFmpeg tile: margin around, padding between)."""
    return (
        SHEET_COLUMNS * tw + (SHEET_COLUMNS - 1) * SHEET_PADDING + 2 * SHEET_MARGIN,
        SHEET_ROWS * th + (SHEET_ROWS - 1) * SHEET_PADDING + 2 * SHEET_MARGIN,
    )


def _font_option() -> str:
    """drawtext font: Arial on Windows (FFmpeg builds there may lack a fontconfig default)."""
    if os.name == "nt":
        for name in ("arial.ttf", "segoeui.ttf"):
            f = Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts" / name
            if f.is_file():
                p = f.as_posix().replace(":", "\\:")
                return f"fontfile='{p}':"
    return ""


def build_contact_sheet(
    path: Path, out_dir: Path, info: dict[str, Any], count: int = SHEET_COLUMNS * SHEET_ROWS
) -> dict[str, Any]:
    """contact_sheet.png (4x6, timestamps burned with drawtext) + thumbs/thumb_NN.jpg (640 px)
    in ONE FFmpeg pass (select by frame number -> split -> tile / image2)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir = out_dir / "thumbs"
    thumbs_dir.mkdir(exist_ok=True)
    for old in thumbs_dir.glob("thumb_*.jpg"):
        old.unlink()
    fps = float(info["fps"]) or 25.0
    picks = frame_indices(int(info["frames"]), count)
    if not picks:
        raise ValueError("El video no tiene cuadros para la hoja de contactos")
    expr = "+".join(f"eq(n\\,{n})" for n in picks)
    tw, th = tile_size(int(info["width"]), int(info["height"]))
    size = max(12, th // 9)
    stamp = (
        f",drawtext={_font_option()}text='%{{pts\\:hms}}':fontcolor=white:fontsize={size}"
        f":box=1:boxcolor=black@0.6:boxborderw=3:x=5:y=h-th-5"
    )
    sheet = out_dir / "contact_sheet.png"
    warnings: list[str] = []

    def run(with_text: bool) -> subprocess.CompletedProcess[str]:
        graph = (
            f"[0:v]select='{expr}',scale={THUMB_BOX}:{THUMB_BOX}:force_original_aspect_ratio="
            f"decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,split=2[a][b];"
            f"[a]scale={tw}:{th}{stamp if with_text else ''},"
            f"tile={SHEET_COLUMNS}x{SHEET_ROWS}:padding={SHEET_PADDING}:margin={SHEET_MARGIN}"
            f":color=0x111111[sheet]"
        )
        return subprocess.run(
            [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-an",
             "-filter_complex", graph, "-map", "[sheet]", "-frames:v", "1", str(sheet),
             "-map", "[b]", "-fps_mode", "vfr", "-q:v", "3", str(thumbs_dir / "thumb_%02d.jpg")],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
        )  # fmt: skip

    proc = run(True)
    if proc.returncode != 0 or not sheet.is_file():
        # drawtext missing (FFmpeg without libfreetype) or no usable font: sheet without stamps.
        warnings.append("contact_sheet_without_timestamps")
        proc = run(False)
        if proc.returncode != 0 or not sheet.is_file():
            raise RuntimeError(f"ffmpeg (hoja de contactos) falló: {proc.stderr.strip()[-400:]}")
    thumbs = sorted(thumbs_dir.glob("thumb_*.jpg"))
    times = [round(n / fps, 3) for n in picks][: len(thumbs)]
    sw, sh = sheet_size(tw, th)
    return {
        "path": sheet,
        "thumbnails": thumbs,
        "times": times,
        "columns": SHEET_COLUMNS,
        "rows": SHEET_ROWS,
        "width": sw,
        "height": sh,
        "timestamps": not warnings,
        "warnings": warnings,
    }
