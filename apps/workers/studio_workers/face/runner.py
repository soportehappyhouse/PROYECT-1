"""FaceFusion 3.9.1 ``headless-run`` as a subprocess (argv list, no shell, fixed cwd).

``headless-run`` exits 0 (ok) or 1 (failed) whatever the reason (FaceFusion's internal codes 2 =
args, 3 = NSFW, 4 = stopped are not exposed), so the runner captures stdout+stderr (the last 40
lines go to ``log_tail``) and classifies the failure:

- a line of the content analyser (NSFW_RE), or exit != 0 with no output and no error/model/download
  line (heuristic of docs/trabajo/fuentes-sprint4.md §1.4) -> 422 CONTENT_BLOCKED;
- anything else -> 502 TOOL_FAILED with the last useful line (``details.logTail``).

The content analyser is never touched: FaceFusion validates its source by CRC32 and there is no
flag to turn it off. Progress: the percentage FaceFusion prints (tqdm bars, "45%|").
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

TAIL_LINES = 40
# [U] exact wording of FaceFusion 3.9.1 when the analyser rejects a target (to pin with a real run):
NSFW_RE = re.compile(
    r"nsfw|explicit content|inappropriate content|content[ _-]?analy[sz]er|"
    r"contenido (expl[ií]cito|inapropiado)",
    re.IGNORECASE,
)
# Lines that make a silent exit 1 a real tool failure (models, downloads, CUDA, crashes).
ERROR_RE = re.compile(
    r"error|exception|traceback|failed|fatal|not found|no such file|cannot|could not|unable|"
    r"not available|unavailable|invalid|denied|out of memory|download",
    re.IGNORECASE,
)
PROGRESS_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s?%(?:\||\s|$)")


@dataclass(frozen=True)
class HeadlessArgs:
    sources: list[Path]
    target: Path
    output: Path
    model: str
    enhancer: bool
    enhancer_blend: int
    selector_mode: str  # reference | one
    reference_frame: int
    reference_index: int
    reference_distance: float
    device: str  # cuda | cpu
    temp_dir: Path
    jobs_dir: Path
    threads: int = 4


def headless_args(a: HeadlessArgs) -> list[str]:
    """Arguments after the script, verified against facefusion/program.py of 3.9.1."""
    args = ["headless-run", "--source-paths", *[str(s) for s in a.sources]]
    args += ["--target-path", str(a.target), "--output-path", str(a.output)]
    args += ["--processors", "face_swapper", *(["face_enhancer"] if a.enhancer else [])]
    args += ["--face-swapper-model", a.model]
    if a.enhancer:
        args += ["--face-enhancer-model", "gfpgan_1.4"]
        args += ["--face-enhancer-blend", str(a.enhancer_blend)]
    args += ["--face-selector-mode", a.selector_mode]
    if a.selector_mode == "reference":
        args += [
            "--reference-frame-number", str(max(0, a.reference_frame)),
            "--reference-face-position", str(max(0, a.reference_index)),
            "--reference-face-distance", f"{a.reference_distance:g}",
        ]  # fmt: skip
    args += [
        "--face-selector-order", "left-right",
        "--face-detector-model", "yolo_face",
        "--face-mask-types", "box", "occlusion",
        "--execution-providers", a.device,
        "--execution-device-ids", "0",
        "--execution-thread-count", str(a.threads),
        "--video-memory-strategy", "moderate",
        "--output-video-encoder", "libx264",
        "--output-video-quality", "80",
        "--output-audio-encoder", "aac",
        "--temp-path", str(a.temp_dir),
        "--jobs-path", str(a.jobs_dir),
        "--download-providers", "github",
        "--log-level", "info",
    ]  # fmt: skip
    return args


@dataclass
class RunOutcome:
    code: int
    lines: list[str] = field(default_factory=list)  # last TAIL_LINES non-empty lines
    seconds: float = 0.0
    startup_s: float | None = None
    canceled: bool = False


class FaceFusionFailure(Exception):
    """Classified failure: code CONTENT_BLOCKED | TOOL_FAILED (+ last useful line)."""

    def __init__(self, code: str, line: str, tail: list[str]) -> None:
        super().__init__(line)
        self.code = code
        self.line = line
        self.tail = tail


def _launch_error(lines: list[str]) -> str | None:
    """tools/launch.py start-up error: a JSON line {"event": "error", "code": "LAUNCH_FAILED"}."""
    for line in reversed(lines):
        if line.startswith("{") and '"event"' in line:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if isinstance(ev, dict) and ev.get("event") == "error":
                return str(ev.get("message") or ev.get("code") or "error al iniciar")
    return None


def classify(outcome: RunOutcome, output_exists: bool) -> FaceFusionFailure | None:
    """None when the run succeeded; else the failure to report."""
    lines = outcome.lines
    if outcome.code == 0 and output_exists:
        return None
    launch = _launch_error(lines)
    if launch:
        return FaceFusionFailure("TOOL_FAILED", launch, lines)
    if any(NSFW_RE.search(line) for line in lines):
        return FaceFusionFailure("CONTENT_BLOCKED", "contenido bloqueado", lines)
    errors = [line for line in lines if ERROR_RE.search(line)]
    if outcome.code != 0 and not output_exists and not errors:
        return FaceFusionFailure("CONTENT_BLOCKED", "contenido bloqueado", lines)
    useful = errors[-1] if errors else (lines[-1] if lines else f"código de salida {outcome.code}")
    if outcome.code == 0 and not output_exists:
        useful = f"no generó el archivo de salida ({useful})"
    return FaceFusionFailure("TOOL_FAILED", useful.strip()[:300], lines)


def kill_tree(proc: subprocess.Popen) -> None:
    """Cancel = kill the whole tree (FaceFusion spawns ffmpeg)."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(  # noqa: S603 - fixed argv
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True, timeout=15, check=False,
            )  # fmt: skip
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        with contextlib.suppress(OSError):
            proc.kill()


