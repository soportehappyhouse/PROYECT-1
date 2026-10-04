from fastapi.testclient import TestClient


def test_health_contract(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert isinstance(body["cuda"], bool)
    assert set(body["capabilities"]) == {"whisper", "piper", "rvc"}
    # additive diagnostics
    assert set(body["models"]) == {"whisper", "piper", "rvc", "rvcBase"}
    assert body["models"]["rvcBase"] == {"rmvpe": False, "hubert": False, "hubertLegacy": False}
    assert "found" in body["ffmpeg"]
    assert "installed" in body["torch"]
    assert "faster-whisper" in body["packages"]


def test_health_reports_installed_models(client: TestClient, dirs) -> None:
    _, models = dirs
    (models / "piper" / "es_AR-daniela-high.onnx").write_bytes(b"x")
    (models / "piper" / "es_AR-daniela-high.onnx.json").write_text("{}")
    snap = models / "whisper" / "models--Systran--faster-whisper-base" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"x")
    voice = models / "rvc" / "mi_voz"
    voice.mkdir(parents=True)
    (voice / "mi_voz.pth").write_bytes(b"x")
    body = client.get("/health").json()
    assert body["models"]["piper"] == ["es_AR-daniela-high"]
    assert body["models"]["whisper"] == ["base"]
    assert body["models"]["rvc"] == ["mi_voz"]


def test_unknown_job_is_404(client: TestClient) -> None:
    assert client.get("/jobs/nope").status_code == 404


def test_log_level_mapping() -> None:
    from studio_workers.__main__ import uvicorn_level

    assert uvicorn_level("warn") == "warning"
    assert uvicorn_level("fatal") == "critical"
    assert uvicorn_level("trace") == "trace"
    assert uvicorn_level("bogus") == "info"
