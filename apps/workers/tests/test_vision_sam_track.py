"""SAM 2 sessions (mocked predictor): lifecycle, chunked propagation, masks/track/alpha; model
choice by VRAM; /vision/track (OpenCV on a lavfi moving square, SAM mocked); /vision/reframe."""

import json
from pathlib import Path

import pytest
from conftest import count_frames, decoded_alpha, lavfi_video, needs_ffmpeg
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.gpu import GpuBudget, VramInfo
from studio_workers.vision import frames
from studio_workers.vision.sam import SamManager

np = pytest.importorskip("numpy")


class FakeSam:
    """Disk-shaped object that moves +1 px/frame to the right from where it was prompted."""

    device = "cpu"

    def __init__(self, log: list) -> None:
        self.log = log

    def init_state(self, frames_dir: Path) -> dict:
        jpgs = sorted(frames_dir.glob("*.jpg"))
        info = frames.probe(jpgs[0])
        self.log.append(("init", len(jpgs)))
        return {"n": len(jpgs), "w": info.width, "h": info.height, "objs": {}}

    @staticmethod
    def _disk(st: dict, cx: float, cy: float, r: int = 8):
        yy, xx = np.mgrid[0 : st["h"], 0 : st["w"]]
        return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r

    def add_points(self, st, idx, obj, points, labels):
        pos = [p for p, lab in zip(points, labels, strict=True) if lab == 1] or points
        cx = sum(p[0] for p in pos) / len(pos)
        cy = sum(p[1] for p in pos) / len(pos)
        st["objs"][obj] = (idx, cx, cy)
        self.log.append(("points", idx, obj))
        return self._disk(st, cx, cy)

    def add_box(self, st, idx, obj, box):
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        st["objs"][obj] = (idx, cx, cy)
        self.log.append(("box", idx, obj))
        return self._disk(st, cx, cy)

    def add_mask(self, st, idx, obj, mask):
        x, y, w, h = frames.mask_bbox(mask)
        st["objs"][obj] = (idx, x + w / 2 - 0.5, y + h / 2 - 0.5)
        self.log.append(("mask", idx, obj))

    def propagate(self, st, start, reverse):
        order = range(start, -1, -1) if reverse else range(start, st["n"])
        for k in order:
            yield k, {o: self._disk(st, cx + (k - i), cy) for o, (i, cx, cy) in st["objs"].items()}

    def reset(self, st) -> None:
        self.log.append(("reset",))

    def unload(self) -> None:
        self.log.append(("unload",))


@pytest.fixture
def fake_sam(dirs, monkeypatch: pytest.MonkeyPatch):
    log: list = []
    mgr = SamManager(get_settings(), backend_factory=lambda size, dev: FakeSam(log))
    monkeypatch.setattr("studio_workers.routers.vision.sam_manager", lambda: mgr)
    return mgr, log


def _wait(tid: str):
    task = services.vision_queue().wait(tid, 120)
    assert task is not None and task.status == "done", task and task.error
    return task


def test_sam_requires_pack(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "v.mp4").write_bytes(b"x")
    res = client.post("/vision/sam/session", json={"path": "media/v.mp4"})
    assert res.status_code == 409 and res.json()["packId"] == "sam2"
    res = client.post(
        "/vision/track",
        json={"path": "media/v.mp4", "bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
              "method": "sam2"},
    )  # fmt: skip
    assert res.status_code == 409 and res.json()["packId"] == "sam2"


