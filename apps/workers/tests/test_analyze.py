"""Scenes (PySceneDetect) and silences/fillers on lavfi-generated media."""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers import analyze
from studio_workers.analyze import Word, find_fillers, merge_cuts, parse_silencedetect, plan_cuts

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True, timeout=60
    )


def _tone_with_gaps(dst: Path) -> Path:
    # tone 0-1 s, silence 1-2.5 s, tone 2.5-3.5 s, silence 3.5-4.5 s, tone 4.5-5 s
    expr = "sin(2*PI*440*t)*0.5*(lt(t\\,1)+between(t\\,2.5\\,3.5)+gte(t\\,4.5))"
    _ffmpeg("-f", "lavfi", "-i", f"aevalsrc='{expr}':s=16000:d=5", str(dst))
    return dst


def _three_color_video(dst: Path) -> Path:
    args: list[str] = []
    for color in ("red", "blue", "green"):
        args += ["-f", "lavfi", "-i", f"color=c={color}:s=160x90:r=25:d=1"]
    _ffmpeg(
        *args,
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(dst),
    )
    return dst


# ------------------------------------------------------------------------------- pure logic


def test_parse_silencedetect_with_open_end() -> None:
    stderr = """
  Duration: 00:00:05.00, start: 0.000000, bitrate: 256 kb/s
[silencedetect @ 0x1] silence_start: 1.002
[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1.498
[silencedetect @ 0x1] silence_start: 4.2
"""
    intervals, duration = parse_silencedetect(stderr)
    assert duration == 5.0
    assert intervals == [(1.002, 2.5), (4.2, None)]


def _w(text: str, s: float, e: float) -> Word:
    return Word(text, s, e)


def test_fillers_rioplatense_rules() -> None:
    words = [
        _w("Eh,", 0.0, 0.3),  # sound filler: always
        _w("este", 0.6, 0.8),  # isolated (pauses on both sides): filler
        _w("es", 1.0, 1.1),
        _w("este", 1.12, 1.3),  # demonstrative inside a phrase: kept
        _w("video", 1.31, 1.7),
        _w("o", 2.0, 2.1),  # "o sea" (two words)
        _w("sea,", 2.1, 2.3),
        _w("el", 2.6, 2.7),  # stutter "el el"
        _w("el", 2.8, 2.9),
        _w("tema", 2.95, 3.3),
        _w("¿viste?", 3.3, 3.6),  # punctuation + pause after
        _w("bueno", 3.9, 4.1),
    ]
    cuts = find_fillers(words)
    texts = [c.get("text") for c in cuts]
    assert texts == ["Eh,", "este", "o sea,", "el el", "¿viste?", "bueno"]
    assert all(c["kind"] == "filler" for c in cuts)
    stutter = cuts[3]
    assert stutter["start"] == 2.6 and stutter["end"] == 2.8


def test_merge_padding_and_totals() -> None:
    merged = merge_cuts(
        [
            {"start": 1.0, "end": 2.0, "kind": "silence"},
            {"start": 2.02, "end": 2.3, "kind": "filler", "text": "eh"},
            {"start": 4.0, "end": 4.5, "kind": "silence"},
        ]
    )
    assert merged == [
        {"start": 1.0, "end": 2.3, "kind": "filler", "text": "eh"},
        {"start": 4.0, "end": 4.5, "kind": "silence"},
    ]
    plan = plan_cuts([(0.0, 0.5), (1.0, 2.5), (4.0, 4.1), (4.6, 5.0)], 5.0, None, padding_ms=120)
    # start/end of the media are not padded; inner silences keep 120 ms next to speech;
    # 4.0-4.1 becomes shorter than 0.15 s after padding and is dropped.
    assert plan["cuts"] == [
        {"start": 0.0, "end": 0.38, "kind": "silence"},
        {"start": 1.12, "end": 2.38, "kind": "silence"},
        {"start": 4.72, "end": 5.0, "kind": "silence"},
    ]
    assert plan["total_removed_s"] == pytest.approx(0.38 + 1.26 + 0.28)


# ---------------------------------------------------------------------------------- silences


@needs_ffmpeg
def test_silencedetect_on_generated_audio(dirs) -> None:
    storage, _ = dirs
    src = _tone_with_gaps(storage / "media" / "gaps.wav")
    intervals, duration = analyze.run_silencedetect(src, -35, 500)
    assert duration == pytest.approx(5.0, abs=0.05)
    assert len(intervals) == 2
    assert intervals[0][0] == pytest.approx(1.0, abs=0.05)
    assert intervals[0][1] == pytest.approx(2.5, abs=0.05)
    assert intervals[1][0] == pytest.approx(3.5, abs=0.05)


