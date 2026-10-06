"""Start the workers with test doubles for what cannot run in CI / a GPU-less sandbox.

    apps/workers/.venv/bin/python scripts/e2e/workers-with-mocks.py

- DeepFilterNet (pack voz-limpia): the backend is replaced by FFmpeg `afftdn` and the pack is
  reported as installed, so audio.denoise runs end to end (real api + real workers routes).
  STUDIO_MOCK_DENOISE=0 keeps the real (missing) pack, e.g. for the UI smoke 409 step.
- STUDIO_MOCK_GPU_FALLBACK=1: denoise answers `warnings: ["gpu_fallback_cpu"]` (what the GPU
  manager returns when there is no free VRAM), to check the api/web propagation.
- Sprint 2 vision (STUDIO_MOCK_VISION=0 turns it off): packs matting / matting-image / sam2 are
  reported as installed; RVM runs the real GPL subprocess protocol with `--mock-model` (constant
  alpha 200, foreground = source) on this interpreter; BiRefNet = constant alpha 200; the SAM 2
  predictor returns a CONSTANT mask (a box of 30 % x 40 % of the frame centered on the mean of the
  positive clicks, the same on every frame), so propagate -> masks + track + alpha WebM are real.

- Sprint 3 agent (STUDIO_MOCK_AGENT=0 turns it off): POST /agent/plan with a command starting with
  "e2e:" answers a FIXED EditPlan (split + add_text + set_canvas) without Ollama, so run-e2e checks
  plan -> resolve -> apply on any machine. Other commands reach the real /agent/plan (if present).

Everything else (scenes, silences, packs, gpu, perf, vision.track with OpenCV, vision.reframe with
a track) is the real code. Never used by setup/start.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "workers"))
MOCK_VISION = os.environ.get("STUDIO_MOCK_VISION", "1") != "0"
MOCK_DENOISE = os.environ.get("STUDIO_MOCK_DENOISE", "1") != "0"
MOCK_AGENT = os.environ.get("STUDIO_MOCK_AGENT", "1") != "0"
if MOCK_VISION:
    # RVM subprocess (vision_gpl.rvm --mock-model) on this interpreter: no .venv-gpl / torch.
    os.environ.setdefault("GPL_PYTHON", sys.executable)

import uvicorn
from studio_workers import packs, services
from studio_workers.__main__ import uvicorn_level
from studio_workers.config import get_settings
from studio_workers.gpu import GPU_FALLBACK_CPU
from studio_workers.main import app


def afftdn(src: Path, dst: Path, _device: str) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-af",
            "afftdn=nf=-25",
            str(dst),
        ],
        check=True,
    )


_status = packs.pack_status


def pack_status(pack, root, catalog=None, **kw):  # type: ignore[no-untyped-def]
    row = _status(pack, root, catalog, **kw)
    if (MOCK_DENOISE and pack.id == "voz-limpia") or (MOCK_VISION and pack.id in VISION_PACKS):
        row.update(installed=True, partial=False)
    return row


VISION_PACKS = {"matting", "matting-image", "sam2"}


class ConstMaskSam:
    """SAM 2 double: constant box mask (30 % x 40 % of the frame) at the positive clicks."""

    device = "cpu"

    def init_state(self, frames_dir: Path) -> dict:
        from studio_workers.vision import frames  # noqa: PLC0415

        jpgs = sorted(frames_dir.glob("*.jpg"))
        info = frames.probe(jpgs[0])
        return {"n": len(jpgs), "w": info.width, "h": info.height, "objs": {}}

    @staticmethod
    def _box(st: dict, cx: float, cy: float):
        import numpy as np  # noqa: PLC0415

        w, h = st["w"], st["h"]
        bw, bh = int(w * 0.3), int(h * 0.4)
        x0 = int(min(max(0, cx - bw / 2), w - bw))
        y0 = int(min(max(0, cy - bh / 2), h - bh))
        m = np.zeros((h, w), dtype=bool)
        m[y0 : y0 + bh, x0 : x0 + bw] = True
        return m

    def add_points(self, st, idx, obj, points, labels):  # type: ignore[no-untyped-def]
        pos = [p for p, lab in zip(points, labels, strict=True) if lab == 1] or points
        cx = sum(p[0] for p in pos) / len(pos)
        cy = sum(p[1] for p in pos) / len(pos)
        st["objs"][obj] = self._box(st, cx, cy)
        return st["objs"][obj]

    def add_box(self, st, idx, obj, box):  # type: ignore[no-untyped-def]
        st["objs"][obj] = self._box(st, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        return st["objs"][obj]

    def add_mask(self, st, idx, obj, mask):  # type: ignore[no-untyped-def]
        st["objs"][obj] = mask

    def propagate(self, st, start, reverse):  # type: ignore[no-untyped-def]
        order = range(start, -1, -1) if reverse else range(start, st["n"])
        for k in order:
            yield k, dict(st["objs"])

    def reset(self, st) -> None:  # type: ignore[no-untyped-def]
        return None

    def unload(self) -> None:
        return None


packs.pack_status = pack_status
engine = services.denoise_engine()
if MOCK_DENOISE:
    engine._backend = afftdn
if MOCK_DENOISE and os.environ.get("STUDIO_MOCK_GPU_FALLBACK") == "1":
    _denoise = engine.denoise

    def denoise(src: Path, out: Path):  # type: ignore[no-untyped-def]
        path, device, warnings = _denoise(src, out)
        return path, device, [*warnings, GPU_FALLBACK_CPU]

    engine.denoise = denoise  # type: ignore[method-assign]

if MOCK_VISION:
    import numpy as np

    matte = services.matte_engine()
    matte.rvm_extra_args = ["--mock-model"]
    matte.alpha_factory = lambda _device: lambda rgb: np.full(rgb.shape[:2], 200, dtype=np.uint8)
    services.sam_manager().backend_factory = lambda _size, _device: ConstMaskSam()

E2E_PLAN = {
    "version": 1,
    "summary_es": "Divido el primer clip, agrego un título y paso el lienzo a vertical.",
    "ops": [
        {"op": "split", "clip": {"index": 1, "track": "video"}, "t": 1},
        {"op": "add_text", "text": "Hola agente", "t": 0.5, "duration_s": 1.5, "position": "top"},
        {"op": "set_canvas", "preset": "9:16"},
    ],
}


def with_agent_mock(asgi):  # type: ignore[no-untyped-def]
    """ASGI wrapper: POST /agent/plan {command: "e2e:..."} -> E2E_PLAN; anything else passes."""

    async def wrapped(scope, receive, send):  # type: ignore[no-untyped-def]
        if not (
            scope["type"] == "http"
            and scope["path"] == "/agent/plan"
            and scope["method"] == "POST"
        ):
            return await asgi(scope, receive, send)
        chunks: list[bytes] = []
        more = True
        while more:
            msg = await receive()
            chunks.append(msg.get("body", b""))
            more = msg.get("more_body", False)
        body = b"".join(chunks)
        try:
            command = str(json.loads(body or b"{}").get("command", ""))
        except ValueError:
            command = ""
        if command.startswith("e2e:"):
            payload = json.dumps(
                {
                    "plan": E2E_PLAN,
                    "model": None,
                    "latency_ms": 1,
                    "attempts": 1,
                    "warnings": [],
                    "route": "deterministic",
                }
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": payload})
            return None
        replayed = False

        async def replay():  # type: ignore[no-untyped-def]
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return await asgi(scope, replay, send)

    return wrapped


settings = get_settings()
uvicorn.run(
    with_agent_mock(app) if MOCK_AGENT else app,
    host=settings.workers_host,
    port=settings.workers_port,
    log_level=uvicorn_level("info"),
)
