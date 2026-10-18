"""Sprint 6 M1: task ``stt.words`` (POST /transcribe/words + GET/POST /transcribe/tasks/{id})."""

from __future__ import annotations

import json
import time
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studio_workers.config import get_settings
from studio_workers.routers import transcribe as transcribe_router
from studio_workers.stt.engine import WhisperEngine
from studio_workers.stt.words import noise_floor, rms_db

RATE = 16000
DURATION_S = 20.0


def write_wav(path: Path) -> None:
    """20 s: speech-like tone in [0.5 k, 0.5 k + 0.35] for word k, quiet noise elsewhere, and a
    louder «eh» (no word) in the gap after word 4 (word 4 is short: 2.0–2.1 s)."""
    t = np.arange(int(RATE * DURATION_S)) / RATE
    rng = np.random.default_rng(1)
    x = rng.normal(0, 0.0005, t.size)
    for k in range(40):
        a, b = 0.5 * k, 0.5 * k + (0.1 if k == 4 else 0.35)
        m = (t >= a) & (t < b)
        x[m] += 0.3 * np.sin(2 * np.pi * 220 * t[m])
    m = (t >= 2.15) & (t < 2.45)  # inside the 400 ms gap after word 4
    x[m] += 0.1 * np.sin(2 * np.pi * 180 * t[m])
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


class FakeModel:
    """40 words in 10 segments of 4; word 4 ends early (2.1 s): 400 ms gap before word 5."""

    def __init__(self, delay: float = 0.0) -> None:
        self.kwargs: dict[str, Any] = {}
        self.yielded = 0
        self.delay = delay

    def transcribe(self, path: str, **kwargs: Any):
        self.kwargs = kwargs

        def gen():
            for s in range(10):
                if self.delay:
                    time.sleep(self.delay)
                words = []
                for k in range(4 * s, 4 * s + 4):
                    a = 0.5 * k
                    b = a + (0.1 if k == 4 else 0.35)
                    words.append(SimpleNamespace(start=a, end=b, word=f" w{k}", probability=0.9))
                self.yielded += 1
                yield SimpleNamespace(
                    start=words[0].start,
                    end=words[-1].end,
                    text=" ".join(w.word.strip() for w in words),
                    words=words,
                )

        return gen(), SimpleNamespace(language="es", duration=DURATION_S)


@pytest.fixture
def fake(dirs, monkeypatch: pytest.MonkeyPatch) -> FakeModel:
    model = FakeModel()
    engine = WhisperEngine(get_settings(), factory=lambda *a, **k: model)
    monkeypatch.setattr(transcribe_router, "whisper_engine", lambda: engine)
    monkeypatch.setattr(transcribe_router, "require_module", lambda *_: None)
    transcribe_router.transcribe_queue.cache_clear()
    storage, _ = dirs
    write_wav(storage / "tmp" / "a.wav")
    return model


def wait_done(client: TestClient, task_id: str, timeout: float = 15) -> dict[str, Any]:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        body = client.get(f"/transcribe/tasks/{task_id}").json()
        if body["status"] in ("done", "error", "canceled"):
            return body
        time.sleep(0.02)
    raise AssertionError("timeout")


def test_words_task_transcribes_without_vad_and_measures_gaps(
    client: TestClient, fake: FakeModel, dirs
) -> None:
    storage, _ = dirs
    res = client.post(
        "/transcribe/words",
        json={"input_path": "tmp/a.wav", "output_base": "renders/j1", "job_id": "j1"},
    )
    assert res.status_code == 200
    body = wait_done(client, res.json()["task_id"])
    assert body["status"] == "done", body
    # No VAD, threshold 2.0, no conditioning on previous text, word timestamps.
    assert fake.kwargs["vad_filter"] is False
    assert fake.kwargs["hallucination_silence_threshold"] == 2.0
    assert fake.kwargs["condition_on_previous_text"] is False
    assert fake.kwargs["word_timestamps"] is True
    # Progress in seconds of audio.
    assert body["total"] == 20 and body["done"] == 20
    result = body["result"]
    words = [w for s in result["transcript"]["segments"] for w in s["words"]]
    assert len(words) == 40
    assert result["transcript"]["durationSec"] == DURATION_S
    audio = result["audio"]
    assert audio["window_ms"] == 5
    # .f32: one float per 5 ms of the whole file.
    rms = np.frombuffer((storage / audio["rms_db_path"]).read_bytes(), dtype="<f4")
    assert rms.size == int(np.ceil(RATE * DURATION_S / (RATE * 0.005)))
    assert audio["rms_db_path"] == "renders/j1/script-rms.f32"
    # 39 gaps: 150 ms quiet ones + the 400 ms one with the «eh» (voiced).
    gaps = audio["gaps"]
    assert len(gaps) == 39
    long_gap = next(g for g in gaps if abs(g["start"] - 2.1) < 1e-6)
    assert long_gap["voiced"] is True
    assert sum(g["voiced"] for g in gaps) == 1
    assert audio["noise_floor_db"] < -40
    # Files next to the result.
    saved = json.loads((storage / "renders/j1/script-audio.json").read_text("utf-8"))
    assert saved["gaps"] == gaps
    assert (storage / "renders/j1/transcript.json").is_file()


def test_clip_range_passes_clip_timestamps(client: TestClient, fake: FakeModel) -> None:
    res = client.post(
        "/transcribe/words",
        json={
            "input_path": "tmp/a.wav",
            "output_base": "renders/j2",
            "clip_in_s": 5.0,
            "clip_out_s": 10.0,
        },
    )
    body = wait_done(client, res.json()["task_id"])
    assert fake.kwargs["clip_timestamps"] == [5.0, 10.0]
    words = [w for s in body["result"]["transcript"]["segments"] for w in s["words"]]
    assert all(5.0 <= (w["start"] + w["end"]) / 2 <= 10.0 for w in words)
    assert body["total"] == 5


def test_cancel_between_segments(client: TestClient, fake: FakeModel) -> None:
    fake.delay = 0.05
    res = client.post(
        "/transcribe/words", json={"input_path": "tmp/a.wav", "output_base": "renders/j3"}
    )
    task_id = res.json()["task_id"]
    end = time.monotonic() + 5
    while fake.yielded < 2 and time.monotonic() < end:
        time.sleep(0.01)
    cancel = client.post(f"/transcribe/tasks/{task_id}/cancel").json()
    assert cancel["canceled"] is True
    body = wait_done(client, task_id)
    assert body["status"] == "canceled"
    assert fake.yielded < 10


def test_missing_input_is_404(client: TestClient, fake: FakeModel) -> None:
    res = client.post(
        "/transcribe/words", json={"input_path": "tmp/nope.wav", "output_base": "renders/x"}
    )
    assert res.status_code == 404
    assert client.post("/transcribe/tasks/nope/cancel").status_code == 404


def test_envelope_helpers() -> None:
    x = np.zeros(RATE, dtype=np.float32)
    x[RATE // 2 :] = 0.5
    db = rms_db(x, RATE)
    assert db.size == 200
    assert db[0] == -120.0
    assert abs(db[-1] - 20 * np.log10(0.5)) < 0.01
    assert noise_floor(db, 0, 1) == -120.0
