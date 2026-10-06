"""Sprint 3b «Perfil de estilo»: /style/analyze on lavfi media, OCR (fake engine), /style/infer
with a mocked Ollama (qwen2.5vl:3b), packs ocr + vision-llm."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from conftest import needs_ffmpeg
from ollama_fake import FakeOllama

from studio_workers import packs, services
from studio_workers.routers import style as style_router
from studio_workers.style import audio as audio_mod
from studio_workers.style import video as video_mod
from studio_workers.style.analyze import analyze_style, transcript_excerpt
from studio_workers.style.infer import compact_analysis, load_schema, validate_preset
from studio_workers.style.ocr import read_frames

VISION = "qwen2.5vl:3b"
PRESET = {
    "name": "Reels dinámico",
    "canvas": "9:16",
    "cut_rhythm": {"target_shot_s": 2.0, "remove_silences": True, "min_silence_ms": 300},
    "captions": {"style": "reels", "animated": True, "position": "center"},
    "titles": {"template": "title-card", "params": {"title": "Hola"}},
    "transitions": {"type": "cut"},
    "music": {"duck": True, "volume_db": -16},
    "export_preset": "reels-tiktok",
    "notes_es": "Cortes rápidos y subtítulos grandes.",
}


def four_shots(dst: Path, *, seconds: int = 2) -> Path:
    """4 shots of `seconds` (3 hard cuts) + a 440 Hz tone, 320x180 @ 25 fps."""
    d = seconds
    dst.parent.mkdir(parents=True, exist_ok=True)
    srcs = [
        f"testsrc2=s=320x180:r=25:d={d}",
        f"smptebars=s=320x180:r=25:d={d}",
        f"color=c=red:s=320x180:r=25:d={d}",
        f"color=c=blue:s=320x180:r=25:d={d}",
    ]
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for s in srcs:
        args += ["-f", "lavfi", "-i", s]
    args += ["-f", "lavfi", "-i", f"sine=f=440:d={4 * d}:sample_rate=48000"]
    args += [
        "-filter_complex",
        "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
        "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac", "-shortest", str(dst),
    ]  # fmt: skip
    subprocess.run(args, check=True, timeout=120)
    return dst


def punch_in(dst: Path) -> Path:
    """3 s of bars, then the same bars 1.3x closer (a punch-in cut)."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "smptehdbars=s=640x360:r=25:d=6", "-filter_complex",
         "[0]split[a][b];[a]trim=0:3,setpts=PTS-STARTPTS,setsar=1[a1];"
         "[b]trim=3:6,setpts=PTS-STARTPTS,crop=iw/1.3:ih/1.3,scale=640:360,setsar=1[b1];"
         "[a1][b1]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", str(dst)],
        check=True, timeout=120,
    )  # fmt: skip
    return dst


# ------------------------------------------------------------------------------- pure helpers


def test_scene_metadata_parsing_and_shot_stats() -> None:
    text = (
        "frame:0    pts:38400   pts_time:3\nlavfi.scene_score=0.718835\n"
        "frame:1    pts:76800   pts_time:6\nlavfi.scene_score=0.527637\n"
    )
    assert video_mod.parse_scene_metadata(text) == [(3.0, 0.718835), (6.0, 0.527637)]
    scenes = video_mod.scenes_from_cuts([3.0, 3.1, 6.0, 8.95], 9.0)
    assert scenes == [
        {"start": 0.0, "end": 3.0},
        {"start": 3.0, "end": 6.0},
        {"start": 6.0, "end": 9.0},
    ]
    st = video_mod.shot_stats(scenes, 9.0)
    assert st["count"] == 3 and st["median_s"] == 3.0 and st["cuts_per_min"] == pytest.approx(13.33)
    assert [b["count"] for b in st["histogram"]] == [0, 0, 3, 0, 0, 0]
    assert st["histogram"][-1]["max_s"] is None


def test_contact_sheet_geometry() -> None:
    assert video_mod.tile_size(1920, 1080) == (320, 180)
    assert video_mod.tile_size(1080, 1920) == (180, 320)
    assert video_mod.sheet_size(320, 180) == (4 * 320 + 3 * 4 + 8, 6 * 180 + 5 * 4 + 8)
    assert video_mod.frame_indices(240, 24)[:3] == [5, 15, 25]
    assert len(video_mod.frame_indices(10, 24)) == 10


