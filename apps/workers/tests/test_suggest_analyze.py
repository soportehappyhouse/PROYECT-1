"""Sprint 6 M3: /analyze/suggest (one ffmpeg pass: ebur128 + PCM floor/silences), real ffmpeg."""

from __future__ import annotations

import math
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from studio_workers.analyze import (
    analyze_for_suggestions,
    noise_floor_db,
    parse_ebur128_summary,
    silence_threshold_db,
    silences_from_peaks,
)
from studio_workers.routers.analyze import analyze_queue

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")

# 12 s: tone 2 s | silence 1.5 s | tone 2 s | silence 1 s | tone 2 s | silence 1 s | tone 2.5 s
SEGMENTS = [("t", 2.0), ("s", 1.5), ("t", 2.0), ("s", 1.0), ("t", 2.0), ("s", 1.0), ("t", 2.5)]
EXPECTED_SILENCES = [(2.0, 3.5), (5.5, 6.5), (8.5, 9.5)]


def synth_wav(dst: Path, segments=SEGMENTS, *, target_lufs: float = -30.0) -> Path:
    """Speech-like tone bursts (pink-ish noise band) with digital silences, normalized to
    ``target_lufs`` with loudnorm-free math: generate then measure+gain with ffmpeg volume."""
    inputs: list[str] = []
    labels = []
    for i, (kind, dur) in enumerate(segments):
        if kind == "t":
            src = f"sine=frequency=220:sample_rate=48000:duration={dur}"
        else:
            src = f"anullsrc=r=48000:cl=mono:d={dur}"
        inputs += ["-f", "lavfi", "-i", src]
        labels.append(f"[{i}:a]")
    raw = dst.with_suffix(".raw.wav")
    concat = "".join(labels) + f"concat=n={len(segments)}:v=0:a=1[a]"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs]
        + ["-filter_complex", concat, "-map", "[a]", "-ac", "1", str(raw)],
        check=True,
    )
    measured = analyze_for_suggestions(raw)["lufs_i"]
    gain = target_lufs - measured
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw)]
        + ["-af", f"volume={gain:.3f}dB", str(dst)],
        check=True,
    )
    raw.unlink()
    return dst


@needs_ffmpeg
def test_three_silences_and_minus_30_lufs(tmp_path: Path) -> None:
    wav = synth_wav(tmp_path / "voice.wav")
    res = analyze_for_suggestions(wav, silence_min_ms=500, silence_rel_db=9)
    assert abs(res["duration_s"] - 12.0) < 0.05
    assert res["lufs_i"] == pytest.approx(-30.0, abs=1.0)
    assert res["true_peak_db"] is not None and res["true_peak_db"] < -1
    assert res["lra"] is not None
    assert -50 <= res["silence_threshold_db"] <= -30
    assert len(res["silences"]) == 3
    for (s, e), (es, ee) in zip(res["silences"], EXPECTED_SILENCES, strict=True):
        assert abs(s - es) <= 0.05 and abs(e - ee) <= 0.05


@needs_ffmpeg
def test_router_task_progress_and_result(client, dirs, tmp_path: Path) -> None:
    storage, _ = dirs
    synth_wav(storage / "media" / "v.wav")
    res = client.post("/analyze/suggest", json={"input_path": "media/v.wav", "job_id": "j1"})
    assert res.status_code == 200, res.text
    tid = res.json()["task_id"]
    task = analyze_queue().wait(tid, 30)
    assert task is not None and task.status == "done", task and task.error
    body = client.get(f"/analyze/tasks/{tid}").json()
    assert body["status"] == "done"
    assert body["stage_es"] == "Midiendo silencios y volumen"
    assert body["total"] == 12 and body["done"] == 12
    assert len(body["result"]["silences"]) == 3
    assert client.get("/analyze/tasks/nope").json()["code"] == "TASK_NOT_FOUND"
    assert client.post("/analyze/tasks/nope/cancel").status_code == 404


def test_missing_file_is_404(client) -> None:
    res = client.post("/analyze/suggest", json={"input_path": "media/none.wav"})
    assert res.status_code == 404


