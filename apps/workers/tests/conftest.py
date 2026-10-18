from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.main import create_app


@pytest.fixture(autouse=True)
def _fresh_planner_caches() -> Iterator[None]:
    """The planner caches the few-shot pool (``few_shot_pool``) the first time it plans. A test that
    points ``DATASET_DIR`` at a tiny temporary dataset (``/agent/eval`` in test_agent_eval.py) must
    not leave that pool for the tests that run after it: clear the caches around every test."""
    from studio_workers.agent import planner

    caches = (planner.few_shot_pool, planner.fixed_examples, planner.system_prompt)
    for fn in caches:
        fn.cache_clear()
    yield
    for fn in caches:
        fn.cache_clear()


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    storage = tmp_path / "storage"
    models = tmp_path / "models"
    for sub in ("renders", "tmp", "media"):
        (storage / sub).mkdir(parents=True)
    models.mkdir()
    monkeypatch.setenv("STORAGE_DIR", str(storage))
    monkeypatch.setenv("MODELS_DIR", str(models))
    monkeypatch.setenv("USE_CUDA", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "")
    monkeypatch.setenv("FFMPEG_PATH", "")
    services.reset()
    yield storage, models
    services.reset()


@pytest.fixture
def client(dirs: tuple[Path, Path]) -> Iterator[TestClient]:
    with TestClient(create_app()) as c:
        yield c


# ------------------------------------------------------------------ sprint 2 (vision) helpers
import shutil  # noqa: E402
import subprocess  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not on PATH",
)


def lavfi_video(dst: Path, src: str = "testsrc2=s=160x90:r=25:d=2", *extra: str) -> Path:
    """Synthetic H.264 clip (yuv420p) from a lavfi source or filter graph."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src,
         *extra, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(dst)],
        check=True, timeout=120,
    )  # fmt: skip
    return dst


def decoded_alpha(webm: Path, frame: int = 0) -> list[int]:
    """Alpha plane of one frame of a VP9 WebM (libvpx decoder keeps the alpha)."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(webm), "-vf",
         f"select=eq(n\\,{frame}),format=rgba,alphaextract", "-frames:v", "1",
         "-f", "rawvideo", "-"],
        capture_output=True, check=True, timeout=60,
    )  # fmt: skip
    return list(out.stdout)


def count_frames(video: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
         "stream=nb_read_frames", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True, timeout=60,
    )  # fmt: skip
    return int(out.stdout.strip().split(",")[0])