def test_audio_parsers() -> None:
    summary = "  Integrated loudness:\n    I:         -21.8 LUFS\n    Threshold: -31.8 LUFS\n"
    assert audio_mod.parse_lufs(summary) == -21.8
    assert audio_mod.parse_lufs("    I:         -inf LUFS\n") is None
    meta = (
        "frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-21.0\n"
        "frame:1 pts:800 pts_time:0.05\nlavfi.astats.Overall.RMS_level=-inf\n"
    )
    assert audio_mod.parse_metadata(meta, "lavfi.astats.Overall.RMS_level") == [
        (0.0, "-21.0"),
        (0.05, "-inf"),
    ]
    # speech-like: strong 4 Hz modulation; music-like: steady and tonal
    speech = [-20.0, -20.0, -45.0, -20.0, -20.0, -45.0, -20.0, -20.0, -45.0, -20.0]
    steady = [-20.0] * 10
    w = audio_mod.classify_windows(speech + steady, [(0.1, 0.3), (0.6, 0.01)])
    assert w[0]["speech"] is True and w[0]["music"] is False
    assert w[1]["speech"] is False and w[1]["music"] is True
    assert (
        audio_mod.merged_coverage(
            [{"start": 0, "end": 2}, {"start": 1, "end": 3}, {"start": 5, "end": 6}], 10
        )
        == 4.0
    )
    assert transcript_excerpt([{"text": " hola "}, {"text": "mundo"}]) == "hola mundo"
    assert transcript_excerpt([]) is None


def test_ocr_with_fake_engine(tmp_path: Path) -> None:
    thumbs = [tmp_path / "a.jpg", tmp_path / "b.jpg"]

    def engine(path: str):
        box = [[64, 36], [320, 36], [320, 72], [64, 72]]
        if path.endswith("a.jpg"):
            return [[box, "MI TÍTULO", 0.97], [box, "ruido", 0.2]], 0.01
        return [[box, "Mi  título", 0.95], [box, "Ana · Chef", 0.9]], 0.01

    items = read_frames(thumbs, [1.0, 3.5], engine=engine, size_of=lambda _p: (640, 360))
    assert [i["text"] for i in items] == ["MI TÍTULO", "Ana · Chef"]  # repeat dropped
    assert items[0]["bbox"] == [0.1, 0.1, 0.4, 0.1] and items[1]["t"] == 3.5


# --------------------------------------------------------------------------------- analysis


@needs_ffmpeg
@pytest.mark.parametrize("detector", ["ffmpeg", "auto"])
def test_analyze_four_shots(dirs, monkeypatch: pytest.MonkeyPatch, detector: str) -> None:
    storage, _ = dirs
    src = four_shots(storage / "media" / "ref.mp4")
    if detector == "ffmpeg":  # no scenes pack: FFmpeg's scene score
        monkeypatch.setattr(video_mod, "module_present", lambda _m: False)
    out = storage / "renders" / "style" / detector
    seen: list[str] = []
    a = analyze_style(src, out, storage, step=lambda _p, m: seen.append(m), ocr=True)
    if detector == "ffmpeg":
        assert a["scenes_method"] == "ffmpeg"
    starts = [s["start"] for s in a["scenes"]]
    assert len(starts) == 4, a["scenes"]
    for got, want in zip(starts, [0, 2, 4, 6], strict=True):
        assert abs(got - want) <= 0.1
    st = a["shot_stats"]
    assert st["count"] == 4 and abs(st["median_s"] - 2) <= 0.15
    assert st["cuts_per_min"] == pytest.approx(3 / 8 * 60, abs=1.5)
    assert a["canvas"] == {"w": 320, "h": 180, "aspect": "16:9"} and a["duration_s"] == 8.0
    au = a["audio"]
    assert au["has_audio"] and au["loudness_lufs"] == pytest.approx(-21.8, abs=1.5)
    assert au["silence_ratio"] == 0.0 and au["music_detected"] is True  # steady tone
    assert au["speech_ratio"] < 0.2 and au["music_method"] == "spectral-flatness-heuristic"
    # contact sheet 4x6 + 24 thumbnails, paths relative to storage
    sheet = storage / a["contact_sheet_path"]
    assert sheet.is_file() and a["contact_sheet_path"].startswith("renders/style/")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
         str(sheet)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    w, h = (int(x) for x in probe.stdout.strip().split(","))
    assert (w, h) == (4 * 320 + 3 * 4 + 8, 6 * 180 + 5 * 4 + 8)
    assert (w, h) == (a["contact_sheet"]["width"], a["contact_sheet"]["height"])
    assert len(a["thumbnails"]) == 24 and len(a["contact_sheet"]["times"]) == 24
    assert all((storage / t).is_file() for t in a["thumbnails"])
    assert a["contact_sheet"]["times"][0] == pytest.approx(8 / 48, abs=0.05)
    if not a["contact_sheet"]["timestamps"]:
        assert "contact_sheet_without_timestamps" in a["warnings"]
    # OCR requested without the pack: a warning, never a failure
    if not packs.module_present("rapidocr_onnxruntime"):
        assert "ocr_pack_missing" in a["warnings"] and "text_on_screen" not in a
    assert a["motion"]["pan_estimate"]["level"] in ("static", "low", "high")
    saved = json.loads((out / "analysis.json").read_text("utf-8"))
    assert saved["shot_stats"] == st and "analysis_path" not in saved
    assert a["analysis_path"] == f"renders/style/{detector}/analysis.json"
    assert "Armando la hoja de contactos" in seen