@needs_ffmpeg
def test_cancel_mid_way_kills_ffmpeg(client, dirs, monkeypatch) -> None:
    storage, _ = dirs
    long_wav = storage / "media" / "long.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"]
        + ["sine=frequency=300:sample_rate=48000:duration=300", "-ac", "1", str(long_wav)],
        check=True,
    )
    procs: list[subprocess.Popen] = []
    real_popen = subprocess.Popen

    class SpyPopen(real_popen):  # type: ignore[misc, valid-type]
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            procs.append(self)

    # Slow the reader down so the cancel lands mid-way (the decode of 30 min is otherwise ~1 s).
    import studio_workers.analyze as analyze_mod

    real_stats = analyze_mod.chunk_stats

    def slow_stats(samples):
        time.sleep(0.01)
        return real_stats(samples)

    monkeypatch.setattr(analyze_mod.subprocess, "Popen", SpyPopen)
    monkeypatch.setattr(analyze_mod, "chunk_stats", slow_stats)
    tid = client.post("/analyze/suggest", json={"input_path": "media/long.wav"}).json()["task_id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        body = client.get(f"/analyze/tasks/{tid}").json()
        if (body.get("done") or 0) >= 5:
            break
        time.sleep(0.02)
    assert body["status"] == "running"
    t0 = time.monotonic()
    assert client.post(f"/analyze/tasks/{tid}/cancel").json()["was"] == "running"
    task = analyze_queue().wait(tid, 10)
    assert task.status == "canceled"
    assert time.monotonic() - t0 < 2.0
    ffmpeg_procs = [p for p in procs if p.args and "ffmpeg" in " ".join(map(str, p.args))]
    assert ffmpeg_procs and all(p.poll() is not None for p in ffmpeg_procs)
    assert body["stage_es"] == "Midiendo silencios y volumen"
    assert body["eta_s"] is None or body["eta_s"] >= 0


def test_background_waits_for_user_task_in_analyze_queue() -> None:
    """A user task submitted after 2 background ones runs first once the current one ends."""
    q = analyze_queue()
    order: list[str] = []
    gate = threading.Event()
    first = q.submit("suggest.analyze", "busy", lambda t: gate.wait(5), priority=5)
    time.sleep(0.05)
    bg = q.submit("suggest.analyze", "bg", lambda t: order.append("bg"), priority=5)
    user = q.submit("user.thing", "u", lambda t: order.append("user"), priority=0)
    gate.set()
    for t in (first, bg, user):
        assert q.wait(t.id, 10).status == "done"
    assert order == ["user", "bg"]


def test_pure_helpers() -> None:
    assert noise_floor_db([]) == -90
    assert noise_floor_db([-60.0] * 9 + [-20.0] * 91) == -20.0
    assert noise_floor_db([float("-inf")] * 20 + [-20.0] * 80) == -90
    assert silence_threshold_db(-90, 9) == -50
    assert silence_threshold_db(-45, 9) == -36
    assert silence_threshold_db(-10, 9) == -30
    peaks = [-20.0] * 10 + [-80.0] * 60 + [-20.0] * 5 + [-80.0] * 30
    assert silences_from_peaks(peaks, -40, 500) == [(0.1, 0.7)]
    assert silences_from_peaks(peaks, -40, 300) == [(0.1, 0.7), (0.75, 1.05)]
    stderr = (
        "[Parsed_ebur128_1 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -30.2 LUFS\n"
        "    Threshold: -40.5 LUFS\n\n  Loudness range:\n    LRA:         1.5 LU\n"
        "  True peak:\n    Peak:       -12.0 dBFS\n"
    )
    assert parse_ebur128_summary(stderr) == (-30.2, 1.5, -12.0)
    silent = stderr.replace("-30.2", "-70.0").replace("-12.0", "-inf")
    assert parse_ebur128_summary(silent) == (None, 1.5, None)
    assert parse_ebur128_summary("") == (None, None, None)
    assert math.isfinite(silence_threshold_db(-1e9, 9))
