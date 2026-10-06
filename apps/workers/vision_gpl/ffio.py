"""FFmpeg pipes for the RVM runner (self-contained: no studio_workers imports).

Frames travel as raw video over pipes (never PNG). The decoder runs in its own process and a
prefetch thread (``FramePrefetcher``); the encoder runs in its own process fed by a writer thread
(``EncodeWorker``), so decode, model and encode overlap and each stage reports its busy time.

Alpha formats (``ALPHA_VP9`` / ``ALPHA_SPLIT``):

* ``vp9``: one WebM VP9 ``yuva420p`` file (libvpx, CPU). What the web preview and the export read.
* ``split``: one Matroska file with two H.264 streams encoded by NVENC: ``v:0`` = colour
  (``yuv420p``) and ``v:1`` = alpha in the luma plane (full range, chroma 128). Rebuild with
  ``[0:v:1]extractplanes=y[a];[0:v:0][a]alphamerge`` (lossless round trip for the alpha values).
"""

from __future__ import annotations

import contextlib
import json
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from fractions import Fraction
from pathlib import Path
from typing import Any

ALPHA_VP9 = "vp9"
ALPHA_SPLIT = "split"
SEGMENT_EXT = {ALPHA_VP9: ".webm", ALPHA_SPLIT: ".mkv"}
SPLIT_ENCODER = "h264_nvenc"

# libvpx realtime: speed 8 (max), row multithreading, no alt-ref (required with alpha).
VP9 = [
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    "-lag-in-frames", "0",
]  # fmt: skip

# yuva420p in -> colour stream + alpha-as-luma stream (gray -> yuv420p without range change).
SPLIT_GRAPH = (
    "[0:v]split=2[c][a];[c]format=yuv420p[cv];"
    "[a]extractplanes=a,scale=in_range=full:out_range=full,format=yuv420p,setparams=range=pc[av]"
)
MERGE_GRAPH = "[0:v:1]extractplanes=y[a];[0:v:0][a]alphamerge"


def split_codec_args(encoder: str) -> list[str]:
    if encoder == "h264_nvenc":  # constant quality; alpha at a lower QP (edges matter most)
        return [
            "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-b:v", "0",
            "-cq:v:0", "19", "-cq:v:1", "12", "-bf", "0",
        ]  # fmt: skip
    # software stand-in (tests / machines without NVENC when forced): same layout
    return ["-c:v", encoder, "-preset", "ultrafast", "-qp:v:0", "18", "-qp:v:1", "0"]


def frame_bytes(pix_fmt: str, w: int, h: int) -> int:
    if pix_fmt == "rgba":
        return w * h * 4
    if pix_fmt == "rgb24":
        return w * h * 3
    if pix_fmt == "yuva420p":
        cw, ch = (w + 1) // 2, (h + 1) // 2
        return 2 * w * h + 2 * cw * ch
    raise ValueError(pix_fmt)


def find_tool(name: str, hint: str | None = None) -> str:
    if hint and Path(hint).is_file():
        if name == "ffmpeg":
            return hint
        for cand in (Path(hint).with_name(f"{name}.exe"), Path(hint).with_name(name)):
            if cand.is_file():
                return str(cand)
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} no encontrado")
    return found


_ENCODER_OK: dict[tuple[str, str], bool] = {}


def encoder_works(ffmpeg: str, encoder: str) -> bool:
    """True when ``encoder`` can really encode one frame (listed != usable: NVENC needs a GPU,
    a recent driver and a free session). Cached per process."""
    key = (ffmpeg, encoder)
    if key not in _ENCODER_OK:
        try:
            proc = subprocess.run(
                [ffmpeg, "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
                 "color=c=black:s=256x144:r=25:d=0.2", "-frames:v", "1", "-c:v", encoder,
                 "-f", "null", "-"],
                capture_output=True, timeout=30,
            )  # fmt: skip
            _ENCODER_OK[key] = proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            _ENCODER_OK[key] = False
    return _ENCODER_OK[key]


def choose_alpha_codec(ffmpeg: str, requested: str) -> str:
    """``auto``: split NVENC streams when NVENC works, else the libvpx WebM."""
    if requested in (ALPHA_VP9, ALPHA_SPLIT):
        return requested
    return ALPHA_SPLIT if encoder_works(ffmpeg, SPLIT_ENCODER) else ALPHA_VP9


def probe(ffprobe: str, path: Path) -> dict:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format",
         "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe fallo: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout)
    st = data["streams"][0]
    w, h = int(st["width"]), int(st["height"])
    rot = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if abs(rot) % 180 == 90:
        w, h = h, w
    fps = Fraction(st.get("avg_frame_rate") or "0") if st.get("avg_frame_rate") != "0/0" else 0
    if not fps or fps > 240:
        fps = Fraction(st.get("r_frame_rate") or "25")
    duration = float(st.get("duration") or data.get("format", {}).get("duration") or 0)
    frames = int(st.get("nb_frames") or 0) or round(duration * float(fps))
    return {"width": w, "height": h, "fps": fps, "frames": max(1, frames)}