@needs_ffmpeg
def test_sam_session_lifecycle_chunked(client: TestClient, dirs, fake_sam) -> None:
    storage, _ = dirs
    mgr, log = fake_sam
    lavfi_video(storage / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=2")
    res = client.post("/vision/sam/session", json={"path": "media/v.mp4"})
    assert res.status_code == 200, res.text
    body = res.json()
    sid = body["session_id"]
    assert body["frames"] == 50 and body["fps"] == 25.0 and body["model"] == "sam2.1-tiny"
    assert body["frame_range"] == [0, 49] and (body["width"], body["height"]) == (160, 90)

    # propagate without points -> 400
    assert client.post(f"/vision/sam/session/{sid}/propagate", json={}).status_code == 400

    pts = {"frame": 10, "points": [{"x": 0.25, "y": 0.5, "label": 1}], "obj_id": 1}
    res = client.post(f"/vision/sam/session/{sid}/points", json=pts)
    assert res.status_code == 200, res.text
    p = res.json()
    assert p["mask_png_path"] == f"renders/sam/{sid}/points/1_00010.png"
    assert p["bbox_px"] == {"x": 32, "y": 37, "w": 17, "h": 17}
    assert p["bbox"]["x"] == pytest.approx(32 / 160) and p["device"] == "cpu"
    assert ("init", 1) in log  # interactive: one-frame state
    assert (storage / p["mask_png_path"]).is_file()

    res = client.post(f"/vision/sam/session/{sid}/propagate", json={"chunk_frames": 20})
    assert res.status_code == 200, res.text
    r = _wait(res.json()["task_id"]).result
    # forward 10..29, 29..48, 48..49 then backwards 0..10 (1 frame overlap between chunks)
    assert [e for e in log if e[0] == "init"][1:] == [
        ("init", 20), ("init", 20), ("init", 2), ("init", 11),
    ]  # fmt: skip
    assert log.count(("mask", 0, 1)) == 2  # forward chunks 2 and 3 start from the carried mask
    assert ("mask", 10, 1) not in log and ("points", 10, 1) in log  # reverse: replays the clicks
    masks = storage / r["masks_dir"]
    assert r["masks_dir"] == f"renders/sam/{sid}/masks/1"
    assert len(list(masks.glob("*.png"))) == 50
    trk = r["track"]
    assert trk["version"] == 1 and trk["source"]["method"] == "sam2" and len(trk["frames"]) == 50
    f = trk["frames"]
    centers = [(fr["x"] + fr["w"] / 2) * 160 for fr in f]
    assert centers[10] == pytest.approx(40.5, abs=3) and centers[49] == pytest.approx(79.5, abs=3)
    assert centers[0] == pytest.approx(30.5, abs=3)
    assert all(b >= a - 0.2 for a, b in zip(centers, centers[1:], strict=False))  # moves right
    assert json.loads((storage / r["track_path"]).read_text("utf-8"))["frames"][0]["t"] == 0
    alpha = storage / r["alpha_path"]
    assert frames.webm_has_alpha(alpha) and count_frames(alpha) == 50
    a = decoded_alpha(alpha, 10)
    assert a[45 * 160 + 40] > 200 and a[0] < 30  # opaque on the object, transparent elsewhere
    assert ("unload",) in log  # model released after propagation

    tmp = storage / "tmp" / "sam" / sid
    assert tmp.is_dir()
    assert client.delete(f"/vision/sam/session/{sid}").json() == {
        "deleted": True, "session_id": sid,
    }  # fmt: skip
    assert not tmp.exists() and masks.is_dir()  # results stay (they are assets now)
    assert client.delete(f"/vision/sam/session/{sid}").status_code == 404
    assert client.post(f"/vision/sam/session/{sid}/points", json=pts).status_code == 404


@needs_ffmpeg
def test_sam_session_frame_range_and_bad_frame(client: TestClient, dirs, fake_sam) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=2")
    body = client.post(
        "/vision/sam/session", json={"path": "media/v.mp4", "frame_range": [20, 29]}
    ).json()
    assert body["frames"] == 10 and body["frame_range"] == [20, 29]
    sid = body["session_id"]
    bad = {"frame": 10, "points": [{"x": 50, "y": 40, "label": 1}]}
    assert client.post(f"/vision/sam/session/{sid}/points", json=bad).status_code == 400
    ok = client.post(f"/vision/sam/session/{sid}/points", json={**bad, "frame": 0}).json()
    assert ok["bbox_px"]["x"] == 42  # pixel coordinates (values > 1)
    r = _wait(
        client.post(f"/vision/sam/session/{sid}/propagate", json={"alpha": False}).json()["task_id"]
    ).result
    assert r["frame_range"] == [20, 29] and "alpha_path" not in r
    assert r["track"]["frames"][0]["t"] == pytest.approx(0.8)  # times of the source


def test_sam_model_choice_by_vram(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USE_CUDA", "true")
    services.reset()
    free = {"mb": 4000}
    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 6144, free["mb"], "t"))
    mgr = SamManager(get_settings(), budget=budget, backend_factory=lambda s, d: FakeSam([]))
    assert mgr.choose_size() == "small"
    free["mb"] = 2500
    assert mgr.choose_size() == "tiny"
    free["mb"] = 4000
    budget.acquire("whisper:large-v3-turbo", 1800, lambda: None)
    assert budget.resident == "whisper:large-v3-turbo"
    free["mb"] = 1500  # whisper resident: its 1800 MB will be freed before SAM loads
    assert mgr.choose_size() == "small"
    free["mb"] = 3500  # the fake probe does not see whisper's memory coming back
    backend, device, _w = mgr._get_backend("small")
    assert budget.resident == "sam2-small" and device == "cuda"
    mgr.release_model()
    assert budget.resident is None


