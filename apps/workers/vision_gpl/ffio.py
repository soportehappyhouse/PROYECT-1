"""Minimal FFmpeg pipes for the RVM runner (self-contained: no studio_workers imports)."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path

VP9 = [
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
]  # fmt: skip


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


def read_frames(ffmpeg: str, path: Path, w: int, h: int) -> Iterator[bytes]:
    proc = subprocess.Popen(  # noqa: S603
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-fps_mode",
         "passthrough", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )  # fmt: skip
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


class Writer:
    def __init__(self, ffmpeg: str, out: Path, w: int, h: int, fps: Fraction) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        self.out = out
        self.proc = subprocess.Popen(  # noqa: S603
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt",
             "rgba", "-s", f"{w}x{h}", "-framerate", f"{fps.numerator}/{fps.denominator}",
             "-i", "-", *VP9, "-an", str(out)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE,
        )  # fmt: skip

    def write(self, rgba: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(rgba)

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        err = self.proc.stderr.read().decode("utf-8", "replace") if self.proc.stderr else ""
        if self.proc.wait() != 0:
            raise RuntimeError(f"ffmpeg (webm) fallo: {err.strip()[-300:]}")


def concat(ffmpeg: str, segments: list[Path], out: Path) -> None:
    if len(segments) == 1:
        shutil.copyfile(segments[0], out)
        return
    listing = out.with_name(out.name + ".concat.txt")
    listing.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in segments), "utf-8")
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
             "-i", str(listing), "-c", "copy", str(out)],
            capture_output=True, text=True,
        )  # fmt: skip
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg concat fallo: {proc.stderr.strip()[-300:]}")
    finally:
        listing.unlink(missing_ok=True)
