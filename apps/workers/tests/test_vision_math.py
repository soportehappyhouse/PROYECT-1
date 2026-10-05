"""One-Euro filter, dead zone / pan speed / RDP, TrackFile building and reframe planning
(pure functions: synthetic detections, no model, no ffmpeg)."""

import math
import random

import pytest

from studio_workers.vision import one_euro
from studio_workers.vision.one_euro import (
    OneEuroFilter,
    deadzone,
    limit_speed,
    rdp,
    smooth,
    smooth_zero_lag,
)
from studio_workers.vision.reframe import MAX_PAN_PER_S, crop_size, plan_reframe
from studio_workers.vision.trackfile import TrackFile, build_track, fill_gaps

FPS = 30.0


def _ts(n: int, fps: float = FPS) -> list[float]:
    return [i / fps for i in range(n)]


# ------------------------------------------------------------------------------- one-euro


def test_one_euro_constant_and_first_sample() -> None:
    f = OneEuroFilter(1.0, 0.5)
    assert f(0.0, 0.42) == 0.42
    assert all(abs(f(t, 0.42) - 0.42) < 1e-12 for t in _ts(30)[1:])


def test_one_euro_reduces_jitter() -> None:
    rnd = random.Random(7)
    ts = _ts(300)
    noisy = [0.5 + rnd.uniform(-0.02, 0.02) for _ in ts]
    out = smooth(ts, noisy, **one_euro.TRACK_PARAMS)

    def jitter(xs: list[float]) -> float:
        return sum(abs(b - a) for a, b in zip(xs, xs[1:], strict=False)) / (len(xs) - 1)

    assert jitter(out) < jitter(noisy) / 3
    assert abs(sum(out[50:]) / len(out[50:]) - 0.5) < 0.005


def test_zero_lag_one_euro_follows_constant_motion_and_keeps_jitter_low() -> None:
    # Sprint 2 integration: a text following a tracked box trailed it by ~10 px (causal filter).
    ts = [i / 30 for i in range(120)]
    ramp = [0.0625 + 0.15625 * t for t in ts]  # 200 px/s on 1280 px
    causal = smooth(ts, ramp, **one_euro.TRACK_PARAMS)
    both = smooth_zero_lag(ts, ramp, **one_euro.TRACK_PARAMS)
    mid = slice(10, 110)
    assert max(abs(a - b) for a, b in zip(causal[mid], ramp[mid], strict=True)) * 1280 > 5
    # no lag anywhere, ends included (odd-reflection padding)
    assert max(abs(a - b) for a, b in zip(both, ramp, strict=True)) * 1280 < 0.5
    noisy = [0.5 + (0.004 if i % 2 else -0.004) for i in range(120)]
    out = smooth_zero_lag(ts, noisy, **one_euro.TRACK_PARAMS)

    def jitter(xs: list[float]) -> float:
        return sum(abs(b - a) for a, b in zip(xs, xs[1:], strict=False))

    assert jitter(out) < jitter(noisy) / 3


def test_one_euro_beta_reduces_lag_on_fast_motion() -> None:
    ts = _ts(60)
    ramp = [t * 1.5 for t in ts]  # 1.5 frame widths per second
    lag_static = ramp[-1] - smooth(ts, ramp, min_cutoff=0.5, beta=0.0)[-1]
    lag_adaptive = ramp[-1] - smooth(ts, ramp, min_cutoff=0.5, beta=2.0)[-1]
    assert lag_adaptive < lag_static / 2


def test_one_euro_duplicate_timestamp_and_reset() -> None:
    f = OneEuroFilter(1.0, 0.0)
    f(0.0, 0.0)
    v = f(0.1, 1.0)
    assert f(0.1, 5.0) == v  # dt == 0: previous estimate
    f.reset()
    assert f(1.0, 3.0) == 3.0