Spawn = Callable[..., subprocess.Popen]


def run_process(
    argv: list[str],
    env: dict[str, str],
    cwd: Path,
    *,
    on_progress: Callable[[float], None] | None = None,
    on_start: Callable[[subprocess.Popen], None] | None = None,
    is_canceled: Callable[[], bool] | None = None,
    timeout: float | None = None,
    spawn: Spawn | None = None,
) -> RunOutcome:
    """Run argv (list, shell=False) reading stdout+stderr merged; \\r-separated tqdm updates count
    as lines. Returns the exit code and the tail; progress callbacks get 0..1."""
    t0 = time.perf_counter()
    kwargs: dict = {
        "cwd": str(cwd),
        "env": env,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    proc = (spawn or subprocess.Popen)(argv, shell=False, **kwargs)  # noqa: S603
    if on_start:
        on_start(proc)
    tail: deque[str] = deque(maxlen=TAIL_LINES)
    outcome = RunOutcome(code=-1)
    stop = threading.Event()

    def watchdog() -> None:
        while not stop.wait(0.5):
            if (is_canceled and is_canceled()) or (
                timeout is not None and time.perf_counter() - t0 > timeout
            ):
                outcome.canceled = bool(is_canceled and is_canceled())
                kill_tree(proc)
                return

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    buf = b""
    assert proc.stdout is not None
    try:
        while True:
            reader = getattr(proc.stdout, "read1", proc.stdout.read)
            chunk = reader(4096)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for raw in parts:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if outcome.startup_s is None:
                    outcome.startup_s = round(time.perf_counter() - t0, 3)
                tail.append(line)
                m = PROGRESS_RE.search(line)
                if m and on_progress:
                    on_progress(min(1.0, float(m.group(1)) / 100.0))
        if buf.strip():
            tail.append(buf.decode("utf-8", errors="replace").strip())
        outcome.code = proc.wait()
    finally:
        stop.set()
        if proc.poll() is None:
            kill_tree(proc)
    outcome.lines = list(tail)
    outcome.seconds = round(time.perf_counter() - t0, 3)
    if is_canceled and is_canceled():
        outcome.canceled = True
    return outcome
