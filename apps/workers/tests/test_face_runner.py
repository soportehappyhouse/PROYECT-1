"""Sprint 4 M1: FaceFusion runner (argv snapshot, errors, models, range + strength) with the fake
facefusion.py of scripts/e2e (no downloads, no tool venv: CI never creates them)."""

from __future__ import annotations

import json
import subprocess
import sys
import zlib
from pathlib import Path

import pytest
from conftest import lavfi_video, needs_ffmpeg

from studio_workers import packs
from studio_workers.config import REPO_ROOT, get_settings
from studio_workers.errors import CodedError
from studio_workers.face import tool
from studio_workers.face.engine import FaceCanceled, FaceEngine
from studio_workers.face.runner import (
    HeadlessArgs,
    RunOutcome,
    classify,
    headless_args,
)
from studio_workers.face.schemas import FaceSelector, FaceSwapWorkerRequest
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo
from studio_workers.packs import PackRequiredError

FAKE_APP = REPO_ROOT / "scripts" / "e2e" / "fake_facefusion"


def test_headless_argv_snapshot() -> None:
    a = HeadlessArgs(
        sources=[Path("/s/consent/persons/p/photos/a.png"), Path("/s/b.jpg")],
        target=Path("/s/renders/face/j/source.mp4"),
        output=Path("/s/renders/face/j/ff.mp4"),
        model="hyperswap_1a_256",
        enhancer=True,
        enhancer_blend=80,
        selector_mode="reference",
        reference_frame=12,
        reference_index=1,
        reference_distance=0.3,
        device="cuda",
        temp_dir=Path("/s/tmp/ff/t1"),
        jobs_dir=Path("/s/tmp/ff/t1/jobs"),
    )
    p = lambda s: str(Path(s))  # noqa: E731 - native separators (Windows CI)
    assert headless_args(a) == [
        "headless-run",
        "--source-paths", p("/s/consent/persons/p/photos/a.png"), p("/s/b.jpg"),
        "--target-path", p("/s/renders/face/j/source.mp4"),
        "--output-path", p("/s/renders/face/j/ff.mp4"),
        "--processors", "face_swapper", "face_enhancer",
        "--face-swapper-model", "hyperswap_1a_256",
        "--face-enhancer-model", "gfpgan_1.4",
        "--face-enhancer-blend", "80",
        "--face-selector-mode", "reference",
        "--reference-frame-number", "12",
        "--reference-face-position", "1",
        "--reference-face-distance", "0.3",
        "--face-selector-order", "left-right",
        "--face-detector-model", "yolo_face",
        "--face-mask-types", "box", "occlusion",
        "--execution-providers", "cuda",
        "--execution-device-ids", "0",
        "--execution-thread-count", "4",
        "--video-memory-strategy", "moderate",
        "--output-video-encoder", "libx264",
        "--output-video-quality", "80",
        "--output-audio-encoder", "aac",
        "--temp-path", p("/s/tmp/ff/t1"),
        "--jobs-path", p("/s/tmp/ff/t1/jobs"),
        "--download-providers", "github",
        "--log-level", "info",
    ]  # fmt: skip
    one = headless_args(
        HeadlessArgs(**{**a.__dict__, "selector_mode": "one", "enhancer": False, "device": "cpu"})
    )
    assert "face_enhancer" not in one and "--reference-frame-number" not in one
    assert one[one.index("--processors") + 1 : one.index("--face-swapper-model")] == [
        "face_swapper"
    ]
    assert one[one.index("--execution-providers") + 1] == "cpu"
    assert all(isinstance(x, str) for x in one)


def test_classify_nsfw_tool_failed_and_launch_errors() -> None:
    nsfw = classify(
        RunOutcome(1, ["[FACEFUSION.CONTENT_ANALYSER] Explicit content detected"]), False
    )
    assert nsfw is not None and nsfw.code == "CONTENT_BLOCKED"
    silent = classify(RunOutcome(1, ["[FACEFUSION.CORE] Processing step 1"]), False)
    assert silent is not None and silent.code == "CONTENT_BLOCKED"  # heuristic: no error line
    cuda = classify(
        RunOutcome(1, ["loading", "error: CUDAExecutionProvider is not available"]), False
    )
    assert cuda is not None and cuda.code == "TOOL_FAILED"
    assert "CUDAExecutionProvider" in cuda.line and cuda.tail[-1].startswith("error")
    launch = classify(
        RunOutcome(2, ['{"event":"error","code":"LAUNCH_FAILED","message":"no onnxruntime"}']),
        False,
    )
    assert launch is not None and launch.code == "TOOL_FAILED" and launch.line == "no onnxruntime"
    no_out = classify(RunOutcome(0, ["done"]), False)
    assert no_out is not None and no_out.code == "TOOL_FAILED"
    assert classify(RunOutcome(0, ["done"]), True) is None


