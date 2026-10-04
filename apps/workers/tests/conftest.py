from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.main import create_app


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
