"""Sprint 3b «Recorte de calidad alta»: alpha refinement of the GPL runner (vision_gpl/refine.py)
on synthetic frames (colourful checkerboard background + a soft-edged disk), the --quality high
CLI path (mock model), the workers' matte route and the matting-hq pack.

The GPL runner is imported here only by the tests (studio_workers never imports it)."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import decoded_alpha, lavfi_video, needs_ffmpeg
from fastapi.testclient import TestClient

from studio_workers import packs, services
from studio_workers.config import get_settings
from studio_workers.packs import PackRequiredError
from studio_workers.vision import frames, gpl
from studio_workers.vision.matte import MatteEngine

np = pytest.importorskip("numpy")
WORKERS = Path(__file__).resolve().parents[1]
if str(WORKERS) not in sys.path:
    sys.path.insert(0, str(WORKERS))

from vision_gpl import ffio, refine, rvm  # noqa: E402

PALETTE = np.array(
    [[230, 30, 40], [30, 200, 60], [40, 60, 230], [250, 220, 20], [220, 40, 220], [20, 220, 220]],
    np.float32,
) / 255  # fmt: skip
SKIN = np.array([0.85, 0.68, 0.55], np.float32)


def scene(h: int = 180, w: int = 240, sq: int = 24, r: float = 50, ramp: float = 3.0):
    """Checkerboard of saturated colours + a uniform disk with a 3 px antialiased edge.
    Returns obs (composited source), true fg, true alpha, distance to the centre, radius."""
    yy, xx = np.mgrid[0:h, 0:w]
    bg = PALETTE[((yy // sq) * 7 + (xx // sq) * 3) % len(PALETTE)]
    d = np.hypot(yy - h / 2, xx - w / 2)
    alpha = np.clip((r - d) / ramp + 0.5, 0, 1).astype(np.float32)
    fg = np.broadcast_to(SKIN, (h, w, 3)).astype(np.float32)
    obs = (alpha[..., None] * fg + (1 - alpha[..., None]) * bg).astype(np.float32)
    return obs, fg, alpha, d, r


def fast_like(obs, alpha):
    """What the user saw with «Rápido» on a colourful background: alpha ~1 px too wide and the
    foreground colour = the mixed source (background colour bleeding into the edge)."""
    ops = refine.NumpyOps()
    return obs.copy(), np.clip(ops.max_filter(alpha, 1), 0, 1)


# ------------------------------------------------------------------------------ refinement


def test_high_quality_reduces_colour_halo_by_40_percent() -> None:
    obs, fg, alpha, d, r = scene()
    band = np.abs(d - r) <= 3  # the 3 px edge band
    fgr, pha = fast_like(obs, alpha)
    before = refine.halo_error(fgr, pha, fg, band)
    f2, a2 = refine.Refiner(refine.HIGH_DEFAULTS, refine.NumpyOps())(obs, fgr, pha)
    after = refine.halo_error(f2, a2, fg, band)
    assert before > 25  # the halo is there: mean colour error ~33/255 in the band
    assert after <= 0.6 * before, (before, after)  # >= 40 % less halo (measured: ~76 %)
    # the no-reference score the runner reports moves the same way
    ops = refine.NumpyOps()
    assert refine.edge_halo(ops, f2, a2) < 0.6 * refine.edge_halo(ops, fgr, pha)
    # alpha preserved away from the edge: interior opaque, background transparent
    assert a2[d < r - 5].min() > 0.99 and a2[d > r + 5].max() < 0.01


def test_despill_alone_keeps_the_alpha() -> None:
    obs, fg, alpha, d, r = scene()
    band = np.abs(d - r) <= 3
    p = refine.RefineParams(despill=True)
    f2, a2 = refine.Refiner(p, refine.NumpyOps())(obs, obs.copy(), alpha)
    assert float(np.abs(a2 - alpha)[band].mean()) < 0.02  # exact alpha stays (only may shrink)
    assert np.array_equal(a2[~band], alpha[~band]) and (a2 <= alpha + 1e-6).all()
    # plain decontamination: the colour error halves with the exact alpha too
    assert refine.halo_error(f2, a2, fg, band) < 0.5 * refine.halo_error(obs, alpha, fg, band)
    # no refinement at all = untouched
    off = refine.Refiner(refine.FAST_DEFAULTS, refine.NumpyOps())(obs, obs, alpha)
    assert off[0] is obs and off[1] is alpha and not refine.FAST_DEFAULTS.active()


def test_mask_guide_zeroes_alpha_outside_dilated_mask() -> None:
    h, w = 60, 80
    ops = refine.NumpyOps()
    obs = np.full((h, w, 3), 0.5, np.float32)
    pha = np.ones((h, w), np.float32)  # the model "sees" a person everywhere
    mask = np.zeros((h, w), np.float32)
    mask[20:40, 30:50] = 1
    p = refine.RefineParams(mask_dilate=4)
    _f, a2 = refine.Refiner(p, ops)(obs, obs, pha, mask)
    assert a2[16:44, 26:54].min() == 1.0  # mask + 4 px kept
    assert a2[:15].max() == 0 and a2[:, :25].max() == 0 and a2[45:].max() == 0


def test_erode_feather_and_temporal_ema() -> None:
    obs, _fg, alpha, d, r = scene(h=120, w=120, r=30)
    ops = refine.NumpyOps()
    area = alpha.sum()
    _f, eroded = refine.Refiner(refine.RefineParams(erode=2), ops)(obs, obs, alpha)
    assert area - eroded.sum() > 2 * np.pi * r * 1.5  # the edge moved ~2 px inwards
    _f, soft = refine.Refiner(refine.RefineParams(feather=2.0), ops)(obs, obs, alpha)
    edge = (alpha > 0) & (alpha < 1)
    assert ((soft > 0.01) & (soft < 0.99)).sum() > 1.5 * edge.sum()  # wider soft edge
    # temporal: an edge pixel that flickers 0.2 <-> 0.8 moves less between frames
    ema = refine.Refiner(refine.RefineParams(temporal=0.5), ops)
    a1, a2 = alpha.copy(), alpha.copy()
    ring = np.abs(d - r) < 1
    a1[ring], a2[ring] = 0.2, 0.8
    _f, o1 = ema(obs, obs, a1)
    _f, o2 = ema(obs, obs, a2)
    assert np.allclose(o1, a1) and np.allclose(o2[ring], 0.5)
    ema.reset()
    assert ema.prev is None


def test_resolve_quality_defaults_and_clamps() -> None:
    assert refine.resolve("fast") == refine.FAST_DEFAULTS
    high = refine.resolve("high")
    assert high.despill and high.erode == 1 and high.feather == 0.7 and high.temporal == 0.2
    p = refine.resolve("high", erode=99, despill=False, feather=None, temporal=3)
    assert (p.erode, p.despill, p.feather, p.temporal) == (20, False, 0.7, 0.9)
    assert refine.resolve("fast", despill=True).active()


def test_torch_ops_match_numpy() -> None:
    torch = pytest.importorskip("torch")
    obs, _fg, alpha, _d, _r = scene(h=90, w=120, r=30)
    fgr, pha = fast_like(obs, alpha)
    mask = (alpha > 0.5).astype(np.float32)
    p = refine.RefineParams(erode=1, feather=0.7, despill=True, temporal=0.2, mask_dilate=3)
    n_f, n_a = refine.Refiner(p, refine.NumpyOps())(obs, fgr, pha, mask)
    t = refine.TorchOps(torch)
    t_f, t_a = refine.Refiner(p, t)(*(torch.from_numpy(x) for x in (obs, fgr, pha, mask)))
    assert np.abs(t_a.numpy() - n_a).max() < 1e-4
    assert np.abs(t_f.numpy() - n_f).max() < 1e-3
    assert abs(refine.edge_halo(t, t_f, t_a) - refine.edge_halo(refine.NumpyOps(), n_f, n_a)) < 0.05


# ------------------------------------------------------------------------------ GPL CLI


def _cli(*args: str) -> list[dict]:
    proc = subprocess.run(
        [sys.executable, "-m", "vision_gpl.rvm", *args],
        capture_output=True, text=True, cwd=WORKERS, timeout=180, env=dict(os.environ),
    )  # fmt: skip
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines() if line]


def _masks(folder: Path, n: int, w: int = 160, h: int = 90) -> Path:
    m = np.zeros((h, w), np.uint8)
    m[h * 2 // 9 : h * 7 // 9, w * 5 // 16 : w * 11 // 16] = 255  # 160x90: [20:70, 50:110]
    for i in range(n):
        frames.write_png(folder / f"{i:05d}.png", m)
    return folder


@needs_ffmpeg
def test_cli_quality_high_mask_compare_and_halo(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=160x90:r=25:d=1")
    masks = _masks(tmp_path / "masks", 25)
    out = tmp_path / "o.webm"
    cmp_png = tmp_path / "o.compare.png"
    events = _cli("--input", str(clip), "--output", str(out), "--mock-model", "--mock-alpha",
                  "255", "--mock-shape", "disk", "--quality", "high", "--mask", str(masks),
                  "--mask-dilate", "2", "--compare-out", str(cmp_png), "--compare-frame", "5",
                  "--chunk", "10")  # fmt: skip
    start, done = events[0], events[-1]
    assert start["quality"] == "high" and start["model"] == "resnet50"
    assert done["event"] == "done" and done["quality"] == "high" and done["model"] == "resnet50"
    assert done["refine"]["despill"] and done["refine"]["erode"] == 1
    assert done["mask_frames"] == 25 and Path(done["compare_path"]) == cmp_png
    assert frames.read_gray(cmp_png).shape == (90, 2 * 160 + 8)  # before | 8 px | after
    halo = done["halo"]
    assert halo["frames"] >= 1 and halo["before"] >= 0 and halo["after"] >= 0
    a = np.array(decoded_alpha(out, 5), np.uint8).reshape(90, 160)
    assert a[:15].max() <= 3 and a[75:].max() <= 3  # alpha 0 outside the dilated mask
    assert a[30:60, 60:100].min() >= 250  # opaque inside


@needs_ffmpeg
def test_cli_fast_default_is_unrefined(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=64x36:r=10:d=1")
    done = _cli("--input", str(clip), "--output", str(tmp_path / "o.webm"), "--mock-model",
                "--compare-out", str(tmp_path / "c.png"))[-1]  # fmt: skip
    assert done["quality"] == "fast" and done["model"] == "mobilenetv3"
    assert "refine" not in done and "compare_path" not in done and not (tmp_path / "c.png").exists()
    assert rvm.auto_downsample(1920, 1080) == 0.2667
    assert rvm.auto_downsample(1920, 1080, "high") == 0.375


@needs_ffmpeg
def test_mask_reader_single_png_and_offset(tmp_path: Path) -> None:
    folder = _masks(tmp_path / "m", 3, 32, 18)
    reader = ffio.MaskReader("ffmpeg", folder, 64, 36, offset=10)
    assert reader.get(9) is None and reader.get(13) is None
    first = np.frombuffer(reader.get(10), np.uint8).reshape(36, 64)
    assert first.max() == 255 and first[0, 0] == 0  # scaled to the video size
    assert reader.get(12) is not None and reader.get(11) is not None  # backwards: reopens
    reader.close()
    single = ffio.MaskReader("ffmpeg", folder / "00001.png", 32, 18)
    assert single.get(0) == single.get(500) and single.used == 2


# ------------------------------------------------------------------------------ workers


def test_refine_args_map_to_cli_flags(tmp_path: Path) -> None:
    args = gpl.refine_args("high", {"erode": 2, "despill": False, "feather": 1.5},
                           tmp_path / "m", tmp_path / "c.png", 7)  # fmt: skip
    assert args[:2] == ["--quality", "high"]
    assert args[2:4] == ["--erode", "2"] and args[4:6] == ["--feather", "1.5"]
    assert "--despill" in args and args[args.index("--despill") + 1] == "off"
    assert args[-6:] == ["--mask", str(tmp_path / "m"), "--compare-out", str(tmp_path / "c.png"),
                         "--compare-frame", "7"]  # fmt: skip
    assert gpl.refine_args() == ["--quality", "fast"]


def test_matting_hq_pack_and_requirement(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    hq = packs.PACKS["matting-hq"]
    items = hq.build_items(Path("/m"), None)
    assert [i.rel for i in items] == [
        "matting/rvm_resnet50_fp16.torchscript",
        "matting/rvm_resnet50_fp32.torchscript",
    ]
    assert [(i.expected.size_bytes, len(i.expected.sha256 or "")) for i in items] == [
        (54_173_764, 64),
        (108_063_684, 64),
    ]  # [V] github release v1.0.0
    assert all(i.url.startswith(packs.RVM_RELEASE) for i in items) and "GPL-3.0" in hq.license
    assert hq.pip == () and hq.post_install_env is not None
    assert packs.FEATURE_PACKS["vision.matte.rvm-hq"] == "matting-hq"
    monkeypatch.setenv("GPL_PYTHON", sys.executable)
    services.reset()
    engine = MatteEngine(get_settings())
    with pytest.raises(PackRequiredError) as err:
        engine.require("rvm", "high")
    assert err.value.pack_id == "matting-hq"
    for name in packs.RVM_HQ_FILES:  # files present (venv: GPL_PYTHON) -> available
        (dirs[1] / "matting").mkdir(exist_ok=True)
        (dirs[1] / "matting" / name).write_bytes(b"x")
    assert engine.rvm_available("high") and not engine.rvm_available("fast")


@needs_ffmpeg
def test_matte_route_quality_high_reports_compare_and_halo(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "p.mp4", "testsrc2=s=160x90:r=25:d=1")
    _masks(storage / "masks" / "j1", 25)
    monkeypatch.setenv("GPL_PYTHON", sys.executable)
    services.reset()
    engine = MatteEngine(get_settings())
    engine.rvm_extra_args = ["--mock-model", "--mock-alpha", "255", "--mock-shape", "disk"]
    monkeypatch.setattr("studio_workers.routers.vision.matte_engine", lambda: engine)
    res = client.post("/vision/matte", json={
        "path": "media/p.mp4", "output_base": "renders/hq", "quality": "high",
        "refine": {"feather": 1.0, "despill": True}, "mask_path": "masks/j1",
    })  # fmt: skip
    assert res.status_code == 200, res.text
    task = services.vision_queue().wait(res.json()["task_id"], 120)
    assert task is not None and task.status == "done", task and task.error
    r = task.result
    assert r["quality"] == "high" and r["rvm_model"] == "resnet50" and r["mask_frames"] == 25
    assert r["refine"]["feather"] == 1.0 and r["refine"]["erode"] == 1  # default of high
    assert r["preview_compare_path"] == "renders/hq.compare.png"
    assert (storage / r["preview_compare_path"]).is_file()
    t = r["timings"]
    assert t["quality"] == "high" and t["refine"]["despill"] and "halo" in t and "halo" in r
    bad = client.post("/vision/matte", json={
        "path": "media/p.mp4", "output_base": "renders/x", "mask_path": "masks/none",
    })  # fmt: skip
    assert bad.status_code == 404