@needs_ffmpeg
def test_motion_punch_in_and_static(dirs) -> None:
    storage, _ = dirs
    src = punch_in(storage / "media" / "punch.mp4")
    info = video_mod.probe_media(src)
    scenes, _m = video_mod.detect_cuts(src, info["duration"])
    motion = video_mod.analyze_motion(video_mod.gray_frames(src), scenes)
    punches = [e for e in motion["zoom_events"] if e["kind"] == "punch_in"]
    assert punches and abs(punches[0]["t"] - 3.0) <= 0.4 and punches[0]["scale"] >= 1.2
    assert motion["pan_estimate"]["level"] == "static"


@needs_ffmpeg
def test_analyze_with_transcript_and_ocr_engine(dirs) -> None:
    storage, _ = dirs
    src = four_shots(storage / "media" / "ref.mp4", seconds=1)

    def engine(path: str):
        return [[[[10, 10], [100, 10], [100, 30], [10, 30]], "HOLA", 0.9]], 0.0

    a = analyze_style(
        src,
        storage / "renders" / "style" / "t",
        storage,
        transcript=[{"start": 0, "end": 2, "text": "hola"}, {"start": 1, "end": 3, "text": "che"}],
        ocr_engine=engine,
        max_frames=12,
    )
    assert a["audio"]["speech_method"] == "transcript"
    assert a["audio"]["speech_ratio"] == pytest.approx(3 / 4, abs=0.01)
    assert a["transcript_excerpt"] == "hola che"
    assert a["text_on_screen"][0]["text"] == "HOLA" and len(a["text_on_screen"]) == 1
    assert len(a["thumbnails"]) == 12


@needs_ffmpeg
def test_route_analyze_task(client, dirs) -> None:
    storage, _ = dirs
    four_shots(storage / "media" / "ref.mp4", seconds=1)
    r = client.post(
        "/style/analyze",
        json={"path": "media/ref.mp4", "output_dir": "renders/style/job1", "ocr": False},
    )
    assert r.status_code == 200, r.text
    task = style_router.style_queue().wait(r.json()["task_id"], timeout=120)
    assert task is not None and task.status == "done", task and task.error
    body = client.get(f"/style/tasks/{task.id}").json()
    assert body["status"] == "done"
    assert body["result"]["analysis_path"] == "renders/style/job1/analysis.json"
    assert body["result"]["analysis"]["shot_stats"]["count"] == 4
    assert (
        client.post(
            "/style/analyze", json={"path": "media/nope.mp4", "output_dir": "x"}
        ).status_code
        == 404
    )
    escape = client.post("/style/analyze", json={"path": "media/ref.mp4", "output_dir": "../x"})
    assert escape.status_code == 400
    assert client.get("/style/tasks/nope").status_code == 404


# ------------------------------------------------------------------------------------ infer


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeOllama:
    f = FakeOllama([VISION])
    monkeypatch.setattr(services, "ollama_client", f.client)
    monkeypatch.setattr(packs, "ollama_installed_models", lambda: list(f.models) if f.up else None)
    return f


