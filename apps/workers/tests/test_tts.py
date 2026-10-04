import shutil
import sys
import types
import wave
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from studio_workers.routers import tts as tts_router
from studio_workers.tts.providers import PiperProvider


@dataclass
class FakeSynthesisConfig:
    speaker_id: int | None = None
    length_scale: float | None = None
    noise_scale: float | None = None
    noise_w_scale: float | None = None
    normalize_audio: bool = True
    volume: float = 1.0


class FakeVoice:
    last_config: FakeSynthesisConfig | None = None

    def synthesize_wav(self, text: str, wav_file: wave.Wave_write, syn_config=None) -> None:
        FakeVoice.last_config = syn_config
        wav_file.setframerate(22050)
        wav_file.setsampwidth(2)
        wav_file.setnchannels(1)
        wav_file.writeframes(b"\x00\x00" * 22050)  # 1 second


@pytest.fixture
def fake_piper(dirs, monkeypatch: pytest.MonkeyPatch):
    module = types.ModuleType("piper")
    module.SynthesisConfig = FakeSynthesisConfig  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "piper", module)
    monkeypatch.setattr(tts_router, "require_module", lambda *_: None)
    monkeypatch.setattr(PiperProvider, "_load", lambda self, voice: FakeVoice())
    _, models = dirs
    (models / "piper").mkdir(exist_ok=True)
    (models / "piper" / "es_AR-daniela-high.onnx").write_bytes(b"onnx")
    (models / "piper" / "es_AR-daniela-high.onnx.json").write_text(
        '{"audio":{"sample_rate":22050}}'
    )
    return module


def test_voices_lists_installed_and_catalog(client: TestClient, fake_piper) -> None:
    voices = client.get("/tts/voices").json()
    by_id = {v["id"]: v for v in voices}
    assert by_id["es_AR-daniela-high"]["installed"] is True
    assert by_id["es_AR-daniela-high"]["default"] is True
    assert by_id["es_MX-claude-high"]["installed"] is False
    assert {"es_ES-davefx-medium", "es_ES-carlfm-x_low", "es_MX-ald-medium"} <= set(by_id)
    assert all(v["provider"] == "piper" for v in voices)  # no cloud keys -> no cloud voices


def test_providers_without_keys_are_not_configured(client: TestClient) -> None:
    providers = {p["id"]: p for p in client.get("/tts/providers").json()}
    assert providers["piper"]["status"] == "local"
    assert providers["openai"] == {
        "id": "openai",
        "name": "OpenAI TTS",
        "enabled": False,
        "status": "no configurado",
    }
    assert providers["elevenlabs"]["status"] == "no configurado"


def test_cloud_provider_disabled_returns_409(client: TestClient) -> None:
    res = client.post(
        "/tts",
        json={"text": "hola", "voice": "nova", "outputPath": "renders/a.wav", "provider": "openai"},
    )
    assert res.status_code == 409
    assert res.json()["code"] == "PROVIDER_NOT_CONFIGURED"


def test_piper_synthesis_wav(client: TestClient, dirs, fake_piper) -> None:
    storage, _ = dirs
    res = client.post(
        "/tts",
        json={
            "text": "Hola che",
            "voice": "es_AR-daniela-high",
            "speed": 2.0,
            "noiseScale": 0.5,
            "outputPath": "renders/t1.wav",
            "jobId": "t1",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {
        "path": "renders/t1.wav",
        "durationSec": 1.0,
        "wavPath": "renders/t1.wav",
        "sampleRate": 22050,
        "provider": "piper",
    }
    assert (storage / "renders" / "t1.wav").is_file()
    assert FakeVoice.last_config is not None
    assert FakeVoice.last_config.length_scale == 0.5  # speed 2x -> half the phoneme length
    assert FakeVoice.last_config.noise_scale == 0.5
    assert client.get("/jobs/t1").json()["status"] == "succeeded"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_piper_synthesis_mp3(client: TestClient, dirs, fake_piper) -> None:
    storage, _ = dirs
    res = client.post(
        "/tts",
        json={
            "text": "Hola",
            "voice": "es_AR-daniela-high",
            "outputPath": "renders/t2.wav",
            "format": "mp3",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["path"] == "renders/t2.mp3"
    assert (storage / "renders" / "t2.mp3").stat().st_size > 0


def test_missing_voice_is_409(client: TestClient, dirs, monkeypatch) -> None:
    monkeypatch.setattr(tts_router, "require_module", lambda *_: None)
    res = client.post(
        "/tts", json={"text": "hola", "voice": "es_MX-claude-high", "outputPath": "renders/x.wav"}
    )
    assert res.status_code == 409
    assert res.json()["code"] == "VOICE_NOT_INSTALLED"


def test_openai_provider_enabled_with_key(dirs, monkeypatch) -> None:
    from studio_workers import services

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    services.reset()
    providers = services.tts_providers()
    assert providers["openai"].info().status == "configurado"
    assert len(providers["openai"].voices()) == 6