@needs_ffmpeg
def test_silences_endpoint_with_transcript_fillers(client: TestClient, dirs) -> None:
    storage, _ = dirs
    _tone_with_gaps(storage / "media" / "gaps.wav")
    res = client.post(
        "/analyze/silences",
        json={
            "path": "media/gaps.wav",
            "padding_ms": 100,
            "transcript": {
                "words": [
                    {"w": "hola", "s": 0.1, "e": 0.5},
                    {"w": "eh", "s": 0.6, "e": 0.9},  # touches the first silence -> merged
                    {"w": "todo", "s": 2.6, "e": 3.0},
                    {"w": "chau", "s": 4.6, "e": 4.9},
                ]
            },
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    kinds = [(c["kind"], round(c["start"], 1), round(c["end"], 1)) for c in body["cuts"]]
    assert kinds[0] == ("filler", 0.6, 2.4)  # "eh" + padded silence 1.1-2.4 merged
    assert kinds[1] == ("silence", 3.6, 4.4)
    assert body["cuts"][0]["text"] == "eh"
    assert body["total_removed_s"] == pytest.approx(
        sum(c["end"] - c["start"] for c in body["cuts"]), abs=1e-3
    )
    assert body["words_source"] == "request"


@needs_ffmpeg
def test_silences_without_transcript_or_whisper_warns(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    _tone_with_gaps(storage / "media" / "gaps.wav")
    monkeypatch.setattr("studio_workers.routers.analyze.module_present", lambda m: False)
    body = client.post("/analyze/silences", json={"path": "media/gaps.wav"}).json()
    assert body["warnings"] == ["fillers_skipped_no_transcript"]
    assert [c["kind"] for c in body["cuts"]] == ["silence", "silence"]
    off = client.post("/analyze/silences", json={"path": "media/gaps.wav", "fillers": False})
    assert "warnings" not in off.json()


@needs_ffmpeg
def test_silences_transcribes_without_vad_by_default(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    storage, _ = dirs
    _tone_with_gaps(storage / "media" / "gaps.wav")
    calls: list[dict] = []

    class FakeEngine:
        def transcribe(self, _src, **kwargs):
            calls.append(kwargs)
            word = SimpleNamespace(word="mmm", start=2.6, end=3.0)
            return SimpleNamespace(
                segments=[SimpleNamespace(words=[word])], warnings=None, model_used="base"
            )

    monkeypatch.setattr("studio_workers.routers.analyze.module_present", lambda m: True)
    monkeypatch.setattr("studio_workers.routers.analyze.whisper_engine", lambda: FakeEngine())
    body = client.post("/analyze/silences", json={"path": "media/gaps.wav"}).json()
    assert calls[-1]["vad"] is False
    assert body["words_source"] == "whisper:base"
    assert any(c["kind"] == "filler" and c["text"] == "mmm" for c in body["cuts"])
    client.post("/analyze/silences", json={"path": "media/gaps.wav", "vad": True})
    assert calls[-1]["vad"] is True


def test_analyze_rejects_paths_outside_storage(client: TestClient, tmp_path: Path) -> None:
    outside = tmp_path / "x.wav"
    outside.write_bytes(b"x")
    assert client.post("/analyze/silences", json={"path": str(outside)}).status_code == 400
    assert client.post("/analyze/silences", json={"path": "../x.wav"}).status_code == 400
    assert client.post("/analyze/scenes", json={"path": "media/none.mp4"}).status_code == 404


# ------------------------------------------------------------------------------------ scenes


def test_scenes_pack_required(client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    (storage / "media" / "v.mp4").write_bytes(b"x")
    monkeypatch.setattr(analyze, "module_present", lambda m: False)
    res = client.post("/analyze/scenes", json={"path": "media/v.mp4"})
    assert res.status_code == 409
    body = res.json()
    assert body["error"] == "PACK_REQUIRED" and body["packId"] == "scenes"


@needs_ffmpeg
def test_scenes_on_generated_video(client: TestClient, dirs) -> None:
    pytest.importorskip("scenedetect")
    pytest.importorskip("cv2")
    storage, _ = dirs
    _three_color_video(storage / "media" / "colors.mp4")
    res = client.post("/analyze/scenes", json={"path": "media/colors.mp4", "min_scene_len_s": 0.3})
    assert res.status_code == 200, res.text
    scenes = res.json()["scenes"]
    assert len(scenes) == 3
    assert [round(s["start"]) for s in scenes] == [0, 1, 2]
    assert scenes[-1]["end"] == pytest.approx(3.0, abs=0.05)
    assert scenes[0]["score"] == 0 and scenes[1]["score"] > 27
