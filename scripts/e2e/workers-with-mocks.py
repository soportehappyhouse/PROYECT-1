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

- Sprint 4 M1 face swap (STUDIO_MOCK_FACE=0 turns it off): packs faceswap / faceswap-extra
  reported installed, FaceFusion = scripts/e2e/fake_facefusion/facefusion.py (box on the face).

- Sprint 3b stems (STUDIO_MOCK_STEMS=0 turns it off): pack stems is reported as installed and the
  htdemucs model is a fixed linear split (vocals 0.6, drums 0.2, bass 0.1, other 0.1 of the mix),
  so /audio/stems runs the real decode, chunking, overlap-add and WAV writing.

- Sprint 4 M2 Chatterbox (STUDIO_MOCK_CHATTERBOX=0 turns it off): pack tts-chatterbox installed,
  CHATTERBOX_PYTHON = this interpreter and the real bridge with --mock (sine WAV, no torch).

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


VISION_PACKS = {"matting", "matting-hq", "matting-image", "sam2"}  # matting-hq: sprint 3b


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


# ------------------------------------------------------------- BEGIN sprint 3b stems mock
MOCK_STEMS = os.environ.get("STUDIO_MOCK_STEMS", "1") != "0"
if MOCK_STEMS:
    from studio_workers.audio.stems import HTDEMUCS_SOURCES, Separator

    STEM_GAINS = {"drums": 0.2, "bass": 0.1, "other": 0.1, "vocals": 0.6}

    def fake_htdemucs(_device: str) -> Separator:
        import numpy as np

        return Separator(
            HTDEMUCS_SOURCES,
            lambda chunk, _seg: np.stack([STEM_GAINS[s] * chunk for s in HTDEMUCS_SOURCES]),
        )

    services.stems_engine()._loader = fake_htdemucs
    _status_before_stems = packs.pack_status

    def pack_status_stems(pack, root, catalog=None, **kw):  # type: ignore[no-untyped-def]
        row = _status_before_stems(pack, root, catalog, **kw)
        if pack.id == "stems":
            row.update(installed=True, partial=False)
        return row

    packs.pack_status = pack_status_stems
# --------------------------------------------------------------- END sprint 3b stems mock

# ------------------------------------------------------------- BEGIN sprint4:M2 chatterbox mock
# STUDIO_MOCK_CHATTERBOX=0 turns it off. Pack tts-chatterbox reported as installed, the tool venv
# = this interpreter (CHATTERBOX_PYTHON, through tools/launch.py) and the real bridge
# tools/chatterbox/studio_tts_server.py with --mock: a generated sine WAV (220 Hz, 330 Hz with a
# reference sample) of 0.06 s per character, 24 kHz mono, same JSON-lines protocol and chunking.
MOCK_CHATTERBOX = os.environ.get("STUDIO_MOCK_CHATTERBOX", "1") != "0"
if MOCK_CHATTERBOX:
    os.environ.setdefault("CHATTERBOX_PYTHON", sys.executable)
    _status_before_chatterbox = packs.pack_status

    def pack_status_chatterbox(pack, root, catalog=None, **kw):  # type: ignore[no-untyped-def]
        row = _status_before_chatterbox(pack, root, catalog, **kw)
        if pack.id == "tts-chatterbox":
            row.update(installed=True, partial=False)
        return row

    packs.pack_status = pack_status_chatterbox
    services.chatterbox_client().extra_args = ["--mock"]
# --------------------------------------------------------------- END sprint4:M2 chatterbox mock

# ------------------------------------------------------------- BEGIN sprint4:M1 face swap mock
# STUDIO_MOCK_FACE=0 turns it off. Packs faceswap / faceswap-extra reported installed (no models
# on disk: the CRC32/model check is skipped), FaceFusion = scripts/e2e/fake_facefusion/facefusion.py
# on this interpreter through FACEFUSION_PYTHON / FACEFUSION_APP_DIR (copies the target with a box
# on the face, prints %, a source photo named "*nsfw*" -> content analyser rejection, exit 1).
# Without the YuNet model (reframe/faceswap pack) the detector returns one centered face.
MOCK_FACE = os.environ.get("STUDIO_MOCK_FACE", "1") != "0"
if MOCK_FACE:
    os.environ.setdefault("FACEFUSION_PYTHON", sys.executable)
    os.environ.setdefault(
        "FACEFUSION_APP_DIR", str(Path(__file__).resolve().parent / "fake_facefusion")
    )
    from studio_workers.vision.reframe import yunet_path

    _face = services.face_engine()
    _face.require_models = lambda _model, _enhancer: None
    if not yunet_path(get_settings().models_root).is_file():

        def _center_face(_root):  # type: ignore[no-untyped-def]
            def detect(img):  # type: ignore[no-untyped-def]
                h, w = img.shape[:2]
                return [(w * 0.35, h * 0.2, w * 0.3, h * 0.45, 0.99)]

            return detect

        _face.detector_factory = _center_face
    _status_before_face = packs.pack_status

    def pack_status_face(pack, root, catalog=None, **kw):  # type: ignore[no-untyped-def]
        row = _status_before_face(pack, root, catalog, **kw)
        if pack.id in ("faceswap", "faceswap-extra"):
            row.update(installed=True, partial=False)
        return row

    packs.pack_status = pack_status_face
