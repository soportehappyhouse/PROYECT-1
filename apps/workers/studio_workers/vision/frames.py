"""FFmpeg frame I/O for the vision features (numpy arrays; no OpenCV/PIL needed).

- ``probe()``: size (after the rotation FFmpeg applies on decode), exact fps (Fraction), frames.
- ``frame_times()``: presentation time of every frame from the packet pts (no decoding), so a VFR
  source keeps exact timestamps; CFR fallback ``i * den / num``. t is relative to the first frame.
- ``FrameReader``: rawvideo pipe -> numpy frames (``-fps_mode passthrough``: one output frame per
  decoded frame, never duplicated/dropped), optional scale and frame range (``select`` by index).
- ``AlphaWriter`` / ``ChunkedAlphaWriter``: RGBA frames -> WebM VP9 ``yuva420p`` (one segment per
  chunk, joined with the concat demuxer ``-c copy``: the alpha side data survives, checked by test).
- PNG: ``write_png`` (pure zlib encoder, gray or RGBA), ``read_gray`` (decoded by FFmpeg).
"""

from __future__ import annotations

import contextlib
import json
import shutil
import struct
import subprocess
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from ..media import FfmpegNotFoundError, find_ffmpeg
from ..tasks import kill_process_tree, on_cancel_kill

_VP9_ARGS = [
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
]  # fmt: skip


def ffmpeg_exe() -> str:
    exe = find_ffmpeg()
    if not exe:
        raise FfmpegNotFoundError(
            "ffmpeg no encontrado: instalalo (setup.ps1) o defini FFMPEG_PATH en .env"
        )
    return exe


def ffprobe_exe() -> str:
    ff = Path(ffmpeg_exe())
    for name in ("ffprobe.exe", "ffprobe"):
        cand = ff.with_name(name)
        if cand.is_file():
            return str(cand)
    found = shutil.which("ffprobe")
    if not found:
        raise FfmpegNotFoundError("ffprobe no encontrado (viene con FFmpeg)")
    return found


def vp9_args() -> list[str]:
    return list(_VP9_ARGS)


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: Fraction
    frames: int
    duration: float
    is_image: bool = False

    @property
    def fps_float(self) -> float:
        return float(self.fps)

    @property
    def fps_str(self) -> str:
        return f"{self.fps.numerator}/{self.fps.denominator}"


def _fraction(value: str | None) -> Fraction | None:
    try:
        f = Fraction(value or "0")
    except (ValueError, ZeroDivisionError):
        return None
    return f if f > 0 else None