def _write_model(folder: Path, name: str, data: bytes, hsh: str | None = None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.onnx").write_bytes(data)
    crc = f"{zlib.crc32(data) & 0xFFFFFFFF:08x}"
    (folder / f"{name}.hash").write_text(hsh if hsh is not None else crc, "utf-8")


def test_models_presence_hash_and_crc32(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "models"
    folder = packs.facefusion_dir(root)
    names = packs.facefusion_models_for("hyperswap_1a_256", True)
    assert names[-2:] == ["hyperswap_1a_256", "gfpgan_1.4"] and "arcface_w600k_r50" in names
    assert packs.facefusion_models_for("ghost_1_256", False)[-2:] == [
        "ghost_1_256",
        "crossface_ghost",
    ]
    # the pinned CRC32 of the real files: fake bytes are checked against their own .hash
    table = {
        k: packs.FaceFusionModel(**{**v.__dict__, "crc32": None})
        for k, v in packs.FACEFUSION_MODELS.items()
    }
    monkeypatch.setattr(packs, "FACEFUSION_MODELS", table)
    assert packs.facefusion_models_ready(root, names) == names  # nothing on disk
    for n in names:
        _write_model(folder, n, f"onnx {n}".encode())
    assert packs.verify_facefusion_models(root, names) == []
    stamp = json.loads((folder / packs.FACEFUSION_CRC_STAMP).read_text("utf-8"))
    assert set(stamp) == set(names)
    (folder / "xseg_1.onnx").write_bytes(b"corrupt!")  # same .hash, other bytes
    assert packs.verify_facefusion_models(root, names) == ["xseg_1"]
    (folder / "nsfw_2.hash").unlink()
    assert packs.facefusion_models_ready(root, names) == ["nsfw_2"]
    # engine: missing/corrupt model -> PACK_REQUIRED before launching anything
    engine = FaceEngine(get_settings(), GpuBudget(use_cuda=False))
    monkeypatch.setattr(engine.settings.__class__, "models_root", property(lambda _s: root))
    with pytest.raises(PackRequiredError) as err:
        engine._require_models("hyperswap_1a_256", True)
    assert err.value.pack_id == "faceswap"
    with pytest.raises(PackRequiredError) as extra:
        engine._require_models("inswapper_128_fp16", False)
    assert extra.value.pack_id in ("faceswap", "faceswap-extra")


def test_pinned_hash_mismatch_is_reported(tmp_path: Path) -> None:
    folder = packs.facefusion_dir(tmp_path)
    _write_model(folder, "hyperswap_1a_256", b"x", hsh="00000000")
    assert packs.facefusion_models_ready(tmp_path, ["hyperswap_1a_256"]) == ["hyperswap_1a_256"]
    _write_model(folder, "hyperswap_1a_256", b"x", hsh="79e50d4b")
    assert packs.facefusion_models_ready(tmp_path, ["hyperswap_1a_256"]) == []
    assert packs.verify_facefusion_models(tmp_path, ["hyperswap_1a_256"]) == ["hyperswap_1a_256"]


# ---------------------------------------------------------------- engine with the fake tool


class Spy:
    """subprocess.Popen spy: records argv + kwargs (shell must be False, cwd fixed)."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append((list(argv), kwargs))
        return subprocess.Popen(argv, **kwargs)  # noqa: S603


def fake_command(record: Path | None = None, env_extra: dict[str, str] | None = None):  # type: ignore[no-untyped-def]
    def command(script: str, args: list[str]) -> tuple[list[str], dict[str, str], Path]:
        argv, env, cwd = tool._launch(script, args)
        env = {**env, **(env_extra or {})}
        if record is not None:
            env["FAKE_FACEFUSION_ARGV"] = str(record)
        return argv, env, cwd

    return command


@pytest.fixture
def ff_env(dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    monkeypatch.setenv("FACEFUSION_APP_DIR", str(FAKE_APP))
    monkeypatch.setenv("HF_TOKEN", "should-not-reach-the-child")
    storage, models = dirs
    photos = storage / "consent" / "persons" / "p1" / "photos"
    photos.mkdir(parents=True)
    (photos / "a.png").write_bytes(b"\x89PNG fake")
    return storage, models


def make_engine(**kw) -> FaceEngine:  # type: ignore[no-untyped-def]
    defaults = dict(
        require_models=lambda _m, _e: None,
        licence_ok=lambda _l: True,
        tool_state=lambda: "ready",
        detector_factory=lambda _root: lambda img: [(10.0, 10.0, 30.0, 30.0, 0.9)],
    )
    return FaceEngine(
        get_settings(), kw.pop("budget", GpuBudget(use_cuda=False)), **{**defaults, **kw}
    )


def request(**kw) -> FaceSwapWorkerRequest:  # type: ignore[no-untyped-def]
    base = dict(
        source_paths=["consent/persons/p1/photos/a.png"],
        target_path="media/clip.mp4",
        output_base="renders/face/job1/",
        consent_id="c1",
        licence_ids=["faceswap"],
    )
    return FaceSwapWorkerRequest(**{**base, **kw})


@needs_ffmpeg
def test_swap_range_strength_audio_and_clean_env(ff_env: tuple[Path, Path], tmp_path: Path) -> None:
    storage, _ = ff_env
    lavfi_video(storage / "media" / "clip.mp4", "testsrc2=s=160x90:r=25:d=3")
    spy = Spy()
    record = tmp_path / "argv.json"
    engine = make_engine(command=fake_command(record), spawn=spy)
    steps: list[float] = []
    res = engine.run(
        request(range=(0.5, 1.7), strength=0.6), "task1", lambda p, _m: steps.append(p)
    )
    assert res["output_path"] == "renders/face/job1/faceswap.mp4"
    assert res["device"] == "cpu" and "facefusion_cpu_slow" in res["warnings"]
    assert 28 <= res["frames"] <= 31 and res["fps"] == 25.0
    out = storage / res["output_path"]
    dur = float(
        subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(out),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout  # fmt: skip
    )
    assert abs(dur - 1.2) < 0.15
    assert not (storage / "renders/face/job1/source.mp4").exists()
    assert not (storage / "renders/face/job1/ff.mp4").exists()
    argv, kwargs = spy.calls[0]
    assert kwargs["shell"] is False and isinstance(argv, list)
    assert argv[0] == sys.executable and Path(argv[1]).name == "facefusion.py"
    assert Path(kwargs["cwd"]) == FAKE_APP.resolve()
    assert "HF_TOKEN" not in kwargs["env"] and kwargs["env"]["HF_HUB_OFFLINE"] == "1"
    seen = json.loads(record.read_text("utf-8"))
    assert seen["hf_token"] is False and Path(seen["cwd"]) == FAKE_APP.resolve()
    temp = seen["argv"][seen["argv"].index("--temp-path") + 1]
    assert Path(temp) == storage / "tmp" / "ff" / "task1"
    assert seen["argv"][seen["argv"].index("--face-selector-mode") + 1] == "one"
    assert not (storage / "tmp" / "ff" / "task1").exists()
    assert max(steps) > 0.9 and any(0.08 < p < 0.93 for p in steps)


@needs_ffmpeg
def test_preview_frame_reference_and_no_face(ff_env: tuple[Path, Path], tmp_path: Path) -> None:
    storage, _ = ff_env
    lavfi_video(storage / "media" / "clip.mp4", "testsrc2=s=160x90:r=25:d=2")
    record = tmp_path / "argv.json"
    engine = make_engine(command=fake_command(record))
    sel = FaceSelector(mode="reference", t=1.0, face_index=0)
    res = engine.run(request(preview_t=1.0, selector=sel), "task2")
    assert res["output_path"].endswith("after.png") and res["before_path"].endswith("before.png")
    assert (storage / res["before_path"]).stat().st_size > 0
    argv = json.loads(record.read_text("utf-8"))["argv"]
    assert argv[argv.index("--reference-frame-number") + 1] == "0"
    with pytest.raises(CodedError) as err:
        engine.run(
            request(preview_t=1.0, selector=FaceSelector(mode="reference", t=1.0, face_index=1)),
            "t3",
        )
    assert err.value.code == "NO_FACE" and err.value.status == 422


@needs_ffmpeg
def test_nsfw_and_tool_failure_codes(ff_env: tuple[Path, Path]) -> None:
    storage, _ = ff_env
    lavfi_video(storage / "media" / "clip.mp4", "testsrc2=s=160x90:r=25:d=1")
    nsfw = storage / "consent" / "persons" / "p1" / "photos" / "nsfw-test.png"
    nsfw.write_bytes(b"x")
    engine = make_engine(command=fake_command())
    with pytest.raises(CodedError) as blocked:
        engine.run(request(source_paths=["consent/persons/p1/photos/nsfw-test.png"]), "t4")
    assert blocked.value.code == "CONTENT_BLOCKED" and blocked.value.status == 422
    assert "analizador de contenido" in str(blocked.value)
    failing = make_engine(command=fake_command(env_extra={"FAKE_FACEFUSION_FAIL": "1"}))
    with pytest.raises(CodedError) as failed:
        failing.run(request(), "t5")
    assert failed.value.code == "TOOL_FAILED" and failed.value.status == 502
    assert "CUDAExecutionProvider" in str(failed.value)
    assert any("CUDAExecutionProvider" in line for line in failed.value.details["logTail"])


def test_licence_tool_and_limits_before_launch(ff_env: tuple[Path, Path]) -> None:
    storage, _ = ff_env
    (storage / "media" / "clip.mp4").write_bytes(b"x")
    launched: list[str] = []

    def never(script: str, args: list[str]):  # type: ignore[no-untyped-def]
        launched.append(script)
        raise AssertionError("must not launch")

    with pytest.raises(CodedError) as lic:
        make_engine(command=never, licence_ok=lambda _l: False).run(request(), "t6")
    assert lic.value.code == "LICENCE_REQUIRED" and lic.value.status == 403
    with pytest.raises(CodedError) as missing:
        make_engine(command=never, tool_state=lambda: "python").run(request(), "t7")
    assert missing.value.code == "TOOL_MISSING" and missing.value.status == 409
    assert missing.value.details == {"tool": "facefusion", "state": "python", "packId": "faceswap"}
    assert "Python 3.12" in str(missing.value)
    with pytest.raises(PackRequiredError):

        def no_models(_m: str, _e: bool) -> None:
            raise PackRequiredError("faceswap")

        make_engine(command=never, require_models=no_models).run(request(), "t8")
    with pytest.raises(ValueError):
        make_engine(command=never).run(request(output_base="media/x/"), "t9")
    assert launched == []


@needs_ffmpeg
def test_gpu_budget_cuda_and_fallback(
    ff_env: tuple[Path, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = ff_env
    lavfi_video(storage / "media" / "clip.mp4", "testsrc2=s=160x90:r=25:d=1")
    monkeypatch.setenv("USE_CUDA", "true")
    get_settings.cache_clear()
    record = tmp_path / "argv.json"
    big = GpuBudget(use_cuda=True, probe=lambda: VramInfo("RTX 4050", 6141, 5800, "test"))
    unloaded: list[str] = []
    big.acquire("whisper", 900, lambda: unloaded.append("whisper"))
    res = make_engine(command=fake_command(record), budget=big).run(request(), "t10")
    argv = json.loads(record.read_text("utf-8"))["argv"]
    assert argv[argv.index("--execution-providers") + 1] == "cuda" and res["device"] == "cuda"
    assert unloaded == ["whisper"] and big.resident is None
    small = GpuBudget(use_cuda=True, probe=lambda: VramInfo("RTX 4050", 6141, 1200, "test"))
    res2 = make_engine(command=fake_command(record), budget=small).run(request(), "t11")
    argv2 = json.loads(record.read_text("utf-8"))["argv"]
    assert argv2[argv2.index("--execution-providers") + 1] == "cpu"
    assert GPU_FALLBACK_CPU in res2["warnings"]


@needs_ffmpeg
def test_cancel_kills_the_tree(ff_env: tuple[Path, Path]) -> None:
    import threading
    import time

    storage, _ = ff_env
    lavfi_video(storage / "media" / "clip.mp4", "testsrc2=s=160x90:r=25:d=1")
    engine = make_engine(command=fake_command(env_extra={"FAKE_FACEFUSION_SLEEP": "30"}))
    errors: list[BaseException] = []

    def go() -> None:
        try:
            engine.run(request(), "t12")
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    th = threading.Thread(target=go)
    t0 = time.monotonic()
    th.start()
    for _ in range(200):
        if engine._procs.get("t12"):
            break
        time.sleep(0.05)
    assert engine.cancel("t12") is True
    th.join(timeout=20)
    assert not th.is_alive() and time.monotonic() - t0 < 20
    assert errors and isinstance(errors[0], FaceCanceled)