# --------------------------------------------------------------- END sprint4:M1 face swap mock


# ------------------------------------------------------------- BEGIN sprint4:M3 tools mock
# STUDIO_MOCK_TOOLS=0 turns it off. Isolated tool venvs: with the M1/M2 mocks FACEFUSION_PYTHON /
# CHATTERBOX_PYTHON point to this interpreter, so toolvenv.status() reports them "ready"
# (override). Licence-gated pack downloads (faceswap*) never touch the network: the workers route
# still checks the licence mirror (403 LICENCE_REQUIRED) and then a fake install returns at once.
# The perf test talks to the Chatterbox bridge with --mock. STUDIO_MOCK_RVC=0 keeps the real RVC:
# by default a fake voice model "e2e-voz" (no torch / infer-rvc-python) converts with ffmpeg, so
# /rvc/convert runs the real device selection (USE_CUDA, GPU budget) and reports `device`.
MOCK_TOOLS = os.environ.get("STUDIO_MOCK_TOOLS", "1") != "0"
if MOCK_TOOLS:
    from studio_workers import perf as _m3_perf
    from studio_workers import toolvenv as _m3_tv
    from studio_workers.routers import packs as _m3_packs_router

    if os.environ.get("STUDIO_MOCK_CHATTERBOX", "1") != "0":
        _m3_perf.CHATTERBOX_EXTRA_ARGS = ["--mock"]
    _m3_install = _m3_packs_router.install_pack

    def _m3_fake_install(pack_id, root, **kw):  # type: ignore[no-untyped-def]
        if packs.PACKS[pack_id].licence_gate:
            line = kw.get("on_line") or (lambda _l: None)
            line(f"e2e mock: {pack_id} (licencia aceptada) sin descargar nada")
            return packs.InstallReport(pack_id, skipped=["e2e-mock"])
        return _m3_install(pack_id, root, **kw)

    _m3_packs_router.install_pack = _m3_fake_install
    for _m3_tool in _m3_tv.TOOL_IDS:
        print(f"[mocks] tool venv {_m3_tool}: {_m3_tv.status_summary(_m3_tool)['state']}")

MOCK_RVC = os.environ.get("STUDIO_MOCK_RVC", "1") != "0"
if MOCK_RVC:
    from studio_workers.routers import rvc as _m3_rvc_router
    from studio_workers.schemas import RvcModel as _M3RvcModel

    _m3_fake_model = _M3RvcModel(id="e2e-voz", name="e2e voz", model_path="rvc/e2e-voz/e2e-voz.pth")
    _m3_real_discover = _m3_rvc_router.discover_models
    _m3_rvc_router.discover_models = lambda root: [*_m3_real_discover(root), _m3_fake_model]
    _m3_rvc_router.base_ready = lambda root, f0="rmvpe": True
    _m3_rvc_router.require_module = lambda *_a, **_k: None
    _m3_engine = services.rvc_engine()
    _m3_real_convert = _m3_engine.convert

    def _m3_convert(model, input_audio, output, params, device, on_progress=None):  # type: ignore[no-untyped-def]
        if model.id != "e2e-voz":
            return _m3_real_convert(model, input_audio, output, params, device, on_progress)
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(input_audio), "-af",
             f"asetrate=44100*{2 ** (params.pitch_shift / 12):.4f},aresample=40000", "-ac", "1",
             str(output)],
            check=True,
        )  # fmt: skip
        if device == "cuda":
            _m3_engine.idle.touch()
        return output, 40000, 1.0

    _m3_engine.convert = _m3_convert  # type: ignore[method-assign]
    _m3_status_before_rvc = packs.pack_status

    def _m3_pack_status_rvc(pack, root, catalog=None, **kw):  # type: ignore[no-untyped-def]
        row = _m3_status_before_rvc(pack, root, catalog, **kw)
        if pack.id == "rvc-base":  # the api checks the pack before queueing voice.rvc
            row.update(installed=True, partial=False)
        return row

    packs.pack_status = _m3_pack_status_rvc
# --------------------------------------------------------------- END sprint4:M3 tools mock

settings = get_settings()
uvicorn.run(
    with_agent_mock(app) if MOCK_AGENT else app,
    host=settings.workers_host,
    port=settings.workers_port,
    log_level=uvicorn_level("info"),
)
