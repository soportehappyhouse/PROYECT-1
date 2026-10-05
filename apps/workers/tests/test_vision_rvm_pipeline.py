"""RVM pipeline speed work: raw yuva420p frames (colour conversion done by the runner, on the GPU
for the real model), threaded decode/encode with per-stage timings, the VP9 WebM and the split
(colour + alpha-as-luma H.264 streams, NVENC when it works) alpha formats.

The GPL runner is imported here only by the tests (studio_workers never imports it)."""

import json
import os
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

import pytest
from conftest import count_frames, lavfi_video, needs_ffmpeg

from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.vision import frames
from studio_workers.vision.matte import ALPHA_CODEC_ENV, MatteEngine

np = pytest.importorskip("numpy")
WORKERS = Path(__file__).resolve().parents[1]
if str(WORKERS) not in sys.path:
    sys.path.insert(0, str(WORKERS))

from vision_gpl import ffio, rvm  # noqa: E402


def _cli(*args: str, env: dict | None = None) -> tuple[int, list[dict]]:
    proc = subprocess.run(
        [sys.executable, "-m", "vision_gpl.rvm", *args],
        capture_output=True, text=True, cwd=WORKERS, timeout=180,
        env={**os.environ, **(env or {})},
    )  # fmt: skip
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.returncode, [json.loads(line) for line in proc.stdout.splitlines() if line]


def _decode_rgba(path: Path, w: int, h: int, *, split: bool) -> "np.ndarray":
    cmd = ["ffmpeg", "-v", "error"]
    cmd += ["-i", str(path), "-filter_complex", ffio.MERGE_GRAPH] if split else [
        "-c:v", "libvpx-vp9", "-i", str(path)]  # fmt: skip
    cmd += ["-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True, timeout=60).stdout
    return np.frombuffer(out, np.uint8).reshape(-1, h, w, 4)


def _streams(path: Path) -> list[dict]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=60,
    )  # fmt: skip
    return json.loads(out.stdout)["streams"]