def _analysis_files(storage: Path) -> tuple[str, str]:
    d = storage / "renders" / "style" / "a1"
    d.mkdir(parents=True)
    analysis = {
        "duration_s": 30,
        "canvas": {"w": 1080, "h": 1920, "aspect": "9:16"},
        "shot_stats": {
            "count": 15,
            "mean_s": 2,
            "median_s": 1.9,
            "cuts_per_min": 28,
            "histogram": [],
        },
        "motion": {"zoom_events": [{"t": 3, "kind": "punch_in", "scale": 1.2}], "pan_estimate": {}},
        "audio": {"loudness_lufs": -14, "speech_ratio": 0.8, "music_detected": True},
        "text_on_screen": [{"t": 0.5, "text": "TÍTULO", "bbox": [0, 0, 1, 0.1]}],
        "contact_sheet": {"times": [0.5, 1.5]},
        "thumbnails": ["x.jpg"],
    }
    (d / "analysis.json").write_text(json.dumps(analysis), "utf-8")
    (d / "contact_sheet.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    return "renders/style/a1/analysis.json", "renders/style/a1/contact_sheet.png"


def test_schema_file_and_validation() -> None:
    schema = load_schema()
    assert schema["title"] == "StylePreset" and "id" not in schema["properties"]
    assert validate_preset(PRESET) == []
    errors = validate_preset({**PRESET, "canvas": "4:3"})
    assert errors and errors[0].startswith("canvas")


def test_compact_analysis_drops_paths() -> None:
    c = compact_analysis(
        {
            "duration_s": 10,
            "thumbnails": ["a"],
            "contact_sheet_path": "p",
            "motion": {"zoom_events": [{"kind": "punch_in"}, {"kind": "punch_in"}]},
            "text_on_screen": [{"t": 1, "text": "x" * 200}],
        }
    )
    assert "thumbnails" not in c and "contact_sheet_path" not in c
    assert c["motion"]["zoom_events"] == {"punch_in": 2}
    assert len(c["text_on_screen"][0]["text"]) == 80


def test_infer_with_mocked_ollama(client, dirs, fake: FakeOllama) -> None:
    storage, _ = dirs
    analysis_path, sheet_path = _analysis_files(storage)
    fake.reply("no es json", {**PRESET, "canvas": "4:3"}, PRESET)
    r = client.post(
        "/style/infer", json={"analysis_path": analysis_path, "contact_sheet_path": sheet_path}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["preset"] == PRESET and body["model"] == VISION and body["attempts"] == 3
    assert "attempt_1_invalid" in body["warnings"] and "attempt_2_invalid" in body["warnings"]
    first = fake.chats[0]
    assert first["model"] == VISION and first["format"]["properties"]["canvas"]
    assert "$id" not in first["format"]
    user = first["messages"][1]
    assert user["images"] and isinstance(user["images"][0], str)
    assert "TÍTULO" in user["content"] and "contact_sheet_path" not in user["content"]
    assert first["options"]["num_ctx"] == 8192
    # the retry feeds the schema errors back
    assert "canvas" in fake.chats[2]["messages"][-1]["content"]


def test_infer_pack_required(client, dirs, fake: FakeOllama) -> None:
    storage, _ = dirs
    analysis_path, sheet_path = _analysis_files(storage)
    req = {"analysis_path": analysis_path, "contact_sheet_path": sheet_path}
    fake.models = ["qwen3:8b"]  # Ollama up, no vision model
    r = client.post("/style/infer", json=req)
    assert r.status_code == 409
    body = r.json()
    assert body["code"] == "PACK_REQUIRED" and body["packId"] == "vision-llm"
    assert (
        "o usá la Consola Claude" in body["detail"] and "ollama pull qwen2.5vl:3b" in body["detail"]
    )
    fake.up = False  # Ollama not running
    r = client.post("/style/infer", json=req)
    assert r.status_code == 409 and "o usá la Consola Claude" in r.json()["detail"]
    assert "no está corriendo" in r.json()["detail"]
    assert fake.chats == []


def test_infer_gives_up_after_three_invalid(client, dirs, fake: FakeOllama) -> None:
    storage, _ = dirs
    analysis_path, sheet_path = _analysis_files(storage)
    fake.reply("x", "y", "z")
    r = client.post(
        "/style/infer", json={"analysis_path": analysis_path, "contact_sheet_path": sheet_path}
    )
    assert r.status_code == 502 and "Consola Claude" in r.json()["detail"]


def test_packs_registered(client, fake: FakeOllama) -> None:
    rows = {p["id"]: p for p in client.get("/packs").json()}
    assert {"ocr", "vision-llm"} <= rows.keys()
    vision = rows["vision-llm"]
    assert vision["installed"] is True and vision["group"] == "agent"
    assert any(f["name"] == f"ollama:{VISION}" for f in vision["files"])
    assert rows["ocr"]["license"].startswith("Apache-2.0")
    assert any(
        f["name"].startswith("pip:rapidocr-onnxruntime==1.4.4") for f in rows["ocr"]["files"]
    )
    assert packs.FEATURE_PACKS["style.infer"] == "vision-llm"
    assert packs.FEATURE_PACKS["style.ocr"] == "ocr"
    fake.models = []
    assert (
        next(p for p in client.get("/packs").json() if p["id"] == "vision-llm")["installed"]
        is False
    )
