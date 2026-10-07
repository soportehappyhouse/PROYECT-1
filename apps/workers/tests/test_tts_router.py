"""Sprint 4 M2: POST /tts with provider "chatterbox", provider/voice listing and the pack
``tts-chatterbox`` (file list by variant, post-install V2 fallback). The bridge runs with
``--mock`` on this interpreter (CHATTERBOX_PYTHON) through tools/launch.py; no torch, no network.
"""

from __future__ import annotations

import json
import shutil
import sys
import wave
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from studio_workers import packs, services
from studio_workers.models_manifest import Manifest
from studio_workers.tts import chatterbox as cb


def write_wav(path: Path, seconds: float = 6.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24_000)
        w.writeframes(b"\x10\x00" * int(24_000 * seconds))
    return path


def dominant_hz(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
        rate = w.getframerate()
    spec = np.abs(np.fft.rfft(data))
    return float(np.fft.rfftfreq(len(data), 1 / rate)[int(np.argmax(spec[1:])) + 1])


@pytest.fixture
def mock_tool(dirs, monkeypatch: pytest.MonkeyPatch):
    """Pack reported installed, bridge = this interpreter with --mock."""
    monkeypatch.setenv("CHATTERBOX_PYTHON", sys.executable)
    real = packs.is_installed
    monkeypatch.setattr(
        packs, "is_installed", lambda pid, root: pid == cb.PACK_ID or real(pid, root)
    )
    services.chatterbox_client().extra_args = ["--mock"]
    services.chatterbox_client().idle_s = 0
    return dirs


def tts(client: TestClient, **body):
    payload = {"text": "Hola, che. ¿Todo bien?", "voice": "chatterbox:multilingual"}
    payload.update(provider="chatterbox", outputPath="renders/c1.wav", jobId="c1")
    payload.update(body)
    return client.post("/tts", json=payload)


# ------------------------------------------------------------------------------- listing


def test_providers_and_voices_without_pack(client: TestClient, monkeypatch) -> None:
    monkeypatch.delenv("CHATTERBOX_PYTHON", raising=False)
    providers = {p["id"]: p for p in client.get("/tts/providers").json()}
    assert providers["chatterbox"] == {
        "id": "chatterbox",
        "name": "Chatterbox (local, GPU)",
        "enabled": False,
        "status": "falta paquete",
        "packId": "tts-chatterbox",
        "installed": False,
        "supportsClone": True,
        "models": ["mtl-v3", "mtl-v2"],
        "languages": list(cb.LANGUAGES),
        "gpu": True,
    }
    assert len(providers["chatterbox"]["languages"]) == 23
    assert providers["piper"]["status"] == "local"  # Piper stays the default local provider
    assert not [v for v in client.get("/tts/voices").json() if v["provider"] == "chatterbox"]


def test_chatterbox_without_pack_is_409_pack_required(client: TestClient) -> None:
    res = tts(client)
    assert res.status_code == 409
    body = res.json()
    assert body["code"] == "PACK_REQUIRED" and body["packId"] == "tts-chatterbox"
    assert body["name_es"] == "Voz avanzada (Chatterbox: español y clonación)"


# ------------------------------------------------------------------------------- synthesis


def test_chatterbox_mock_synthesis(client: TestClient, mock_tool) -> None:
    storage, _ = mock_tool
    res = tts(client, exaggeration=0.7, cfg=0.3, seed=1)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["path"] == "renders/c1.wav" and body["wavPath"] == "renders/c1.wav"
    assert body["provider"] == "chatterbox" and body["sampleRate"] == 24_000
    assert body["device"] == "cpu" and body["warnings"] == ["chatterbox_cpu_slow"]
    assert body["watermark"] == "perth" and body["model"] == "mtl-v3"
    assert body["rtf"] >= 0 and body["durationSec"] > 1
    assert dominant_hz(storage / "renders" / "c1.wav") == pytest.approx(220, abs=3)
    job = client.get("/jobs/c1").json()
    assert job["status"] == "succeeded"
    providers = {p["id"]: p for p in client.get("/tts/providers").json()}
    assert providers["chatterbox"]["enabled"] is True
    assert providers["chatterbox"]["status"] == "local"
    assert providers["chatterbox"]["models"] == ["mtl-v3"]
    voices = [v for v in client.get("/tts/voices").json() if v["provider"] == "chatterbox"]
    assert voices == [
        {
            "provider": "chatterbox",
            "id": "chatterbox:multilingual",
            "name": "Chatterbox multilingüe",
            "language": "es",
            "installed": True,
            "default": False,
        }
    ]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_chatterbox_mp3(client: TestClient, mock_tool) -> None:
    storage, _ = mock_tool
    res = tts(client, format="mp3")
    assert res.status_code == 200, res.text
    assert res.json()["path"] == "renders/c1.mp3"
    assert (storage / "renders" / "c1.mp3").stat().st_size > 0


def test_clone_from_self_reference(client: TestClient, mock_tool) -> None:
    storage, _ = mock_tool
    write_wav(storage / "media" / "self-ref.wav")
    res = tts(client, voiceRef={"path": "media/self-ref.wav", "consent": "self"})
    assert res.status_code == 200, res.text
    assert dominant_hz(storage / "renders" / "c1.wav") == pytest.approx(330, abs=3)


def _voice_mirror(storage, consents) -> None:  # type: ignore[no-untyped-def]
    path = storage / "consent" / "active.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"consents": consents}), "utf-8")


def test_clone_from_person_sample_with_consent_layout(client: TestClient, mock_tool) -> None:
    storage, _ = mock_tool
    write_wav(storage / "consent" / "persons" / "p1" / "voice" / "s1.wav")
    write_wav(storage / "consent" / "persons" / "p1" / "voice" / "s2.wav")
    ref = {"path": "consent/persons/p1/voice/s1.wav", "consent": "c_1"}
    # audit fix 4: without the api's mirror (or with another consent) the clone is refused
    assert tts(client, voiceRef=ref).json()["code"] == "CONSENT_REQUIRED"
    entry = {"personId": "p1", "consentId": "c_1", "scope": "voice", "expires_at": None,
             "photo_paths": [], "sample_paths": ["consent/persons/p1/voice/s1.wav"]}  # fmt: skip
    _voice_mirror(storage, [{**entry, "scope": "face"}])
    assert tts(client, voiceRef=ref).json()["details"]["reason"] == "scope"
    _voice_mirror(storage, [{**entry, "expires_at": "2001-01-01T00:00:00Z"}])
    assert tts(client, voiceRef=ref).json()["details"]["reason"] == "expired"
    _voice_mirror(storage, [entry])
    late = tts(client, voiceRef={**ref, "path": "consent/persons/p1/voice/s2.wav"})
    assert late.status_code == 403  # added after the consent: not listed
    ok = tts(client, voiceRef=ref)
    assert ok.status_code == 200, ok.text
    # the Person was deleted (its consents moved to consent/archive/<id>/): refused
    (storage / "consent" / "archive" / "p1").mkdir(parents=True)
    gone = tts(client, voiceRef={"path": "consent/persons/p1/voice/s1.wav", "consent": "c_1"})
    assert gone.status_code == 403
    assert gone.json()["code"] == "CONSENT_REQUIRED"
    assert gone.json()["details"] == {"personId": "p1", "scope": "voice", "reason": "deleted"}


@pytest.mark.parametrize(
    ("ref", "status", "code"),
    [
        ({"path": "../outside.wav", "consent": "self"}, 400, "BAD_REQUEST"),
        ({"path": "media/../../x.wav", "consent": "self"}, 400, "BAD_REQUEST"),
        ({"path": "/etc/passwd", "consent": "self"}, 400, "BAD_REQUEST"),
        ({"path": "media/missing.wav", "consent": "self"}, 404, "NOT_FOUND"),
        # «Voz propia» never lives under consent/; a Person sample always does
        ({"path": "consent/persons/p2/voice/s.wav", "consent": "self"}, 403, "CONSENT_REQUIRED"),
        ({"path": "media/self-ref.wav", "consent": "c_9"}, 403, "CONSENT_REQUIRED"),
        ({"path": "consent/persons/p2/voice/s.wav", "consent": "bad id!"}, 403, "CONSENT_REQUIRED"),
    ],
)
def test_voice_ref_paths_are_checked(client: TestClient, mock_tool, ref, status, code) -> None:
    storage, _ = mock_tool
    write_wav(storage / "media" / "self-ref.wav")
    write_wav(storage / "consent" / "persons" / "p2" / "voice" / "s.wav")
    res = tts(client, voiceRef=ref)
    assert res.status_code == status, res.text
    assert res.json()["code"] == code


def test_text_limit_and_tool_state(client: TestClient, mock_tool, monkeypatch) -> None:
    long = tts(client, text="a" * 5001)
    assert long.status_code == 400 and "5000" in long.json()["detail"]
    monkeypatch.setattr(cb, "tool_status", lambda: {"state": "stale"})
    stale = tts(client)
    assert stale.status_code == 409
    assert stale.json()["code"] == "TOOL_MISSING"
    assert stale.json()["details"] == {"tool": "chatterbox", "state": "stale", "packId": cb.PACK_ID}
    assert "desactualizado" in stale.json()["detail"]


def test_model_request_other_than_installed_warns(client: TestClient, mock_tool) -> None:
    res = tts(client, model="mtl-v2")
    assert res.status_code == 200, res.text
    assert res.json()["model"] == "mtl-v3"
    assert "chatterbox_model_unavailable" in res.json()["warnings"]


def test_bad_fields_are_422(client: TestClient, mock_tool) -> None:
    assert tts(client, exaggeration=3).status_code == 422
    assert tts(client, cfg=-0.1).status_code == 422
    assert tts(client, language="esp").status_code == 422
    assert tts(client, voiceRef={"path": "media/x.wav"}).status_code == 422


# ------------------------------------------------------------------------------- pack


def test_pack_files_follow_the_variant(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    _, models = dirs
    pack = packs.PACKS["tts-chatterbox"]
    assert packs.FEATURE_PACKS["voice.tts.chatterbox"] == "tts-chatterbox"
    names = lambda: [i.name for i in pack.build_items(models)]  # noqa: E731
    expected_common = {
        "ve.pt",
        "s3gen.pt",
        "grapheme_mtl_merged_expanded_v1.json",
        "conds.pt",
        "Cangjie5_TC.json",
    }
    monkeypatch.setattr(cb, "tool_status", lambda: {"state": "ready", "variant": "v3"})
    assert set(names()) == expected_common | {"t3_mtl23ls_v3.safetensors"}
    monkeypatch.setattr(cb, "tool_status", lambda: {"state": "ready", "variant": "v2"})
    assert set(names()) == expected_common | {"t3_mtl23ls_v2.safetensors"}
    # no venv yet: V3, unless Git is missing (ensure would fall back to PyPI 0.1.7 = V2)
    monkeypatch.setattr(cb, "tool_status", lambda: {"state": "missing"})
    monkeypatch.setattr(packs, "git_available", lambda: True)
    assert "t3_mtl23ls_v3.safetensors" in names()
    monkeypatch.setattr(packs, "git_available", lambda: False)
    assert "t3_mtl23ls_v2.safetensors" in names()
    items = pack.build_items(models)
    assert all(
        i.url.startswith("https://huggingface.co/ResembleAI/chatterbox/resolve/") for i in items
    )
    assert all(i.rel.startswith("chatterbox/") and i.expected.sha256 is None for i in items)
    assert packs.pack_integrity(pack, models, Manifest.load(models)) == "pending"


def test_pack_status_row(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    _, models = dirs
    monkeypatch.delenv("CHATTERBOX_PYTHON", raising=False)
    row = packs.pack_status(packs.PACKS["tts-chatterbox"], models)
    assert row["installed"] is False and row["group"] == "voice"
    assert row["licence_gate"] is None
    assert row["tool"]["id"] == "chatterbox" and row["tool"]["state"] in {"missing", "stale"}
    assert row["license"].startswith("MIT")
    assert any(f["name"].startswith("venv:tools/chatterbox/.venv") for f in row["files"])
    assert 3.5e9 < row["size_bytes"] < 7e9  # venv (CPU or CUDA profile) + ~3 GB of weights


def test_post_install_downloads_the_v2_checkpoint_after_fallback(
    dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, models = dirs
    from studio_workers import toolvenv

    calls: list[dict] = []
    state = {"variant": None}

    def fake_ensure(tool, **kw):
        calls.append({"tool": tool, **kw})
        state["variant"] = "v2"  # git failed -> PyPI fallback
        return "ejecutado"

    monkeypatch.setattr(toolvenv, "ensure", fake_ensure)
    monkeypatch.setattr(
        cb, "tool_status", lambda: {"state": "ready", "variant": state["variant"] or "v3"}
    )
    monkeypatch.setitem(packs.CHATTERBOX_T3_FILES, "v2", ("t3_mtl23ls_v2.safetensors", 16, 8))
    hits: list[str] = []

    commit = "c0ffee" + "0" * 34

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(str(req.url))
        return httpx.Response(200, content=b"0123456789abcdef", headers={"X-Repo-Commit": commit})

    lines: list[str] = []
    assert packs.chatterbox_revision(models) == ("main", False)
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        packs._chatterbox_setup(models, lines.append, client=http)
    assert calls and calls[0]["tool"] == "chatterbox" and calls[0]["use_cuda"] is False
    assert hits == [
        "https://huggingface.co/ResembleAI/chatterbox/resolve/main/t3_mtl23ls_v2.safetensors"
    ]
    assert (models / "chatterbox" / "t3_mtl23ls_v2.safetensors").stat().st_size == 16
    entry = Manifest.load(models).get("chatterbox/t3_mtl23ls_v2.safetensors")
    assert entry and entry.get("verified") == "first-download" and len(entry["sha256"]) == 64
    # audit fix 13: the commit `main` resolved to is recorded; later downloads are pinned to it
    # and a re-downloaded file must have the recorded sha256
    assert entry["revision"] == commit
    assert packs.chatterbox_revision(models) == (commit, True)
    items = {i.name: i for i in packs._chatterbox_items(models, None)}
    assert all(f"/resolve/{commit}/" in i.url for i in items.values())
    assert items["t3_mtl23ls_v2.safetensors"].expected.sha256 == entry["sha256"]
    assert items["ve.pt"].expected.sha256 is None  # never downloaded: trust on first download
    assert any("V2" in ln for ln in lines)
    # second run: the checkpoint is there, nothing is downloaded again
    hits.clear()
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        packs._chatterbox_setup(models, lines.append, client=http)
    assert hits == []


def test_cancel_route_reaches_the_client(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit fix 8: POST /tts/cancel {jobId} -> ChatterboxClient.cancel(jobId)."""
    from studio_workers import services

    seen: list[str | None] = []

    class FakeClient:
        def cancel(self, job_id):  # type: ignore[no-untyped-def]
            seen.append(job_id)
            return job_id == "j9"

    monkeypatch.setattr(services, "chatterbox_client", lambda: FakeClient())
    r = client.post("/tts/cancel", json={"jobId": "j9"})
    assert r.status_code == 200 and r.json() == {"canceled": True, "stopped": True, "jobId": "j9"}
    assert client.post("/tts/cancel", json={}).json()["stopped"] is False
    assert seen == ["j9", None]
