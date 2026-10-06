"""Fake FaceFusion 3.9.1 ``facefusion.py`` for the e2e mocks and the workers tests (no models).

    FACEFUSION_PYTHON=<python>  FACEFUSION_APP_DIR=scripts/e2e/fake_facefusion

``headless-run``: copies the target to the output with a filled box where a face would be
(ffmpeg drawbox; image or video, same extension), printing tqdm-like percentages. A source photo
whose file name contains "nsfw" (or that ends with the bytes NSFW-TEST) makes it print the
content analyser's rejection and exit 1 (as the real one, which only says "failed").
FAKE_FACEFUSION_FAIL=1 -> a CUDA error and exit 1; FAKE_FACEFUSION_SLEEP=<s> -> waits (cancel
tests); FAKE_FACEFUSION_ARGV=<file> -> writes {argv, cwd, hf_token} there. Never used by
setup/start.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def arg_values(argv: list[str], name: str) -> list[str]:
    if name not in argv:
        return []
    out: list[str] = []
    for value in argv[argv.index(name) + 1 :]:
        if value.startswith("--"):
            break
        out.append(value)
    return out


def _nsfw_marked(path: Path) -> bool:
    """«nsfw» in the file name, or the bytes NSFW-TEST in the file (Studio renames the photos of
    a Person, so the e2e appends the marker after the PNG's IEND chunk)."""
    if "nsfw" in path.name.lower():
        return True
    try:
        return b"NSFW-TEST" in path.read_bytes()[-4096:]
    except OSError:
        return False


def main(argv: list[str]) -> int:
    if not argv or argv[0] != "headless-run":
        print("usage: facefusion.py headless-run ...", file=sys.stderr)
        return 2
    record = os.environ.get("FAKE_FACEFUSION_ARGV")
    if record:
        Path(record).write_text(
            json.dumps(
                {
                    "argv": [sys.argv[0], *argv],
                    "cwd": os.getcwd(),
                    "hf_token": "HF_TOKEN" in os.environ,
                }
            ),
            "utf-8",
        )
    sources = arg_values(argv, "--source-paths")
    target = Path(arg_values(argv, "--target-path")[0])
    output = Path(arg_values(argv, "--output-path")[0])
    print("[FACEFUSION.CORE] fake FaceFusion 3.9.1 (Studio e2e)", flush=True)
    if any(_nsfw_marked(Path(s)) for s in sources):
        print("[FACEFUSION.CONTENT_ANALYSER] Explicit content detected (nsfw)", flush=True)
        print("[FACEFUSION.CORE] Processing to video failed", flush=True)
        return 1
    if os.environ.get("FAKE_FACEFUSION_FAIL") == "1":
        print("[FACEFUSION.CORE] error: CUDAExecutionProvider is not available", flush=True)
        return 1
    delay = float(os.environ.get("FAKE_FACEFUSION_SLEEP") or 0)
    for pct in (0, 25, 50, 75):
        sys.stdout.write(f"\rProcessing: {pct}%|{'#' * (pct // 10)}| frame")
        sys.stdout.flush()
        time.sleep(delay / 4 if delay else 0.02)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("error: ffmpeg not found", flush=True)
        return 1
    box = "drawbox=x=iw*0.35:y=ih*0.2:w=iw*0.3:h=ih*0.45:color=red@0.6:t=fill"
    image = target.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
    cmd = [ffmpeg, "-y", "-v", "error", "-i", str(target), "-vf", box]
    if image:
        cmd += ["-frames:v", "1", "-update", "1"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p"]
        cmd += ["-c:a", "copy"]
    done = subprocess.run([*cmd, str(output)], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        print(f"error: ffmpeg failed: {done.stderr.strip()[-300:]}", flush=True)
        return 1
    sys.stdout.write("\rProcessing: 100%|##########| frame\n")
    print("[FACEFUSION.CORE] Processing to video succeed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
