"""Matting: frame helpers, BiRefNet path with a mocked model (constant alpha), RVM through the
GPL subprocess (``--mock-model``), the JSON-lines protocol, .venv-gpl management and isolation."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import count_frames, decoded_alpha, lavfi_video, needs_ffmpeg
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo
from studio_workers.vision import frames, gpl
from studio_workers.vision.matte import MatteEngine

np = pytest.importorskip("numpy")
WORKERS = Path(__file__).resolve().parents[1]


def _const_alpha(value: int):
    def factory(device: str):
        return lambda rgb: np.full(rgb.shape[:2], value, dtype=np.uint8)

    return factory


def _wait(tid: str, timeout: float = 120):
    task = services.vision_queue().wait(tid, timeout)
    assert task is not None and task.status == "done", task and task.error
    return task


# ------------------------------------------------------------------------------- frames


@needs_ffmpeg
def test_probe_times_reader_png_roundtrip(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "c.mp4", "testsrc2=s=160x90:r=25:d=2")
    info = frames.probe(clip)
    assert (info.width, info.height, info.fps_str, info.frames) == (160, 90, "25/1", 50)
    times = frames.frame_times(clip, info)
    assert len(times) == 50 and times[0] == 0 and times[1] == pytest.approx(0.04)
    got = list(frames.FrameReader(clip, info, start=10, end=19, every=3))
    assert [i for i, _f in got] == [10, 13, 16, 19] and got[0][1].shape == (90, 160, 3)
    mask = np.zeros((90, 160), dtype=np.uint8)
    mask[20:40, 30:70] = 255
    png = frames.write_png(tmp_path / "m.png", mask)
    back = frames.read_gray(png)
    assert back.shape == (90, 160) and int(back[30, 50]) == 255 and int(back[0, 0]) == 0
    assert frames.mask_bbox(back > 127) == (30, 20, 40, 20)
    rgba = np.dstack([np.zeros((90, 160, 3), np.uint8), mask])
    assert int(frames.read_gray(frames.write_png(tmp_path / "a.png", rgba))[30, 50]) == 255


@needs_ffmpeg
def test_chunked_alpha_writer_concat_keeps_alpha(tmp_path: Path) -> None:
    from fractions import Fraction

    w = frames.ChunkedAlphaWriter(tmp_path / "work", 64, 48, Fraction(25), chunk=7)
    for i in range(20):
        w.write(np.full((48, 64, 4), (i * 10, 0, 0, 90), dtype=np.uint8))
    out = w.finish(tmp_path / "o.webm")
    assert len(w.segments) == 3 and frames.webm_has_alpha(out)
    assert count_frames(out) == 20
    for n in (0, 19):  # first and last segment keep the alpha plane after concat -c copy
        alpha = decoded_alpha(out, n)
        assert len(alpha) == 64 * 48 and abs(sum(alpha) / len(alpha) - 90) < 4


# ------------------------------------------------------------------------------- birefnet


def test_matte_requires_packs(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "v.mp4").write_bytes(b"x")
    body = {"path": "media/v.mp4", "output_base": "renders/v"}
    res = client.post("/vision/matte", json={**body, "model": "rvm"})
    assert res.status_code == 409 and res.json()["packId"] == "matting"
    res = client.post("/vision/matte", json={**body, "model": "birefnet"})
    assert res.status_code == 409 and res.json()["packId"] == "matting-image"
    res = client.post("/vision/matte-image", json=body)
    assert res.status_code == 409 and res.json()["packId"] == "matting-image"


@needs_ffmpeg
def test_matte_birefnet_mocked_constant_alpha(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=2")
    engine = MatteEngine(get_settings(), alpha_factory=_const_alpha(128))
    monkeypatch.setattr("studio_workers.routers.vision.matte_engine", lambda: engine)
    res = client.post(
        "/vision/matte",
        json={"path": "media/v.mp4", "model": "birefnet", "output_base": "renders/v-alpha",
              "chunk_frames": 20},
    )  # fmt: skip
    assert res.status_code == 200, res.text
    tid = res.json()["task_id"]
    _wait(tid)
    st = client.get(f"/vision/tasks/{tid}").json()
    assert st["status"] == "done" and st["progress"] == 1.0
    r = st["result"]
    assert r["alpha_path"] == "renders/v-alpha.webm" and r["fps"] == 25.0 and r["frames"] == 50
    assert r["device"] == "cpu" and "birefnet_video_flicker" in r["warnings"]
    alpha = storage / r["alpha_path"]
    assert frames.webm_has_alpha(alpha) and count_frames(alpha) == 50
    for n in (0, 49):
        a = decoded_alpha(alpha, n)
        assert abs(sum(a) / len(a) - 128) < 4
    preview = storage / r["preview_path"]
    assert preview.name == "v-alpha.preview.png" and preview.stat().st_size > 0
    assert abs(int(frames.read_gray(preview).mean()) - 128) < 4
    assert client.get("/vision/tasks/nope").status_code == 404


@needs_ffmpeg
def test_matte_image_png_rgba(client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x64", "-frames:v",
         "1", str(storage / "media" / "foto.png")],
        check=True,
    )  # fmt: skip
    engine = MatteEngine(get_settings(), alpha_factory=_const_alpha(77))
    monkeypatch.setattr("studio_workers.routers.vision.matte_engine", lambda: engine)
    res = client.post(
        "/vision/matte-image", json={"path": "media/foto.png", "output_base": "renders/foto-rec"}
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"path": "renders/foto-rec.png", "device": "cpu"}
    out = storage / "renders" / "foto-rec.png"
    assert out.read_bytes()[25] == 6  # PNG color type 6 = RGBA
    assert int(frames.read_gray(out)[10, 10]) == 77


def test_birefnet_budget_and_cuda_failure(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USE_CUDA", "true")
    services.reset()
    unloaded: list[str] = []
    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 6144, 5000, "t"))
    budget.acquire("whisper:large-v3-turbo", 1800, lambda: unloaded.append("whisper"))
    devices: list[str] = []

    def factory(device: str):
        devices.append(device)
        if device == "cuda":
            raise RuntimeError("CUDA error: out of memory")
        return lambda rgb: rgb[:, :, 0]

    engine = MatteEngine(get_settings(), budget=budget, alpha_factory=factory)
    fn, device, warnings = engine._birefnet()
    assert unloaded == ["whisper"]  # one resident model: whisper unloaded first
    assert devices == ["cuda", "cpu"] and device == "cpu" and GPU_FALLBACK_CPU in warnings
    assert budget.resident is None


# ------------------------------------------------------------------------------- RVM / GPL


def _rvm_engine(monkeypatch: pytest.MonkeyPatch, budget: GpuBudget | None = None) -> MatteEngine:
    monkeypatch.setenv("GPL_PYTHON", sys.executable)
    services.reset()
    engine = MatteEngine(get_settings(), budget=budget)
    engine.rvm_extra_args = ["--mock-model"]
    monkeypatch.setattr("studio_workers.routers.vision.matte_engine", lambda: engine)
    return engine


@needs_ffmpeg
def test_matte_rvm_subprocess_mock(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "p.mp4", "testsrc2=s=160x90:r=25:d=2")
    _rvm_engine(monkeypatch)
    res = client.post(
        "/vision/matte",
        json={"path": "media/p.mp4", "output_base": "renders/p", "chunk_frames": 20},
    )
    assert res.status_code == 200, res.text
    task = _wait(res.json()["task_id"])
    r = task.result
    assert r["model"] == "rvm" and r["device"] == "cpu" and r["frames"] == 50
    assert r["precision"] == "fp32" and r["downsample"] == 1.0  # 160x90: no downsampling
    alpha = storage / r["alpha_path"]
    assert frames.webm_has_alpha(alpha) and count_frames(alpha) == 50
    assert abs(sum(decoded_alpha(alpha, 30)) / (160 * 90) - 200) < 4  # mock alpha = 200
    assert not list((storage / "tmp" / "matte").glob("*/rvm"))  # work dir cleaned
    # perf-rvm.md: the route reports the written file, the alpha codec and the stage timings
    assert r["alpha_path"].endswith(".webm") and r["alpha_codec"] == "vp9"
    assert r["timings"]["bottleneck"] in ("decode", "inference", "encode")
    assert "process_s" in r["timings"] and "startup_s" in r["timings"]


@needs_ffmpeg
def test_rvm_gets_vram_budget_after_unloading_resident(
    dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    clip = lavfi_video(storage / "media" / "p.mp4", "testsrc2=s=64x36:r=10:d=1")
    monkeypatch.setenv("USE_CUDA", "true")
    monkeypatch.setenv("STUDIO_MOCK_CUDA", "1")  # the mock runner pretends CUDA exists
    unloaded: list[str] = []
    free = {"mb": 4000}
    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 6144, free["mb"], "t"))
    budget.acquire("rvc", 1500, lambda: unloaded.append("rvc"))
    assert budget.resident == "rvc"
    free["mb"] = 1200  # e.g. the browser and NVENC use the rest
    engine = _rvm_engine(monkeypatch, budget)
    seen: list[dict] = []
    real = gpl.run_rvm

    def spy(*a, **k):
        seen.append({"vram": k["vram_budget_mb"], "device": k["device"]})
        return real(*a, **k)

    monkeypatch.setattr(gpl, "run_rvm", spy)
    res = engine.matte_video(clip, storage / "renders" / "p.webm", model="rvm", chunk=5)
    assert unloaded == ["rvc"]
    assert seen == [{"vram": 400, "device": "cpu"}]  # 1200 free - 800 reserve < 900 needed
    assert res["device"] == "cpu" and GPU_FALLBACK_CPU in res["warnings"]
    assert budget.resident is None  # released after the subprocess


def _cli(*args: str, env: dict | None = None) -> tuple[int, list[dict]]:
    proc = subprocess.run(
        [sys.executable, "-m", "vision_gpl.rvm", *args],
        capture_output=True, text=True, cwd=WORKERS, timeout=120,
        env={**os.environ, **(env or {})},
    )  # fmt: skip
    return proc.returncode, [json.loads(line) for line in proc.stdout.splitlines() if line]


@needs_ffmpeg
def test_vision_gpl_cli_protocol_chunks_and_resume(tmp_path: Path) -> None:
    clip = lavfi_video(tmp_path / "in.mp4", "testsrc2=s=64x36:r=25:d=2")
    out, work = tmp_path / "out.webm", tmp_path / "work"
    args = ["--input", str(clip), "--output", str(out), "--chunk", "20", "--mock-model",
            "--work-dir", str(work), "--keep-work"]  # fmt: skip
    code, events = _cli(*args)
    assert code == 0
    kinds = [e["event"] for e in events]
    assert kinds[0] == "start" and kinds[-1] == "done"
    assert [e["index"] for e in events if e["event"] == "chunk"] == [0, 1, 2]
    assert any(e["event"] == "progress" and e["progress"] == 1.0 for e in events)
    start, done = events[0], events[-1]
    assert start["frames"] == 50 and start["fps"] == "25/1" and start["downsample"] == 1.0
    assert done["frames"] == 50 and done["device"] == "cpu" and Path(done["output"]) == out
    assert done["precision"] == "fp32" and done["downsample"] == 1.0  # fp16 only on CUDA
    assert count_frames(out) == 50 and frames.webm_has_alpha(out)
    # re-run: every chunk is already done -> resumes at the end, same output
    code, events = _cli(*args)
    assert code == 0 and events[0]["resume_from"] == 60 and events[-1]["frames"] == 50
    # budget too small for the GPU -> warning + CPU
    code, events = _cli(*args[:-1], "--device", "cuda",
                        env={"STUDIO_MOCK_CUDA": "1", "STUDIO_VRAM_BUDGET_MB": "300"})  # fmt: skip
    assert code == 0 and events[0] == {**events[0], "event": "warning", "code": GPU_FALLBACK_CPU}
    assert GPU_FALLBACK_CPU in events[-1]["warnings"]


def test_vision_gpl_cli_error_is_one_json_line(tmp_path: Path) -> None:
    code, events = _cli("--input", str(tmp_path / "nope.mp4"), "--output",
                        str(tmp_path / "o.webm"), "--mock-model")  # fmt: skip
    assert code == 1 and events[-1]["event"] == "error" and events[-1]["message"]


def test_gpl_code_is_isolated() -> None:
    """MIT code never imports the GPL package and the GPL runner never imports studio_workers."""
    for path in (WORKERS / "studio_workers").rglob("*.py"):
        text = path.read_text("utf-8")
        assert "import vision_gpl" not in text and "from vision_gpl" not in text, path
    for path in (WORKERS / "vision_gpl").rglob("*.py"):
        text = path.read_text("utf-8")
        assert "import studio_workers" not in text and "from studio_workers" not in text, path
    assert "GPL-3.0" in (WORKERS / "vision_gpl" / "__init__.py").read_text("utf-8")


def test_ensure_gpl_venv_with_fake_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    venv = tmp_path / ".venv-gpl"
    site = tmp_path / "site"
    site.mkdir()
    calls: list[list[str]] = []

    def runner(cmd: list[str], on_line) -> int:
        calls.append(cmd)
        if cmd[1:3] == ["-m", "venv"]:
            py = gpl.venv_python(venv)
            py.parent.mkdir(parents=True)
            py.write_text("")
        on_line("ok")
        return 0

    monkeypatch.setattr(gpl, "_site_packages", lambda py: site)
    assert gpl.status(venv)["state"] == "missing"
    lines: list[str] = []
    assert gpl.ensure_venv(venv, use_cuda=True, on_line=lines.append, runner=runner,
                           share_torch=True) == "ejecutado"  # fmt: skip
    assert calls[0][1:] == ["-m", "venv", str(venv)]
    pip = calls[1]
    assert pip[1:4] == ["-m", "pip", "install"] and str(gpl.GPL_REQUIREMENTS) in pip
    assert "--extra-index-url" not in pip  # torch shared with the main venv: no cu128 download
    assert (site / gpl.SHARE_PTH).read_text("utf-8").strip()
    assert gpl.status(venv)["state"] == "ready"
    assert gpl.ensure_venv(venv, use_cuda=True, runner=runner) == "omitido"
    (venv / gpl.STAMP).write_text("otrohash cpu\n", "utf-8")  # requirements changed
    assert gpl.status(venv)["state"] == "stale"
    calls.clear()
    gpl.ensure_venv(venv, use_cuda=True, runner=runner, share_torch=False)
    assert not (site / gpl.SHARE_PTH).exists()
    assert gpl.CU128_INDEX in calls[0]  # no venv re-creation; pip with the cu128 index
    with pytest.raises(RuntimeError, match="pip install"):
        gpl.ensure_venv(venv, use_cuda=False, runner=lambda c, o: 1, force=True)