def decode_cmd(ffmpeg: str, path: Path) -> list[str]:
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-fps_mode",
            "passthrough", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]  # fmt: skip


def read_frames(ffmpeg: str, path: Path, w: int, h: int) -> Iterator[bytes]:
    proc = subprocess.Popen(  # noqa: S603
        decode_cmd(ffmpeg, path), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    assert proc.stdout is not None
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield buf
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


_END = object()


class FramePrefetcher:
    """Decoder process + thread that keeps up to ``depth`` RGB frames ready. ``busy`` = seconds
    the thread spent waiting for the decoder (the decode stage); ``wait`` = seconds the consumer
    waited for a frame (> 0 only when decode is the bottleneck)."""

    def __init__(self, ffmpeg: str, path: Path, w: int, h: int, depth: int = 6) -> None:
        self.size = w * h * 3
        self.q: queue.Queue[Any] = queue.Queue(maxsize=max(1, depth))
        self.busy = 0.0
        self.wait = 0.0
        self.frames = 0
        self._stop = threading.Event()
        self.proc = subprocess.Popen(  # noqa: S603
            decode_cmd(ffmpeg, path), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        self._thread = threading.Thread(target=self._run, name="rvm-decode", daemon=True)
        self._thread.start()

    def _put(self, item: Any) -> bool:
        while not self._stop.is_set():
            try:
                self.q.put(item, timeout=0.2)
                return True
            except queue.Full:
                continue
        return False

    def _run(self) -> None:
        out = self.proc.stdout
        assert out is not None
        try:
            while not self._stop.is_set():
                t0 = time.perf_counter()
                buf = out.read(self.size)
                self.busy += time.perf_counter() - t0
                if len(buf) < self.size or not self._put(buf):
                    break
                self.frames += 1
        except Exception as exc:  # pragma: no cover - broken pipe while closing
            self._put(exc)
        finally:
            self._put(_END)

    def __iter__(self) -> Iterator[bytes]:
        while True:
            t0 = time.perf_counter()
            item = self.q.get()
            self.wait += time.perf_counter() - t0
            if item is _END:
                return
            if isinstance(item, Exception):
                raise item
            yield item

    def close(self) -> None:
        self._stop.set()
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        self._thread.join(timeout=5)


class Writer:
    """One output segment: raw frames (``rgba`` or ``yuva420p``) on stdin -> ffmpeg."""

    def __init__(
        self,
        ffmpeg: str,
        out: Path,
        w: int,
        h: int,
        fps: Fraction,
        *,
        pix_fmt: str = "rgba",
        alpha_codec: str = ALPHA_VP9,
        split_encoder: str = SPLIT_ENCODER,
    ) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        self.out = out
        head = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
                "-pix_fmt", pix_fmt, "-s", f"{w}x{h}", "-framerate",
                f"{fps.numerator}/{fps.denominator}", "-i", "-"]  # fmt: skip
        if alpha_codec == ALPHA_SPLIT:
            tail = ["-filter_complex", SPLIT_GRAPH, "-map", "[cv]", "-map", "[av]",
                    *split_codec_args(split_encoder), "-an", str(out)]  # fmt: skip
        else:
            tail = [*VP9, "-an", str(out)]
        self.cmd = [*head, *tail]
        self.proc = subprocess.Popen(  # noqa: S603
            self.cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE
        )

    def write(self, frame: bytes | memoryview) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(frame)

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        err = self.proc.stderr.read().decode("utf-8", "replace") if self.proc.stderr else ""
        if self.proc.wait() != 0:
            raise RuntimeError(f"ffmpeg ({self.out.suffix}) fallo: {err.strip()[-300:]}")

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()


class EncodeWorker:
    """Writer thread: frames tagged with their segment index go to that segment's encoder.
    ``busy`` = seconds spent writing to / closing the encoders (the encode stage); ``wait`` =
    seconds the producer was blocked because the queue was full (encode is the bottleneck)."""

    def __init__(
        self,
        open_segment: Callable[[int], Writer],
        segment_done: Callable[[int], None],
        depth: int = 6,
    ) -> None:
        self.open_segment = open_segment
        self.segment_done = segment_done
        self.q: queue.Queue[Any] = queue.Queue(maxsize=max(1, depth))
        self.busy = 0.0
        self.wait = 0.0
        self.frames = 0
        self.error: BaseException | None = None
        self._writer: Writer | None = None
        self._seg = -1
        self._thread = threading.Thread(target=self._run, name="rvm-encode", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while True:
                item = self.q.get()
                if item is _END:
                    break
                seg, data = item
                t0 = time.perf_counter()
                if seg != self._seg:
                    self._close_current()
                    self._writer = self.open_segment(seg)
                    self._seg = seg
                assert self._writer is not None
                self._writer.write(data)
                self.frames += 1
                self.busy += time.perf_counter() - t0
            t0 = time.perf_counter()
            self._close_current()
            self.busy += time.perf_counter() - t0
        except BaseException as exc:
            self.error = exc
            if self._writer is not None:
                self._writer.kill()
                self._writer = None
            while True:  # unblock the producer
                try:
                    self.q.get_nowait()
                except queue.Empty:
                    break

    def _close_current(self) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None
            self.segment_done(self._seg)

    def _check(self) -> None:
        if self.error is not None:
            raise RuntimeError(f"codificacion fallo: {self.error}") from self.error

    def put(self, seg: int, data: bytes | memoryview) -> None:
        t0 = time.perf_counter()
        while True:
            self._check()
            try:
                self.q.put((seg, data), timeout=0.2)
                break
            except queue.Full:
                if not self._thread.is_alive():
                    self._check()
                    raise RuntimeError("codificacion detenida") from None
        self.wait += time.perf_counter() - t0

    def finish(self) -> None:
        while self._thread.is_alive():
            try:
                self.q.put(_END, timeout=0.2)
                break
            except queue.Full:
                continue
        self._thread.join()
        self._check()

    def abort(self) -> None:
        if self._thread.is_alive():
            self.error = self.error or RuntimeError("abortado")
            if self._writer is not None:
                self._writer.kill()
            while True:
                try:
                    self.q.get_nowait()
                except queue.Empty:
                    break
            with contextlib.suppress(queue.Full):
                self.q.put_nowait(_END)
            self._thread.join(timeout=10)


def concat(ffmpeg: str, segments: list[Path], out: Path) -> None:
    if len(segments) == 1:
        shutil.copyfile(segments[0], out)
        return
    listing = out.with_name(out.name + ".concat.txt")
    listing.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in segments), "utf-8")
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
             "-i", str(listing), "-map", "0", "-c", "copy", str(out)],
            capture_output=True, text=True,
        )  # fmt: skip
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg concat fallo: {proc.stderr.strip()[-300:]}")
    finally:
        listing.unlink(missing_ok=True)


