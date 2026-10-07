"""Chatterbox Multilingual TTS (Sprint 4 M2): provider + persistent tool subprocess client.

Chatterbox pins torch==2.6.0 and numpy<2, so it never runs in the workers' venv: it lives in
``tools/chatterbox/.venv`` (created by ``toolvenv.ensure("chatterbox")`` when the
``tts-chatterbox`` pack is downloaded) and runs ``tools/chatterbox/studio_tts_server.py`` through
the launcher ``tools/launch.py`` (``toolvenv.command``), which drops HF_TOKEN and sets
HF_HUB_OFFLINE=1. The bridge speaks JSON lines over stdin/stdout (protocol in the script and in
docs/trabajo/sprint4-contratos.md «M2»).

``ChatterboxClient`` (one per process, ``services.chatterbox_client()``):

- starts lazily on the first request, after ``GpuBudget.acquire("chatterbox", 4500, unload=stop)``
  (which first unloads Whisper/RVC/...); no VRAM -> CPU + ``gpu_fallback_cpu``;
- waits for ``ready`` (≤ 180 s: the first load reads ~3.2 GB), then serves one request at a time;
- stops after ``CHATTERBOX_IDLE_S`` (120 s) without requests and releases the budget; the budget
  unloading it (another model needs the GPU) also terminates the process;
- a child that dies mid-request is restarted ONCE and the request re-sent; a second death is
  ``TOOL_FAILED`` (502) with the last lines of its stderr in ``details.logTail``;
- a CUDA out-of-memory restarts it on CPU (``gpu_fallback_cpu``); on CPU every result also carries
  ``chatterbox_cpu_slow``;
- ``cancel(job_id)`` (POST /tts/cancel, audit fix 8) kills the bridge tree and releases the GPU, so
  a canceled job really stops (the next request starts it again);
- the VRAM it reserves is ``CHATTERBOX_VRAM_MB`` (default 4500, audit fix 14).

M3's ``studio_workers.toolvenv`` is imported lazily inside the functions; when it cannot be
imported the tool is ``TOOL_MISSING`` (broken): there is no fallback launcher (audit fix 9).
"""

from __future__ import annotations

import atexit
import contextlib
import json
import logging
import os
import queue
import re
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from ..config import REPO_ROOT, Settings
from ..schemas import TtsProviderInfo, TtsVoice
from .providers import SynthesisParams, TtsProvider

if TYPE_CHECKING:
    from ..gpu import GpuBudget
    from ..schemas import TtsRequest, VoiceRef

log = logging.getLogger("studio_workers")