# ------------------------------------------------------------------------------- tracking


def _moving_square(dst: Path) -> Path:
    # textured 40x40 square moving right 60 px/s (and down 15 px/s) over a gray background
    graph = (
        "color=c=gray:s=320x240:r=25:d=2[bg];testsrc2=s=40x40:r=25:d=2[sq];"
        "[bg][sq]overlay=x='20+60*t':y='60+15*t'"
    )
    return lavfi_video(dst, graph)


@needs_ffmpeg
def test_track_opencv_real_on_moving_square(client: TestClient, dirs) -> None:
    pytest.importorskip("cv2")
    storage, _ = dirs
    _moving_square(storage / "media" / "sq.mp4")
    res = client.post(
        "/vision/track",
        json={"path": "media/sq.mp4", "bbox": {"x": 20, "y": 60, "w": 40, "h": 40},
              "method": "csrt", "asset_id": "asset-1"},
    )  # fmt: skip
    assert res.status_code == 200, res.text
    r = _wait(res.json()["task_id"]).result
    assert r["smoothed"] is True and r["frames"] == 50
    assert r["method"] in ("csrt", "template")
    assert r["track_path"].startswith("renders/vision/track-") and r["track_path"].endswith(
        ".track.json"
    )
    saved = json.loads((storage / r["track_path"]).read_text("utf-8"))
    assert saved["source"] == {"assetId": "asset-1", "method": r["method"]}
    last = saved["frames"][-1]
    t = last["t"]
    assert t == pytest.approx(49 / 25, abs=1e-3)
    exp_cx, exp_cy = (20 + 60 * t + 20) / 320, (60 + 15 * t + 20) / 240
    assert abs(last["x"] + last["w"] / 2 - exp_cx) < 0.05
    assert abs(last["y"] + last["h"] / 2 - exp_cy) < 0.05


@needs_ffmpeg
def test_track_sam2_mocked_with_mask_png(client: TestClient, dirs, fake_sam) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=1")
    mask = np.zeros((90, 160), dtype=np.uint8)
    mask[40:60, 20:40] = 255
    frames.write_png(storage / "media" / "mask.png", mask)
    res = client.post(
        "/vision/track",
        json={"path": "media/v.mp4", "mask_png": "media/mask.png", "method": "sam2",
              "output_base": "renders/obj"},
    )  # fmt: skip
    assert res.status_code == 200, res.text
    r = _wait(res.json()["task_id"]).result
    assert r["track_path"] == "renders/obj.track.json" and r["method"] == "sam2"
    assert len(r["track"]["frames"]) == 25
    _mgr, log = fake_sam
    assert ("mask", 0, 1) in log
    assert not list((storage / "tmp" / "sam").iterdir())  # temporary session removed


