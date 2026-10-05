from pathlib import Path

from fastapi.testclient import TestClient

from studio_workers.routers import models as models_router


def test_download_piper_endpoint(client: TestClient, dirs, monkeypatch) -> None:
    _, models = dirs

    def fake(root: Path, voice: str, force: bool = False):
        onnx = root / "piper" / f"{voice}.onnx"
        onnx.parent.mkdir(parents=True, exist_ok=True)
        onnx.write_bytes(b"x" * 10)
        return [(onnx, 10, False)]

    monkeypatch.setattr(models_router, "download_voice", fake)
    res = client.post("/models/download", json={"kind": "piper"})
    assert res.status_code == 200, res.text
    assert res.json() == {
        "kind": "piper",
        "id": "es_AR-daniela-high",
        "files": [{"path": "piper/es_AR-daniela-high.onnx", "sizeBytes": 10, "skipped": False}],
    }


def test_download_rejects_bad_kind(client: TestClient) -> None:
    assert client.post("/models/download", json={"kind": "nope"}).status_code == 422