def probe(path: Path) -> VideoInfo:
    out = subprocess.run(
        [
            ffprobe_exe(), "-v", "error", "-select_streams", "v:0", "-show_streams",
            "-show_format", "-of", "json", str(path),
        ],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    if out.returncode != 0:
        raise ValueError(f"No se pudo leer el video: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise ValueError(f"El archivo no tiene video: {path.name}")
    st: dict[str, Any] = streams[0]
    w, h = int(st.get("width") or 0), int(st.get("height") or 0)
    rotation = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    rotation = int((st.get("tags") or {}).get("rotate", rotation) or 0)
    if abs(rotation) % 180 == 90:
        w, h = h, w
    fmt = data.get("format") or {}
    fmt_name = str(fmt.get("format_name") or "")
    is_image = fmt_name == "image2" or fmt_name.endswith("_pipe")
    fps = _fraction(st.get("avg_frame_rate")) or _fraction(st.get("r_frame_rate")) or Fraction(25)
    if fps > 240:  # bogus avg rate (e.g. 90000/1 on some MKV): use r_frame_rate
        fps = _fraction(st.get("r_frame_rate")) or Fraction(25)
    duration = float(st.get("duration") or fmt.get("duration") or 0.0)
    frames = int(st.get("nb_frames") or 0) or (1 if is_image else round(duration * float(fps)))
    return VideoInfo(w, h, fps, max(1, frames), duration, bool(is_image))


def frame_times(path: Path, info: VideoInfo) -> list[float]:
    """Presentation time (s, first frame = 0) of every frame, from the sorted packet pts."""
    try:
        out = subprocess.run(
            [
                ffprobe_exe(), "-v", "error", "-select_streams", "v:0",
                "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path),
            ],
            capture_output=True, text=True, timeout=600,
        )  # fmt: skip
        pts = sorted(float(x) for x in out.stdout.split() if x and x != "N/A")
    except (OSError, subprocess.SubprocessError, ValueError):
        pts = []
    if len(pts) >= max(1, info.frames - 1):
        t0 = pts[0]
        return [round(p - t0, 6) for p in pts]
    step = info.fps.denominator / info.fps.numerator
    return [round(i * step, 6) for i in range(info.frames)]


def time_at(times: list[float], index: int, info: VideoInfo) -> float:
    if 0 <= index < len(times):
        return times[index]
    return round(index * info.fps.denominator / info.fps.numerator, 6)


_CHANNELS = {"rgb24": 3, "bgr24": 3, "gray": 1, "rgba": 4}


class FrameReader:
    """Iterate (index, frame) over a video (index = source frame number)."""

    def __init__(
        self,
        path: Path,
        info: VideoInfo,
        *,
        pix_fmt: str = "rgb24",
        size: tuple[int, int] | None = None,
        start: int = 0,
        end: int | None = None,
        every: int = 1,
    ) -> None:
        self.path = path
        self.every = max(1, every)
        self.info = info
        self.pix_fmt = pix_fmt
        self.size = size or (info.width, info.height)
        self.start = max(0, start)
        self.end = end
        self._proc: subprocess.Popen[bytes] | None = None
        self._eof = False

    def _cmd(self) -> list[str]:
        filters: list[str] = []
        conds: list[str] = []
        if self.start or self.end is not None:
            end = self.end if self.end is not None else 10**9
            conds.append(f"between(n\\,{self.start}\\,{end})")
        if self.every > 1:
            conds.append(f"not(mod(n-{self.start}\\,{self.every}))")
        if conds:
            filters.append(f"select='{'*'.join(conds)}'")
        if self.size != (self.info.width, self.info.height):
            filters.append(f"scale={self.size[0]}:{self.size[1]}:flags=area")
        cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(self.path)]
        if filters:
            cmd += ["-vf", ",".join(filters)]
        return [*cmd, "-fps_mode", "passthrough", "-an", "-f", "rawvideo",
                "-pix_fmt", self.pix_fmt, "-"]  # fmt: skip

    def __iter__(self) -> Iterator[tuple[int, Any]]:
        import numpy as np  # noqa: PLC0415

        w, h = self.size
        ch = _CHANNELS[self.pix_fmt]
        nbytes = w * h * ch
        self._proc = subprocess.Popen(  # noqa: S603 - fixed argv
            self._cmd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        on_cancel_kill(self._proc)  # a canceled task kills ffmpeg (the read then hits EOF)
        assert self._proc.stdout is not None
        index = self.start
        try:
            while True:
                buf = self._proc.stdout.read(nbytes)
                if not buf or len(buf) < nbytes:
                    self._eof = True
                    break
                arr = np.frombuffer(buf, dtype=np.uint8)
                yield index, (arr.reshape(h, w) if ch == 1 else arr.reshape(h, w, ch))
                index += self.every
                if self.end is not None and index > self.end:
                    break
        finally:
            self.close()

    def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        killed = not self._eof and proc.poll() is None
        if killed:
            kill_process_tree(proc)
        err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        proc.wait()
        if not killed and proc.returncode != 0:
            raise RuntimeError(f"ffmpeg (lectura) fallo: {err.strip()[-300:]}")


def fit_size(w: int, h: int, max_side: int) -> tuple[int, int]:
    """Scale (w, h) so the longest side is <= max_side (even numbers)."""
    scale = min(1.0, max_side / max(w, h))
    return max(2, int(w * scale) // 2 * 2), max(2, int(h * scale) // 2 * 2)


# ------------------------------------------------------------------------------- alpha WebM


class AlphaWriter:
    """RGBA frames (numpy HxWx4 uint8) -> WebM VP9 yuva420p through an ffmpeg pipe."""

    def __init__(self, out: Path, width: int, height: int, fps: Fraction) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        self.out = out
        self.count = 0
        cmd = [
            ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}",
            "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", "-",
            *_VP9_ARGS, "-an", str(out),
        ]  # fmt: skip
        self._proc = subprocess.Popen(  # noqa: S603
            cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE
        )
        on_cancel_kill(self._proc)

    def write(self, rgba: Any) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(memoryview(rgba).cast("B") if hasattr(rgba, "shape") else rgba)
        self.count += 1

    def close(self) -> Path:
        assert self._proc.stdin is not None
        self._proc.stdin.close()
        err = self._proc.stderr.read().decode("utf-8", "replace") if self._proc.stderr else ""
        if self._proc.wait() != 0:
            raise RuntimeError(f"ffmpeg (WebM alfa) fallo: {err.strip()[-300:]}")
        return self.out

    def abort(self) -> None:
        kill_process_tree(self._proc)
        for pipe in (self._proc.stdin, self._proc.stderr):
            if pipe is not None:
                with contextlib.suppress(OSError):
                    pipe.close()


class ChunkedAlphaWriter:
    """One WebM segment per ``chunk`` frames in work_dir; ``finish()`` concatenates (-c copy)."""

    def __init__(
        self, work_dir: Path, width: int, height: int, fps: Fraction, chunk: int = 300
    ) -> None:
        self.work_dir = work_dir
        self.size = (width, height)
        self.fps = fps
        self.chunk = max(1, chunk)
        self.segments: list[Path] = []
        self._cur: AlphaWriter | None = None
        work_dir.mkdir(parents=True, exist_ok=True)

    def write(self, rgba: Any) -> None:
        if self._cur is None or self._cur.count >= self.chunk:
            if self._cur is not None:
                self._cur.close()
            seg = self.work_dir / f"seg_{len(self.segments):05d}.webm"
            self.segments.append(seg)
            self._cur = AlphaWriter(seg, *self.size, self.fps)
        self._cur.write(rgba)

    def finish(self, out: Path) -> Path:
        if self._cur is not None:
            self._cur.close()
            self._cur = None
        if not self.segments:
            raise RuntimeError("No se proceso ningun fotograma")
        concat_webm(self.segments, out)
        return out

    def abort(self) -> None:
        if self._cur is not None:
            self._cur.abort()


def concat_webm(segments: list[Path], out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    if len(segments) == 1:
        shutil.copyfile(segments[0], out)
        return out
    listing = out.with_name(out.name + ".concat.txt")
    listing.write_text(
        "".join(f"file '{p.resolve().as_posix()}'\n" for p in segments), encoding="utf-8"
    )
    try:
        _run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
              "-safe", "0", "-i", str(listing), "-c", "copy", str(out)])  # fmt: skip
    finally:
        listing.unlink(missing_ok=True)
    return out


def masks_to_alpha_webm(
    src: Path, masks_pattern: Path, fps: Fraction, out: Path, start: int = 0, end: int | None = None
) -> Path:
    """Source frames [start, end] + grayscale PNG masks (%05d) -> WebM VP9 with alpha."""
    rate = float(fps)
    sel = f"select='between(n\\,{start}\\,{end if end is not None else 10**9})',"
    graph = (
        f"[0:v]{sel}setpts=N/({rate}*TB),format=rgba[v];"
        f"[1:v]setpts=N/({rate}*TB),format=gray[m];[v][m]alphamerge[o]"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([
        ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
        "-framerate", f"{fps.numerator}/{fps.denominator}", "-i", str(masks_pattern),
        "-filter_complex", graph, "-map", "[o]", "-r", f"{fps.numerator}/{fps.denominator}",
        *_VP9_ARGS, "-an", str(out),
    ])  # fmt: skip
    return out


def alpha_preview_png(webm: Path, out: Path, at: float = 0.0) -> Path:
    """First (or `at` s) frame of an alpha WebM as RGBA PNG (libvpx decoder keeps the alpha)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([
        ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-c:v", "libvpx-vp9",
        "-ss", f"{max(0.0, at):.3f}", "-i", str(webm), "-frames:v", "1",
        "-vf", "format=rgba", "-update", "1", str(out),
    ])  # fmt: skip
    return out


def webm_has_alpha(path: Path) -> bool:
    out = subprocess.run(
        [ffprobe_exe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name:stream_tags", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    st = (json.loads(out.stdout or "{}").get("streams") or [{}])[0]
    tags = {k.lower(): v for k, v in (st.get("tags") or {}).items()}
    return st.get("codec_name") == "vp9" and str(tags.get("alpha_mode")) == "1"


def _run(cmd: list[str], timeout: float = 3600) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg fallo ({proc.returncode}): {proc.stderr.strip()[-500:]}")


# --------------------------------------------------------------------------------------- PNG


def write_png(path: Path, arr: Any) -> Path:
    """uint8 numpy array HxW (gray) or HxWx4 (RGBA) -> PNG (no PIL/OpenCV)."""
    import numpy as np  # noqa: PLC0415

    a = np.ascontiguousarray(arr, dtype=np.uint8)
    if a.ndim == 2:
        h, w = a.shape
        color = 0
    elif a.ndim == 3 and a.shape[2] in (3, 4):
        h, w, c = a.shape
        color = 6 if c == 4 else 2
    else:
        raise ValueError(f"forma de imagen no soportada: {a.shape}")
    rows = a.reshape(h, -1)
    raw = np.empty((h, rows.shape[1] + 1), dtype=np.uint8)
    raw[:, 0] = 0  # filter type None
    raw[:, 1:] = rows

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw.tobytes(), 6)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(png)
    tmp.replace(path)
    return path


def read_gray(path: Path, size: tuple[int, int] | None = None) -> Any:
    """Any image FFmpeg reads -> uint8 HxW (alpha channel if the image has one, else luma)."""
    import numpy as np  # noqa: PLC0415

    info = probe(path)
    w, h = size or (info.width, info.height)
    out = subprocess.run(
        [
            ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-frames:v", "1", "-vf", f"scale={w}:{h}:flags=neighbor,format=rgba",
            "-f", "rawvideo", "-",
        ],
        capture_output=True, timeout=60,
    )  # fmt: skip
    if out.returncode != 0 or len(out.stdout) < w * h * 4:
        raise ValueError(f"No se pudo leer la mascara {path.name}")
    rgba = np.frombuffer(out.stdout[: w * h * 4], dtype=np.uint8).reshape(h, w, 4)
    alpha = rgba[:, :, 3]
    if int(alpha.min()) == 255:  # opaque image: use luma (white = object)
        return rgba[:, :, :3].max(axis=2)
    return alpha.copy()


def read_rgb(path: Path) -> tuple[Any, VideoInfo]:
    """First frame of an image/video as uint8 HxWx3."""
    info = probe(path)
    for _i, frame in FrameReader(path, info, start=0, end=0):
        return frame.copy(), info
    raise ValueError(f"No se pudo leer la imagen {path.name}")


def mask_bbox(mask: Any) -> tuple[int, int, int, int] | None:
    """(x, y, w, h) in pixels of the non-zero area, or None when empty."""
    import numpy as np  # noqa: PLC0415

    ys = np.flatnonzero(mask.any(axis=1))
    if ys.size == 0:
        return None
    xs = np.flatnonzero(mask.any(axis=0))
    x0, x1, y0, y1 = int(xs[0]), int(xs[-1]), int(ys[0]), int(ys[-1])
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1