def test_track_validation(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "v.mp4").write_bytes(b"x")
    res = client.post("/vision/track", json={"path": "media/v.mp4", "method": "csrt"})
    assert res.status_code == 400


# ------------------------------------------------------------------------------- reframe


def test_reframe_face_requires_pack(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "v.mp4").write_bytes(b"x")
    res = client.post("/vision/reframe", json={"path": "media/v.mp4", "target": "9:16"})
    assert res.status_code == 409 and res.json()["packId"] == "reframe"


@needs_ffmpeg
def test_reframe_from_track_file(client: TestClient, dirs) -> None:
    storage, _ = dirs
    lavfi_video(storage / "media" / "w.mp4", "testsrc2=s=320x180:r=25:d=2")
    track = {
        "version": 1, "fps": 25, "smoothed": True, "source": {"assetId": "", "method": "csrt"},
        "frames": [
            {"t": i / 25, "x": 0.1 + 0.3 * i / 50, "y": 0.4, "w": 0.1, "h": 0.2, "conf": 1}
            for i in range(50)
        ],
    }  # fmt: skip
    (storage / "media" / "t.track.json").write_text(json.dumps(track), "utf-8")
    res = client.post(
        "/vision/reframe",
        json={"path": "media/w.mp4", "target": "9:16", "subject": "track",
              "track_path": "media/t.track.json", "scenes": [{"start": 0, "end": 2}]},
    )  # fmt: skip
    assert res.status_code == 200, res.text
    r = _wait(res.json()["task_id"]).result
    assert r["target"] == "9:16" and r["source"]["width"] == 320
    kfs = r["keyframes"]
    assert kfs[0]["t"] == 0 and kfs[-1]["ease"] == "hold"
    assert all(set(k) == {"t", "v", "ease"} and set(k["v"]) == {"x", "y", "w", "h"} for k in kfs)
    assert kfs[-1]["v"]["x"] > kfs[0]["v"]["x"]  # follows the subject to the right
    assert r["per_scene"][0]["subject"] == "track"
    missing = client.post("/vision/reframe", json={"path": "media/w.mp4", "subject": "track"})
    assert missing.status_code == 400


@needs_ffmpeg
def test_sam_points_accumulate_replace_and_busy(client: TestClient, dirs, fake_sam) -> None:
    import threading

    storage, _ = dirs
    mgr, _log = fake_sam
    lavfi_video(storage / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=1")
    sid = client.post("/vision/sam/session", json={"path": "media/v.mp4"}).json()["session_id"]
    url = f"/vision/sam/session/{sid}/points"
    client.post(url, json={"frame": 0, "points": [{"x": 0.25, "y": 0.5, "label": 1}]})
    two = client.post(url, json={"frame": 0, "points": [{"x": 0.75, "y": 0.5, "label": 1}]})
    assert two.json()["bbox_px"]["x"] == 72  # mean of both clicks: x = 80
    s = mgr.get(sid)
    assert len(s.prompts) == 1 and len(s.prompts[0].points) == 2
    rep = client.post(
        url, json={"frame": 0, "points": [{"x": 0.75, "y": 0.5, "label": 1}], "replace": True}
    )
    assert rep.json()["bbox_px"]["x"] == 112 and len(s.prompts[0].points) == 1
    held = threading.Event()
    done = threading.Event()

    def hold() -> None:
        with s.lock:
            held.set()
            done.wait(5)

    threading.Thread(target=hold, daemon=True).start()
    held.wait(5)
    busy = client.post(url, json={"frame": 0, "points": [{"x": 0.5, "y": 0.5, "label": 1}]})
    done.set()
    assert busy.status_code == 409 and busy.json()["code"] == "SESSION_BUSY"
