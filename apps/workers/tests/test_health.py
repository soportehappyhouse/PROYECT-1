from fastapi.testclient import TestClient

from studio_workers.main import app

client = TestClient(app)


def test_health_contract() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert set(body["capabilities"]) == {"whisper", "piper", "rvc"}


def test_stubs_return_501() -> None:
    res = client.post("/tts", json={"text": "hola", "voice": "x", "outputPath": "renders/a.wav"})
    assert res.status_code == 501