def _gradient(w: int, h: int) -> tuple["np.ndarray", "np.ndarray"]:
    yy, xx = np.mgrid[0:h, 0:w]
    r, g = xx * 255 // max(1, w - 1), yy * 255 // max(1, h - 1)
    rgb = np.dstack([r, g, (xx + yy) * 255 // (w + h)])
    alpha = (xx * 255 // max(1, w - 1)).astype(np.uint8)  # 0..255 ramp: soft edges included
    return rgb.astype(np.uint8), alpha


# ------------------------------------------------------------------------------- colour


def _ffmpeg_raw(data: bytes, src_fmt: str, dst_fmt: str, w: int, h: int) -> "np.ndarray":
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", src_fmt, "-s", f"{w}x{h}", "-i",
         "-", "-f", "rawvideo", "-pix_fmt", dst_fmt, "-"],
        input=data, capture_output=True, check=True, timeout=60,
    ).stdout  # fmt: skip
    return np.frombuffer(out, np.uint8).astype(int)


@needs_ffmpeg
def test_numpy_yuva420p_matches_ffmpeg_swscale() -> None:
    w, h = 64, 48
    rgb, alpha = _gradient(w, h)
    ours = np.frombuffer(rvm.yuva420p_numpy(rgb, alpha), np.uint8).astype(int)
    ref = _ffmpeg_raw(np.dstack([rgb, alpha]).tobytes(), "rgba", "yuva420p", w, h)
    luma = w * h
    assert len(ours) == len(ref) == ffio.frame_bytes("yuva420p", w, h)
    assert np.abs(ours[:luma] - ref[:luma]).max() <= 1  # same BT.601 limited-range matrix
    assert np.abs(ours[luma:-luma] - ref[luma:-luma]).mean() < 0.5  # 2x2 box vs swscale filter
    assert (ours[-luma:] == alpha.ravel()).all() and np.abs(ours[-luma:] - ref[-luma:]).max() <= 1


@needs_ffmpeg
def test_numpy_yuva420p_odd_size_layout() -> None:
    w, h = 33, 17  # chroma planes are ceil(w/2) x ceil(h/2), last column/row replicated
    rgb, alpha = _gradient(w, h)
    ours = rvm.yuva420p_numpy(rgb, alpha)
    assert len(ours) == ffio.frame_bytes("yuva420p", w, h) == 2 * 33 * 17 + 2 * 17 * 9
    back = _ffmpeg_raw(ours, "yuva420p", "rgba", w, h).reshape(h, w, 4)
    assert (back[..., 3] == alpha).all()
    assert np.abs(back[..., :3] - rgb).mean() < 3


def test_torch_yuva420p_matches_numpy() -> None:
    torch = pytest.importorskip("torch")
    rgb, alpha = _gradient(33, 17)
    fgr = torch.from_numpy(rgb).permute(2, 0, 1)[None].float() / 255
    pha = torch.from_numpy(alpha)[None, None].float() / 255
    got = rvm.yuva420p_torch(torch, fgr.half().float(), pha)[0].numpy().astype(int)
    ref = np.frombuffer(rvm.yuva420p_numpy(rgb, alpha), np.uint8).astype(int)
    assert got.shape == ref.shape and np.abs(got - ref).max() <= 1


# ------------------------------------------------------------------------------- encoders


def test_alpha_codec_auto_follows_nvenc(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def works(ffmpeg: str, encoder: str) -> bool:
        seen.append(encoder)
        return state["nvenc"]

    state = {"nvenc": True}
    monkeypatch.setattr(ffio, "encoder_works", works)
    assert ffio.choose_alpha_codec("ffmpeg", "auto") == ffio.ALPHA_SPLIT
    state["nvenc"] = False
    assert ffio.choose_alpha_codec("ffmpeg", "auto") == ffio.ALPHA_VP9
    assert seen == ["h264_nvenc", "h264_nvenc"]
    assert ffio.choose_alpha_codec("ffmpeg", "vp9") == ffio.ALPHA_VP9  # explicit: no probe
    assert ffio.choose_alpha_codec("ffmpeg", "split") == ffio.ALPHA_SPLIT
    assert len(seen) == 2


@needs_ffmpeg
def test_encoder_probe_really_encodes() -> None:
    assert ffio.encoder_works("ffmpeg", "libx264") is True
    assert ffio.encoder_works("ffmpeg", "no_such_encoder") is False
    assert ffio.encoder_works(str(WORKERS / "no-ffmpeg"), "libx264") is False


@needs_ffmpeg
@pytest.mark.parametrize("codec", [ffio.ALPHA_VP9, ffio.ALPHA_SPLIT])
def test_writer_keeps_alpha_from_yuva420p(tmp_path: Path, codec: str) -> None:
    w, h = 64, 48
    rgb, alpha = _gradient(w, h)
    out = tmp_path / f"o{ffio.SEGMENT_EXT[codec]}"
    writer = ffio.Writer("ffmpeg", out, w, h, Fraction(25), pix_fmt="yuva420p",
                         alpha_codec=codec, split_encoder="libx264")  # fmt: skip
    for _ in range(5):
        writer.write(rvm.yuva420p_numpy(rgb, alpha))
    writer.close()
    streams = _streams(out)
    if codec == ffio.ALPHA_VP9:
        assert frames.webm_has_alpha(out) and len(streams) == 1
    else:  # colour + alpha-as-luma, both H.264
        assert [s["codec_name"] for s in streams] == ["h264", "h264"]
    got = _decode_rgba(out, w, h, split=codec == ffio.ALPHA_SPLIT)
    assert got.shape[0] == 5
    diff = np.abs(got[2, ..., 3].astype(int) - alpha)
    assert diff.max() <= (0 if codec == ffio.ALPHA_SPLIT else 12) and diff.mean() < 2
    assert np.abs(got[2, ..., :3].astype(int) - rgb).mean() < 6


@needs_ffmpeg
def test_encode_worker_error_does_not_hang(tmp_path: Path) -> None:
    def open_segment(k: int) -> ffio.Writer:
        raise OSError("disco lleno")

    worker = ffio.EncodeWorker(open_segment, lambda k: None, depth=2)
    with pytest.raises(RuntimeError, match="disco lleno"):
        for _ in range(20):
            worker.put(0, b"x")
        worker.finish()
    worker.abort()


# ------------------------------------------------------------------------------- timings


def test_stage_summary_picks_slowest_lane() -> None:
    st = rvm.Stages()
    st.add("decode", 0.4, 100)  # 4 ms
    st.add("pre", 0.1, 100)
    st.add("model", 1.0, 100)
    st.add("post", 0.2, 100)  # inference = 13 ms
    st.add("encode", 2.5, 100)  # 25 ms
    st.wait["encode"] = 1.2
    st.first_batch_s, st.load_s = 0.9, 2.0
    s = st.summary()
    assert s["ms_per_frame"] == {"decode": 4.0, "pre": 1.0, "model": 10.0, "post": 2.0,
                                 "encode": 25.0}  # fmt: skip
    assert s["stage_fps"]["encode"] == 40.0 and s["bottleneck"] == "encode"
    assert s["wait_ms_per_frame"]["encode"] == 12.0
    assert s["first_batch_s"] == 0.9 and s["load_s"] == 2.0
    st.add("model", 3.0, 0)  # model now slowest
    assert st.summary()["bottleneck"] == "inference"


@needs_ffmpeg
def test_cli_yuva_pipeline_reports_stage_timings(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=96x54:r=25:d=2")
    out = tmp_path / "o.webm"
    _code, events = _cli("--input", str(clip), "--output", str(out), "--chunk", "20",
                         "--mock-model")  # fmt: skip
    start, done = events[0], events[-1]
    assert start["pix_fmt"] == "yuva420p" and start["alpha_codec"] == "vp9"
    assert done["pix_fmt"] == "yuva420p" and done["frames"] == 50
    t = done["timings"]
    assert set(t["ms_per_frame"]) == set(rvm.STAGES)
    assert t["ms_per_frame"]["decode"] > 0 and t["ms_per_frame"]["encode"] > 0
    assert t["bottleneck"] in ("decode", "inference", "encode")
    assert {"load_s", "first_batch_s", "process_s", "concat_s"} <= set(t)
    progress = [e for e in events if e["event"] == "progress"]
    assert progress and set(progress[-1]["stages"]) == set(rvm.STAGES)
    assert frames.webm_has_alpha(out) and count_frames(out) == 50
    got = _decode_rgba(out, 96, 54, split=False)
    assert abs(got[..., 3].mean() - 200) < 3  # mock alpha
    # the previous path (ffmpeg converts RGBA) stays available for A/B measurements
    _code, events = _cli("--input", str(clip), "--output", str(tmp_path / "r.webm"),
                         "--mock-model", "--pix-fmt", "rgba")  # fmt: skip
    assert events[-1]["pix_fmt"] == "rgba" and frames.webm_has_alpha(tmp_path / "r.webm")


@needs_ffmpeg
def test_cli_split_streams_chunks_and_concat(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=64x36:r=25:d=2")
    _code, events = _cli("--input", str(clip), "--output", str(tmp_path / "o.webm"),
                         "--chunk", "20", "--mock-model", "--alpha-codec", "split",
                         "--split-encoder", "libx264")  # fmt: skip
    done = events[-1]
    out = Path(done["output"])
    assert out.suffix == ".mkv" and done["alpha_codec"] == "split" and done["frames"] == 50
    assert [e["index"] for e in events if e["event"] == "chunk"] == [0, 1, 2]
    assert [s["codec_name"] for s in _streams(out)] == ["h264", "h264"]  # concat kept both
    got = _decode_rgba(out, 64, 36, split=True)
    assert got.shape[0] == 50 and (got[..., 3] == 200).all()  # alpha exact through the merge


@needs_ffmpeg
def test_cli_auto_without_nvenc_falls_back_to_vp9(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=64x36:r=25:d=1")
    out = tmp_path / "o.webm"
    _code, events = _cli("--input", str(clip), "--output", str(out), "--mock-model",
                         "--alpha-codec", "auto")  # fmt: skip
    expected = "split" if ffio.encoder_works("ffmpeg", ffio.SPLIT_ENCODER) else "vp9"
    assert events[-1]["alpha_codec"] == expected
    if expected == "vp9":
        assert Path(events[-1]["output"]) == out and frames.webm_has_alpha(out)


# ------------------------------------------------------------------------------- engine


def _engine(monkeypatch: pytest.MonkeyPatch, codec: str | None = None) -> MatteEngine:
    monkeypatch.setenv("GPL_PYTHON", sys.executable)
    if codec:
        monkeypatch.setenv(ALPHA_CODEC_ENV, codec)
    services.reset()
    engine = MatteEngine(get_settings())
    engine.rvm_extra_args = ["--mock-model", "--split-encoder", "libx264"]
    return engine


@needs_ffmpeg
def test_matte_video_returns_timings_and_codec(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    clip = lavfi_video(storage / "media" / "p.mp4", "testsrc2=s=64x36:r=25:d=1")
    res = _engine(monkeypatch).matte_video(clip, storage / "renders" / "p.webm", model="rvm")
    assert res["alpha_codec"] == "vp9" and res["output"] == storage / "renders" / "p.webm"
    t = res["timings"]
    assert t["bottleneck"] in ("decode", "inference", "encode")
    assert t["startup_s"] > 0 and t["total_s"] >= t["startup_s"]
    assert t["preview_s"] >= 0 and t["matte_video_s"] >= t["total_s"]


@needs_ffmpeg
def test_matte_video_split_format_preview(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    clip = lavfi_video(storage / "media" / "p.mp4", "testsrc2=s=64x36:r=25:d=1")
    engine = _engine(monkeypatch, "split")
    assert engine.rvm_alpha_codec == "split"
    res = engine.matte_video(clip, storage / "renders" / "p.webm", model="rvm")
    assert res["alpha_codec"] == "split" and res["output"].suffix == ".mkv"
    assert res["output"].is_file() and len(_streams(res["output"])) == 2
    preview = res["preview"]
    assert preview.name == "p.preview.png" and abs(frames.read_gray(preview).mean() - 200) < 2
