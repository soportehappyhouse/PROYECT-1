"""Faces in one frame (YuNet, ``cv2.FaceDetectorYN``, CPU, < 1 s): the «Cambiar cara» wizard step
2 and the face count of a Person's photo. Same detector and model file as the reframe pack
(models/yunet/face_detection_yunet_2023mar.onnx); the faceswap pack also lists it."""

from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
DETECT_MAX_SIDE = 1280
DETECT_DIR = "renders/face/detect"

RawFace = tuple[float, float, float, float, float]  # x, y, w, h (px), score
Detector = Callable[[Any], list[RawFace]]
DetectorFactory = Callable[[Path], Detector]


def default_detector_factory(models_root: Path) -> Detector:
    """YuNet from the vision module; 409 PACK_REQUIRED faceswap when cv2/numpy/YuNet are missing."""
    from ..packs import PackRequiredError, module_present  # noqa: PLC0415
    from ..vision.reframe import YuNetDetector, yunet_path  # noqa: PLC0415

    model = yunet_path(models_root)
    if not (module_present("cv2") and module_present("numpy") and model.is_file()):
        raise PackRequiredError("faceswap")
    return YuNetDetector(model, score=0.6)


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXT


def extract_frame(src: Path, t: float, out: Path) -> Path:
    """One PNG frame at `t` (fast seek; past the end -> the last frame)."""
    from ..vision.frames import ffmpeg_exe  # noqa: PLC0415

    out.parent.mkdir(parents=True, exist_ok=True)
    base = [ffmpeg_exe(), "-y", "-v", "error"]
    for seek in (["-ss", f"{max(0.0, t):.3f}"], ["-sseof", "-0.25"]):
        out.unlink(missing_ok=True)
        subprocess.run(  # noqa: S603 - fixed argv
            [*base, *seek, "-i", str(src), "-frames:v", "1", "-update", "1", str(out)],
            capture_output=True, timeout=60, check=False,
        )  # fmt: skip
        if out.is_file() and out.stat().st_size > 0:
            return out
    raise ValueError(f"No se pudo extraer el fotograma {t:.2f} s de {src.name}")


def read_image(path: Path) -> Any:
    """BGR image (np.fromfile + imdecode: paths with accents work on Windows)."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"No se pudo leer la imagen {path.name}")
    return img


def find_faces(img: Any, detector: Detector) -> tuple[int, int, list[dict[str, Any]]]:
    """(width, height, faces sorted left to right with boxes in fractions 0..1)."""
    h, w = img.shape[:2]
    scale = min(1.0, DETECT_MAX_SIDE / max(w, h))
    small = img
    if scale < 1.0:
        import cv2  # noqa: PLC0415

        small = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))))
    raw = sorted(detector(small), key=lambda f: f[0])
    faces = []
    for i, (x, y, fw, fh, score) in enumerate(raw):
        x0, y0 = max(0.0, x / scale), max(0.0, y / scale)
        x1, y1 = min(float(w), (x + fw) / scale), min(float(h), (y + fh) / scale)
        box = {
            "x": round(x0 / w, 5),
            "y": round(y0 / h, 5),
            "w": round(max(0.0, x1 - x0) / w, 5),
            "h": round(max(0.0, y1 - y0) / h, 5),
        }
        faces.append({"index": i, "box": box, "score": round(float(score), 4)})
    return w, h, faces


def detect(settings: Settings, src: Path, t: float, detector: Detector) -> dict[str, Any]:
    """Faces of an image, or of the frame `t` (s) of a video (PNG under renders/face/detect/)."""
    if is_image(src):
        frame, rel, t = src, settings.storage_relative(src), 0.0
    else:
        key = hashlib.sha1(f"{src}:{src.stat().st_mtime_ns}:{t:.3f}".encode()).hexdigest()[:16]
        frame = settings.storage_path(f"{DETECT_DIR}/{key}.png")
        if not frame.is_file():
            extract_frame(src, t, frame)
        rel = settings.storage_relative(frame)
    w, h, faces = find_faces(read_image(frame), detector)
    return {"t": round(t, 3), "width": w, "height": h, "frame_path": rel, "faces": faces}