PACK_ID = "tts-chatterbox"
TOOL_ID = "chatterbox"
VRAM_MB = 4500  # FEATURE_VRAM_MB.chatterbox [S] 3.5-5 GB; CHATTERBOX_VRAM_MB overrides it
MAX_TEXT = 5000
SERVER_SCRIPT = "studio_tts_server.py"
TOOL_DIR = REPO_ROOT / "tools" / "chatterbox"
MODELS_SUBDIR = "chatterbox"
DEFAULT_IDLE_S = 120.0
READY_TIMEOUT_S = 180.0
LANGUAGES = (
    ("ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja")
    + ("ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh")
)  # fmt: skip
DEFAULTS = {"language": "es", "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8}
T3_FILES = {"v3": "t3_mtl23ls_v3.safetensors", "v2": "t3_mtl23ls_v2.safetensors"}
VOICE_MULTILINGUAL = "chatterbox:multilingual"
CPU_SLOW = "chatterbox_cpu_slow"
GPU_FALLBACK_CPU = "gpu_fallback_cpu"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")

CommandFn = Callable[[list[str]], tuple[list[str], dict[str, str], Path]]


# ------------------------------------------------------------------------- tool venv (M3, lazy)


def _toolvenv() -> Any:
    """M3's toolvenv, or TOOL_MISSING (broken): never a silent fallback (audit fix 9)."""
    try:
        from .. import toolvenv  # noqa: PLC0415 - heavy module, imported on use
    except ImportError as exc:
        raise _coded(
            "TOOL_MISSING",
            "El entorno aislado de Chatterbox no está listo (roto): falta el lanzador de "
            f"herramientas ({exc}). Corré scripts\\windows\\setup.ps1 -Update.",
            details={"tool": TOOL_ID, "state": "broken", "packId": PACK_ID},
        ) from exc
    return toolvenv


def tool_status() -> dict[str, Any]:
    """``toolvenv.status("chatterbox")``: {state: ready|stale|missing|broken, variant?, ...}."""
    try:
        return dict(_toolvenv().status(TOOL_ID))
    except Exception as exc:  # a broken stamp (or no toolvenv) must not break GET /packs
        log.warning("toolvenv.status(chatterbox) failed: %s", exc)
        return {"state": "broken", "error": str(exc)}


def tool_summary() -> dict[str, str]:
    """``toolvenv.status_summary("chatterbox")`` -> PackSchema.tool {id, state}."""
    try:
        return dict(_toolvenv().status_summary(TOOL_ID))
    except Exception as exc:
        log.warning("toolvenv.status_summary(chatterbox) failed: %s", exc)
        return {"id": TOOL_ID, "state": "broken"}


def tool_command(args: list[str]) -> tuple[list[str], dict[str, str], Path]:
    """argv, env, cwd of the bridge (``toolvenv.command`` via tools/launch.py)."""
    argv, env, cwd = _toolvenv().command(TOOL_ID, SERVER_SCRIPT, args)
    return list(argv), dict(env), Path(cwd)


def vram_mb() -> int:
    """CHATTERBOX_VRAM_MB (.env / environment; empty or invalid = 4500): what GpuBudget reserves
    for the bridge. Lower it on a 6 GB card if Chatterbox fits (audit fix 14)."""
    try:
        raw = str(getattr(_toolvenv().tool_settings(), "chatterbox_vram_mb", "") or "").strip()
    except Exception:  # unreadable .env: default
        raw = ""
    raw = raw or os.environ.get("CHATTERBOX_VRAM_MB", "").strip()
    try:
        value = int(float(raw)) if raw else VRAM_MB
    except ValueError:
        return VRAM_MB
    return value if 500 <= value <= 24_000 else VRAM_MB


def idle_seconds() -> float:
    """CHATTERBOX_IDLE_S (.env / environment; empty = 120 s)."""
    try:
        return float(_toolvenv().tool_settings().seconds("chatterbox_idle_s", DEFAULT_IDLE_S))
    except Exception:  # unreadable .env / no toolvenv: default
        return DEFAULT_IDLE_S


def models_dir(models_root: Path) -> Path:
    return models_root / MODELS_SUBDIR


def installed_variant(models_root: Path) -> str:
    """Checkpoint the bridge loads: the tool venv's ``variant`` (v3 from git, v2 = PyPI 0.1.7
    fallback); without a stamp, the T3 file that is on disk (v3 preferred)."""
    variant = tool_status().get("variant")
    if variant in T3_FILES:
        return str(variant)
    folder = models_dir(models_root)
    if (folder / T3_FILES["v3"]).is_file():
        return "v3"
    if (folder / T3_FILES["v2"]).is_file():
        return "v2"
    return "v3"


def pack_installed(models_root: Path) -> bool:
    from ..packs import is_installed  # noqa: PLC0415 - avoid import cycles (errors -> tts)

    try:
        return is_installed(PACK_ID, models_root)
    except Exception as exc:
        log.warning("tts-chatterbox status failed: %s", exc)
        return False


# --------------------------------------------------------------------------------- client


@dataclass
class SynthesisOutcome:
    out: Path
    duration_s: float
    sample_rate: int
    rtf: float | None
    device: str
    model: str
    load_s: float | None = None
    chunks: int = 0
    warnings: list[str] = field(default_factory=list)


class _ChildDied(Exception):
    pass


class _OomFallback(Exception):
    pass


CANCELED_MSG = "Cancelado: la síntesis se detuvo."


def _coded(code: str, detail: str, **kw: Any) -> Exception:
    from ..errors import CodedError  # noqa: PLC0415 - errors imports tts.providers

    return CodedError(code, detail, **kw)


def _kill_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        tv = _toolvenv()
    except Exception:
        tv = None
    if tv is not None:
        tv.kill_tree(proc)
        return
    try:
        if os.name == "nt":
            subprocess.run(  # noqa: S603 - fixed argv
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=15,
                check=False,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        with contextlib.suppress(OSError):
            proc.kill()
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=10)


class ChatterboxClient:
    def __init__(
        self,
        settings: Settings,
        budget: GpuBudget | None = None,
        *,
        command: CommandFn | None = None,
        idle_s: float | None = None,
        ready_timeout_s: float = READY_TIMEOUT_S,
    ) -> None:
        self.settings = settings
        self.budget = budget
        self.command = command or tool_command
        self.idle_s = idle_s if idle_s is not None else idle_seconds()
        self.ready_timeout_s = ready_timeout_s
        # e2e / tests: ["--mock"] (tone instead of the model, no torch).
        self.extra_args: list[str] = []
        self._lock = threading.Lock()  # one synthesis at a time
        self._proc_lock = threading.RLock()  # process start/stop (budget unload, idle timer)
        self._proc: subprocess.Popen[str] | None = None
        self._events: queue.Queue[dict[str, Any]] | None = None
        self._tail: deque[str] = deque(maxlen=40)
        self._idle_timer: threading.Timer | None = None
        self._force_cpu = False
        self._start_warnings: list[str] = []
        self.ready: dict[str, Any] | None = None
        self.starts = 0
        self.last_used = 0.0
        self.vram_mb = vram_mb()
        # Audit fix 8: ids canceled by POST /tts/cancel (the running one, or one still waiting).
        self._canceled: set[str] = set()
        self._current: str | None = None
        atexit.register(self.stop)

    # ------------------------------------------------------------------ lifecycle
    @property
    def running(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    def status(self) -> dict[str, Any]:
        ready = self.ready or {}
        return {
            "running": self.running,
            "device": ready.get("device"),
            "model": ready.get("model"),
            "load_s": ready.get("load_s"),
            "starts": self.starts,
            "idle_s": self.idle_s,
            "pid": self._proc.pid if self.running and self._proc else None,
        }

    def log_tail(self) -> list[str]:
        return list(self._tail)

    def stop(self) -> None:
        """Terminate the bridge (GpuBudget unload, idle timeout, reset). Never takes ``_lock``."""
        with self._proc_lock:
            self._cancel_idle()
            proc, self._proc = self._proc, None
            self.ready = None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                assert proc.stdin is not None
                proc.stdin.write('{"op": "shutdown"}\n')
                proc.stdin.flush()
                proc.wait(timeout=2)
            except (OSError, ValueError, AssertionError, subprocess.TimeoutExpired):
                pass
        _kill_tree(proc)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            with contextlib.suppress(OSError, ValueError):
                if stream is not None:
                    stream.close()
        log.info("chatterbox: bridge stopped")

    def _unload_from_budget(self) -> None:
        self.stop()

    def cancel(self, job_id: str | None = None) -> bool:
        """POST /tts/cancel: kill the bridge tree (and free the GPU) if it is synthesizing `job_id`
        (any request when None); a request still waiting for the lock is dropped when it gets it.
        Never takes ``_lock``. True when a running synthesis was stopped."""
        if job_id:
            self._canceled.add(job_id)
        current = self._current
        if current is None or (job_id is not None and current != job_id):
            return False
        self._canceled.add(current)
        log.info("chatterbox: cancel %s, stopping the bridge", current)
        if self.budget is not None and self.budget.resident == "chatterbox":
            self.budget.release("chatterbox")  # -> unload -> stop()
        self.stop()
        return True

    def _check_canceled(self, request_id: str) -> None:
        if request_id in self._canceled:
            self._canceled.discard(request_id)
            raise _coded("CANCELED", CANCELED_MSG, status=409)

    def _cancel_idle(self) -> None:
        timer, self._idle_timer = self._idle_timer, None
        if timer is not None:
            timer.cancel()

    def _schedule_idle(self) -> None:
        with self._proc_lock:
            self._cancel_idle()
            if self.idle_s <= 0 or not self.running:
                return
            timer = threading.Timer(self.idle_s, self._idle_check)
            timer.daemon = True
            self._idle_timer = timer
            timer.start()

    def _idle_check(self) -> None:
        if not self._lock.acquire(blocking=False):
            return  # a request is running: it reschedules when it ends
        try:
            if time.monotonic() - self.last_used + 0.05 < self.idle_s:
                self._schedule_idle()
                return
            log.info("chatterbox: idle %.0f s, stopping the bridge", self.idle_s)
            if self.budget is not None and self.budget.resident == "chatterbox":
                self.budget.release("chatterbox")  # -> unload -> stop()
            self.stop()
        finally:
            self._lock.release()

    def _decide_device(self) -> tuple[str, list[str]]:
        if not self.settings.use_cuda or self._force_cpu:
            return "cpu", ([GPU_FALLBACK_CPU] if self._force_cpu else [])
        if self.budget is None:
            return "cuda", []
        decision = self.budget.acquire("chatterbox", self.vram_mb, self._unload_from_budget)
        return decision.device, list(decision.warnings)

    def _start(self) -> dict[str, Any]:
        device, warnings = self._decide_device()
        variant = installed_variant(self.settings.models_root)
        args = [
            "--models-dir", str(models_dir(self.settings.models_root)),
            "--device", device, "--t3", variant, *self.extra_args,
        ]  # fmt: skip
        argv, env, cwd = self.command(args)
        log.info("chatterbox: starting bridge (%s, %s, t3 %s)", device, Path(argv[0]).name, variant)
        kwargs: dict[str, Any] = dict(_toolvenv().popen_kwargs())  # own group: kill the tree
        self._tail.clear()
        proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=str(cwd),
            env=env,
            **kwargs,
        )
        events: queue.Queue[dict[str, Any]] = queue.Queue()
        threading.Thread(target=self._read_stdout, args=(proc, events), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
        with self._proc_lock:
            self._proc, self._events = proc, events
        self.starts += 1
        ready = self._wait_ready(proc, events)
        got = str(ready.get("device") or "cpu")
        warnings += [str(w) for w in ready.get("warnings") or []]
        if device == "cuda" and got != "cuda" and self.budget is not None:
            warnings += self.budget.failed("chatterbox")
        ready["device"] = got
        self._start_warnings = list(dict.fromkeys(warnings))
        self.ready = ready
        return ready

    def _read_stdout(
        self, proc: subprocess.Popen[str], events: queue.Queue[dict[str, Any]]
    ) -> None:
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    self._tail.append(line)
                    continue
                if isinstance(event, dict):
                    events.put(event)
        except (OSError, ValueError):
            pass
        events.put({"event": "_exit"})

    def _read_stderr(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stderr is not None
        try:
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    self._tail.append(line)
                    log.debug("chatterbox: %s", line)
        except (OSError, ValueError):
            pass

    def _wait_ready(
        self, proc: subprocess.Popen[str], events: queue.Queue[dict[str, Any]]
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.ready_timeout_s
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                self.stop()
                raise self._failed(
                    f"no respondió en {int(self.ready_timeout_s)} s al cargar el modelo"
                )
            try:
                event = events.get(timeout=min(left, 1.0))
            except queue.Empty:
                continue
            kind = event.get("event")
            if kind == "ready":
                return event
            if kind == "error":
                self.stop()
                self._raise_tool_error(event, during_load=True)
            if kind == "_exit":
                with contextlib.suppress(subprocess.TimeoutExpired):
                    proc.wait(timeout=10)
                self.stop()
                raise _ChildDied(f"el proceso terminó al arrancar (código {proc.returncode})")

    # ------------------------------------------------------------------ errors
    def _failed(self, message: str) -> Exception:
        tail = self.log_tail()
        useful = next((ln for ln in reversed(tail) if ln.strip()), message)
        return _coded(
            "TOOL_FAILED",
            f"Chatterbox terminó con error: {message if message else useful}.",
            details={"logTail": tail[-40:], "tool": TOOL_ID},
        )

    def _raise_tool_error(self, event: dict[str, Any], *, during_load: bool = False) -> None:
        code = str(event.get("code") or "INTERNAL")
        message = str(event.get("message") or code)
        if code == "MODEL_MISSING":
            from ..packs import PackRequiredError  # noqa: PLC0415

            raise PackRequiredError(PACK_ID, f"Chatterbox: {message}. Volvé a bajar el paquete.")
        if code == "WATERMARK_MISSING":
            raise _coded(
                "TOOL_MISSING",
                "El entorno aislado de Chatterbox no está listo (roto): " + message,
                details={"tool": TOOL_ID, "state": "broken", "packId": PACK_ID},
            )
        if code == "REF_INVALID":
            raise _coded(
                "VOICE_SAMPLE_INVALID",
                "La muestra tiene que durar entre 5 y 60 s y tener voz. (" + message + ")",
            )
        if code == "CUDA_OOM" and not self._force_cpu and self.settings.use_cuda:
            raise _OomFallback(message)
        raise self._failed(("al cargar el modelo: " if during_load else "") + message)

    # ------------------------------------------------------------------ requests
    def synthesize(
        self,
        *,
        job_id: str | None,
        text: str,
        out: Path,
        language: str = "es",
        ref: Path | None = None,
        exaggeration: float = 0.5,
        cfg: float = 0.5,
        temperature: float = 0.8,
        seed: int | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> SynthesisOutcome:
        request = {
            "id": job_id or f"tts-{int(time.time() * 1000)}",
            "op": "synthesize",
            "text": text,
            "language": language,
            "ref": str(ref) if ref is not None else None,
            "exaggeration": exaggeration,
            "cfg": cfg,
            "temperature": temperature,
            "seed": seed,
            "out": str(out),
        }
        with self._lock:
            self._cancel_idle()
            try:
                self._check_canceled(request["id"])
                self._current = request["id"]
                return self._synthesize_locked(request, on_progress)
            finally:
                self._current = None
                self._canceled.discard(request["id"])
                self.last_used = time.monotonic()
                self._schedule_idle()

    def _synthesize_locked(
        self, request: dict[str, Any], on_progress: Callable[[int, int], None] | None
    ) -> SynthesisOutcome:
        deaths = 0
        oom_retry = False
        while True:
            try:
                ready = self.ready if self.running and self.ready else self._start()
                return self._request(request, ready, on_progress)
            except _ChildDied as exc:
                self._check_canceled(request["id"])  # killed by cancel(): no restart
                deaths += 1
                self.stop()
                if deaths > 1:
                    raise self._failed(f"el proceso se cerró dos veces ({exc})") from exc
                log.warning("chatterbox: bridge died (%s), restarting once", exc)
            except _OomFallback as exc:
                self.stop()
                if oom_retry:
                    raise self._failed(f"sin memoria de GPU ({exc})") from exc
                oom_retry = True
                log.warning("chatterbox: CUDA out of memory, restarting on CPU")
                if self.budget is not None:
                    self.budget.failed("chatterbox")
                self._force_cpu = True

    def _request(
        self,
        request: dict[str, Any],
        ready: dict[str, Any],
        on_progress: Callable[[int, int], None] | None,
    ) -> SynthesisOutcome:
        proc, events = self._proc, self._events
        if proc is None or events is None or proc.poll() is not None:
            raise _ChildDied("el proceso no está corriendo")
        try:
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(request, ensure_ascii=True) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError, AssertionError) as exc:
            raise _ChildDied(f"no se pudo escribir al proceso: {exc}") from exc
        if self.budget is not None:
            self.budget.touch("chatterbox")
        while True:
            try:
                event = events.get(timeout=1.0)
            except queue.Empty:
                if proc.poll() is not None and events.empty():
                    raise _ChildDied(f"el proceso terminó (código {proc.returncode})") from None
                continue
            kind = event.get("event")
            if kind == "_exit":
                raise _ChildDied(f"el proceso terminó (código {proc.poll()})")
            if event.get("id") not in (None, request["id"]):
                continue  # a late answer to an older request
            if kind == "progress" and on_progress is not None:
                with contextlib.suppress(Exception):
                    on_progress(int(event.get("chunk") or 0), int(event.get("chunks") or 0))
            elif kind == "error":
                self._raise_tool_error(event)
            elif kind == "done":
                device = str(ready.get("device") or "cpu")
                warnings = list(self._start_warnings)
                if device == "cpu":
                    warnings.append(CPU_SLOW)
                return SynthesisOutcome(
                    out=Path(str(event.get("out") or request["out"])),
                    duration_s=float(event.get("duration_s") or 0.0),
                    sample_rate=int(event.get("sample_rate") or 24_000),
                    rtf=float(event["rtf"]) if event.get("rtf") is not None else None,
                    device=device,
                    model=str(ready.get("model") or "mtl-v3"),
                    load_s=ready.get("load_s"),
                    chunks=int(event.get("chunks") or 0),
                    warnings=list(dict.fromkeys(warnings)),
                )


# ------------------------------------------------------------------------------ voice refs


def _consent_required(person_id: str, reason: str) -> Exception:
    motivo = {
        "none": "sin consentimiento",
        "deleted": "la persona fue dada de baja",
        "scope": "el consentimiento no cubre ese uso",
    }.get(reason, reason)
    return _coded(
        "CONSENT_REQUIRED",
        f"La persona no tiene un consentimiento vigente para usar su voz ({motivo}). "
        "Registralo en Ajustes → Personas.",
        details={"personId": person_id or "?", "scope": "voice", "reason": reason},
    )


def check_voice_ref(settings: Settings, ref: VoiceRef) -> Path:
    """Defense in depth for the reference sample (the api already checked the consent gate):
    the path must resolve inside STORAGE_DIR (``..`` -> 400); «Voz propia» (``consent: "self"``)
    never lives under consent/; a Person sample must be under ``consent/persons/<id>/`` of a
    Person that was not archived (deleted) AND ``consent`` must be a valid voice consent of the
    api's mirror consent/active.json that lists this very sample (audit fix 4)."""
    from ..consent_mirror import require_consent  # noqa: PLC0415
    from ..routers.analyze import resolve_input  # noqa: PLC0415

    path = resolve_input(settings, ref.path)
    rel = settings.storage_relative(path)
    parts = PurePosixPath(rel).parts
    if ref.consent == "self":
        if parts and parts[0].lower() == "consent":
            raise _consent_required("", "scope")
        return path
    if len(parts) < 4 or parts[0] != "consent" or parts[1] != "persons":
        raise _consent_required("", "scope")
    person_id = parts[2]
    if not _ID_RE.match(ref.consent):
        raise _consent_required(person_id, "none")
    if (settings.storage_root / "consent" / "archive" / person_id).exists():
        raise _consent_required(person_id, "deleted")
    require_consent(settings.storage_root, ref.consent, "voice", [rel])
    return path


# ------------------------------------------------------------------------------- provider


class ChatterboxProvider(TtsProvider):
    id = "chatterbox"
    name = "Chatterbox (local, GPU)"

    def enabled(self) -> bool:
        return pack_installed(self.settings.models_root)

    def info(self) -> TtsProviderInfo:
        installed = self.enabled()
        variant = installed_variant(self.settings.models_root)
        return TtsProviderInfo(
            id="chatterbox",
            name=self.name,
            enabled=installed,
            status="local" if installed else "falta paquete",
            pack_id=PACK_ID,
            installed=installed,
            supports_clone=True,
            models=[f"mtl-{variant}"] if installed else ["mtl-v3", "mtl-v2"],
            languages=list(LANGUAGES),
            gpu=True,
        )

    def voices(self) -> list[TtsVoice]:
        if not self.enabled():
            return []
        return [
            TtsVoice(
                provider="chatterbox",
                id=VOICE_MULTILINGUAL,
                name="Chatterbox multilingüe",
                language="es",
                installed=True,
            )
        ]

    def synthesize(self, text: str, voice: str, params: SynthesisParams, out_wav: Path) -> None:
        """Generic provider interface: the built-in voice, default parameters (the router uses
        ``synthesize_request`` for clones and the Chatterbox fields)."""
        from ..services import chatterbox_client  # noqa: PLC0415

        chatterbox_client().synthesize(job_id=None, text=text[:MAX_TEXT], out=out_wav)


def synthesize_request(
    req: TtsRequest,
    settings: Settings,
    wav: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> SynthesisOutcome:
    """POST /tts with provider "chatterbox" -> SynthesisOutcome (+ request warnings).

    Order of the checks: text ≤ 5000 (400) -> pack tts-chatterbox (409 PACK_REQUIRED) -> tool
    venv ready (409 TOOL_MISSING) -> reference sample (400 / 403 CONSENT_REQUIRED) -> language.
    """
    from ..packs import require_pack  # noqa: PLC0415
    from ..services import chatterbox_client  # noqa: PLC0415

    if len(req.text) > MAX_TEXT:
        raise ValueError(
            f"Chatterbox lee hasta {MAX_TEXT} caracteres por vez (el texto tiene {len(req.text)})"
        )
    require_pack(PACK_ID, settings.models_root)
    state = str(tool_status().get("state") or "missing")
    if state != "ready":
        from ..errors import CodedError  # noqa: PLC0415

        estado = {"stale": "desactualizado", "missing": "falta", "broken": "roto"}.get(state, state)
        raise CodedError(
            "TOOL_MISSING",
            f"El entorno aislado de Chatterbox no está listo ({estado}). Volvé a descargar el "
            "paquete en Ajustes → Paquetes de IA o corré scripts\\windows\\setup.ps1 -Update.",
            details={"tool": TOOL_ID, "state": state, "packId": PACK_ID},
        )
    ref = check_voice_ref(settings, req.voice_ref) if req.voice_ref is not None else None
    language = req.language or DEFAULTS["language"]
    if language not in LANGUAGES:
        raise ValueError(f"Chatterbox no tiene el idioma «{language}»")
    warnings: list[str] = []
    variant = installed_variant(settings.models_root)
    if req.model and req.model != f"mtl-{variant}":
        warnings.append("chatterbox_model_unavailable")  # the installed checkpoint is used
    if req.voice_ref is not None:
        log.info("chatterbox: clone (%s) for job %s", req.voice_ref.consent, req.job_id)
    outcome = chatterbox_client().synthesize(
        job_id=req.job_id,
        text=req.text,
        out=wav,
        language=language,
        ref=ref,
        exaggeration=req.exaggeration if req.exaggeration is not None else DEFAULTS["exaggeration"],
        cfg=req.cfg if req.cfg is not None else DEFAULTS["cfg"],
        temperature=req.temperature if req.temperature is not None else DEFAULTS["temperature"],
        seed=req.seed,
        on_progress=on_progress,
    )
    outcome.warnings = list(dict.fromkeys([*outcome.warnings, *warnings]))
    return outcome