def test_deadzone_speed_and_rdp() -> None:
    assert deadzone([0.5, 0.52, 0.48, 0.5], 0.05) == [0.5] * 4
    moved = deadzone([0.5, 0.6, 0.7], 0.05)
    assert moved[0] == 0.5 and moved[1] == pytest.approx(0.55) and moved[2] == pytest.approx(0.65)
    limited = limit_speed([0.0, 0.1, 0.2], [0.0, 1.0, 1.0], 1.0)
    assert limited == pytest.approx([0.0, 0.1, 0.2])
    line = [(t, 2 * t) for t in _ts(50)]
    assert rdp(line, 1e-6) == [0, 49]
    bump = [(float(i), 1.0 if i == 10 else 0.0) for i in range(20)]
    assert 10 in rdp(bump, 0.5)


# ------------------------------------------------------------------------------- trackfile


def test_fill_gaps_interpolates_and_holds_edges() -> None:
    boxes = [None, (0, 0, 10, 10), None, None, (30, 0, 10, 10), None]
    confs = [0, 1, 0, 0, 1, 0]
    out = fill_gaps(boxes, confs)
    assert out[0] == (0, 0, 10, 10) and out[-1] == (30, 0, 10, 10)
    assert out[2] == pytest.approx((10, 0, 10, 10)) and out[3] == pytest.approx((20, 0, 10, 10))


def test_build_track_normalized_smoothed_contract() -> None:
    rnd = random.Random(3)
    n = 90
    ts = _ts(n)
    boxes = []
    for i in range(n):
        x = 100 + 10 * i + rnd.uniform(-6, 6)
        boxes.append((x, 200 + rnd.uniform(-6, 6), 100.0, 80.0))
    boxes[40] = None  # lost frame
    confs = [0.0 if b is None else 1.0 for b in boxes]
    trk = build_track(ts, boxes, confs, 1920, 1080, fps=FPS, method="csrt", asset_id="a1")
    data = trk.payload()
    assert data["version"] == 1 and data["smoothed"] is True and data["fps"] == FPS
    assert data["source"] == {"assetId": "a1", "method": "csrt"}
    assert len(data["frames"]) == n
    f = data["frames"]
    assert set(f[0]) == {"t", "x", "y", "w", "h", "conf"}
    assert all(0 <= r["x"] <= 1 and 0 <= r["y"] <= 1 and r["x"] + r["w"] <= 1.0001 for r in f)
    assert f[40]["conf"] == 0.0 and 0.2 < f[40]["x"] < 0.3  # interpolated
    raw_jitter = sum(abs(b[1] - a[1]) for a, b in zip(boxes[:30], boxes[1:31], strict=True))
    smooth_jitter = sum(abs(b["y"] - a["y"]) * 1080 for a, b in zip(f[:30], f[1:31], strict=True))
    assert smooth_jitter < raw_jitter / 3
    assert TrackFile.model_validate(data).frames[5].t == pytest.approx(5 / FPS, abs=1e-4)


# ------------------------------------------------------------------------------- reframe


def test_crop_sizes() -> None:
    c = crop_size(1920, 1080, "9:16")
    assert (c.w, c.h, c.axis) == (608, 1080, "x")
    c = crop_size(1920, 1080, "1:1")
    assert (c.w, c.h, c.axis) == (1080, 1080, "x")
    c = crop_size(1920, 1080, "4:5")
    assert (c.w, c.h, c.axis) == (864, 1080, "x")
    c = crop_size(1080, 1920, "1:1")
    assert (c.w, c.h, c.axis) == (1080, 1080, "y")


def _face(cx: float, cy: float = 540, size: float = 200, score: float = 0.9):
    return (cx - size / 2, cy - size / 2, size, size, score)


