"""On-screen text of the reference (pack ``ocr``: RapidOCR 1.4.4 on onnxruntime CPU, Apache-2.0).

Runs on the 640 px thumbnails of the contact sheet (24 frames), so a 1-minute reference costs a
few seconds on CPU. Results: ``[{t, text, bbox: [x, y, w, h] (fractions of the frame), score}]``;
the same text on consecutive thumbnails is reported once (first time it shows).
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..packs import PackRequiredError, module_present

OCR_PACK_ID = "ocr"
MIN_SCORE = 0.6
MAX_ITEMS = 80


def ocr_available() -> bool:
    return module_present("rapidocr_onnxruntime")


@lru_cache(maxsize=1)
def _engine() -> Any:
    from rapidocr_onnxruntime import RapidOCR  # noqa: PLC0415 - optional pack

    return RapidOCR()


def _image_size(path: Path) -> tuple[int, int]:
    from PIL import Image  # noqa: PLC0415 - installed with the ocr pack

    with Image.open(path) as im:
        return im.size


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def read_frames(
    thumbs: list[Path],
    times: list[float],
    *,
    engine: Any = None,
    size_of: Any = None,
) -> list[dict[str, Any]]:
    """OCR each thumbnail; ``engine(path) -> (result, elapse)`` like RapidOCR (tests inject one)."""
    if engine is None:
        if not ocr_available():
            raise PackRequiredError(OCR_PACK_ID)
        engine = _engine()
    size_of = size_of or _image_size
    out: list[dict[str, Any]] = []
    previous: set[str] = set()
    for path, t in zip(thumbs, times, strict=False):
        result, _elapse = engine(str(path))
        w, h = size_of(path)
        seen: set[str] = set()
        for box, text, score in result or []:
            text = str(text).strip()
            if not text or float(score) < MIN_SCORE:
                continue
            key = _norm(text)
            seen.add(key)
            if key in previous:
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x0, y0 = max(0.0, min(xs)), max(0.0, min(ys))
            bbox = [
                round(x0 / w, 4),
                round(y0 / h, 4),
                round((max(xs) - x0) / w, 4),
                round((max(ys) - y0) / h, 4),
            ]
            out.append(
                {"t": round(t, 3), "text": text, "bbox": bbox, "score": round(float(score), 3)}
            )
            if len(out) >= MAX_ITEMS:
                return out
        previous = seen
    return out