class MaskReader:
    """SAM masks for the ``--mask`` guide: a folder of ``%05d.png`` (mask k belongs to source frame
    ``offset + k``, the layout of studio_workers/vision/sam.py) or one PNG (used for every frame).
    ``get(i)`` -> HxW gray bytes scaled to the video size, or None (no mask for that frame)."""

    def __init__(self, ffmpeg: str, path: Path, w: int, h: int, offset: int = 0) -> None:
        self.ffmpeg, self.path, self.w, self.h, self.offset = ffmpeg, Path(path), w, h, offset
        self.size = w * h
        self.proc: subprocess.Popen[bytes] | None = None
        self.next = 0
        self.used = 0
        self.single: bytes | None = None
        if self.path.is_dir():
            self.count = len(list(self.path.glob("*.png")))
            if not self.count:
                raise RuntimeError(f"La carpeta de mascaras no tiene PNG: {self.path}")
        elif self.path.is_file():
            self.count = 0
            out = subprocess.run(self._cmd(self.path, None), capture_output=True, timeout=120)
            if out.returncode != 0 or len(out.stdout) < self.size:
                raise RuntimeError(f"No se pudo leer la mascara {self.path.name}")
            self.single = out.stdout[: self.size]
        else:
            raise RuntimeError(f"Mascara no encontrada: {self.path}")

    def _cmd(self, src: Path, start: int | None) -> list[str]:
        head = [self.ffmpeg, "-hide_banner", "-loglevel", "error"]
        if start is not None:
            head += ["-start_number", str(start)]
        return [*head, "-i", str(src), "-vf",
                f"scale={self.w}:{self.h}:flags=neighbor,format=gray", "-frames:v",
                str(max(1, self.count - (start or 0)) if start is not None else 1),
                "-f", "rawvideo", "-pix_fmt", "gray", "-"]  # fmt: skip

    def _open(self, k: int) -> None:
        self.close()
        self.proc = subprocess.Popen(  # noqa: S603
            self._cmd(self.path / "%05d.png", k), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )  # fmt: skip
        self.next = k

    def get(self, i: int) -> bytes | None:
        if self.single is not None:
            self.used += 1
            return self.single
        k = i - self.offset
        if k < 0 or k >= self.count:
            return None
        if self.proc is None or k < self.next:
            self._open(k)
        assert self.proc is not None and self.proc.stdout is not None
        buf = b""
        while self.next <= k:
            buf = self.proc.stdout.read(self.size)
            self.next += 1
            if len(buf) < self.size:
                self.count = min(self.count, self.next - 1)  # sequence shorter than the folder
                return None
        self.used += 1
        return buf

    def close(self) -> None:
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait()
            self.proc = None


def write_png(ffmpeg: str, rgb: bytes, w: int, h: int, out: Path, max_h: int = 540) -> Path:
    """rgb24 bytes -> PNG (downscaled to ``max_h`` px high when bigger)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = f"scale=-2:{max_h}:flags=area" if h > max_h else "null"
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt",
         "rgb24", "-s", f"{w}x{h}", "-i", "-", "-vf", vf, "-frames:v", "1", "-update", "1",
         str(out)],
        input=rgb, capture_output=True, timeout=120,
    )  # fmt: skip
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg png fallo: {proc.stderr.decode('utf-8', 'replace')[-300:]}")
    return out