def test_reframe_follows_face_and_cuts_at_scenes() -> None:
    rnd = random.Random(11)
    samples = []
    for i in range(0, 240, 4):  # 8 s at 30 fps, detection every 4 frames
        t = i / FPS
        if t < 4:
            cx = 400 + (1400 - 400) * t / 4 + rnd.uniform(-15, 15)  # walks right
            cands = [_face(cx), _face(1700, size=60, score=0.7)]  # small background face
        else:
            cx = 1500 + rnd.uniform(-10, 10)
            cands = [_face(cx)]
        samples.append((t, cands))
    plan = plan_reframe(
        samples, width=1920, height=1080, target="9:16", duration=8.0,
        scenes=[(0.0, 4.0), (4.0, 8.0)], fps=FPS,
    )  # fmt: skip
    kfs = plan["keyframes"]
    assert plan["crop_px"] == {"w": 608, "h": 1080} and plan["axis"] == "x"
    assert 4 <= len(kfs) < len(samples) / 3  # simplified, not one keyframe per detection
    ts = [k["t"] for k in kfs]
    assert ts == sorted(ts)
    for k in kfs:
        v = k["v"]
        assert v["w"] == pytest.approx(608 / 1920 * 100, abs=1e-3) and v["h"] == 100
        assert 0 <= v["x"] <= 100 - v["w"] + 1e-6 and v["y"] == 0
        assert k["ease"] in ("linear", "hold")
    scene1 = [k for k in kfs if k["t"] < 4.0]
    scene2 = [k for k in kfs if k["t"] >= 4.0]
    assert scene1[-1]["ease"] == "hold" and scene2[0]["t"] == 4.0  # jump at the cut
    # no jumps inside a scene: pan speed bounded
    for seg in (scene1, scene2):
        for a, b in zip(seg, seg[1:], strict=False):
            speed = abs(b["v"]["x"] - a["v"]["x"]) / max(1e-6, b["t"] - a["t"])
            assert speed <= MAX_PAN_PER_S * 100 + 1.0
    assert scene1[-1]["v"]["x"] > scene1[0]["v"]["x"] + 20  # followed the walking face
    center2 = (scene2[0]["v"]["x"] + scene2[0]["v"]["w"] / 2) / 100 * 1920
    assert abs(center2 - 1500) < 40  # second scene starts on the subject, not swept
    assert [s["subject"] for s in plan["per_scene"]] == ["face", "face"]


def test_reframe_static_jitter_is_still_and_no_face_is_centered() -> None:
    rnd = random.Random(5)
    samples = [(i / 8, [_face(900 + rnd.uniform(-20, 20))]) for i in range(32)]  # 0..4 s
    samples += [(4 + i / 8, []) for i in range(16)]  # 4..6 s: nobody
    plan = plan_reframe(
        samples, width=1920, height=1080, target="9:16", duration=6.0,
        scenes=[(0.0, 4.0), (4.0, 6.0)], fps=FPS,
    )  # fmt: skip
    scene1 = [k for k in plan["keyframes"] if k["t"] < 4.0]
    xs = {round(k["v"]["x"], 3) for k in scene1}
    assert len(xs) == 1 and len(scene1) <= 3  # dead zone: the window does not wobble
    scene2 = [k for k in plan["keyframes"] if k["t"] >= 4.0]
    assert all(math.isclose(k["v"]["x"], (100 - k["v"]["w"]) / 2, abs_tol=1e-3) for k in scene2)
    assert plan["per_scene"][1]["fallback"] == "center"
    assert plan["per_scene"][1]["subject"] == "center"


def test_reframe_vertical_source_moves_y() -> None:
    samples = [(i / 8, [_face(540, cy=600)]) for i in range(16)]
    plan = plan_reframe(samples, width=1080, height=1920, target="1:1", duration=2.0, fps=FPS)
    v = plan["keyframes"][0]["v"]
    assert plan["axis"] == "y" and v["x"] == 0 and v["w"] == 100
    assert v["h"] == pytest.approx(1080 / 1920 * 100, abs=1e-3) and v["y"] > 0
