"""Sprint 4 M2: Chatterbox bridge protocol + ChatterboxClient (no torch, no model, no network).

The real bridge (tools/chatterbox/studio_tts_server.py) runs with ``--mock`` on this interpreter
(tone of 0.06 s per character); failure modes use tiny fake tool scripts speaking the same
JSON-lines protocol.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import textwrap
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from studio_workers.errors import CodedError
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo
from studio_workers.packs import PackRequiredError
from studio_workers.tts import chatterbox as cb

REPO = Path(__file__).resolve().parents[3]
BRIDGE = REPO / "tools" / "chatterbox" / "studio_tts_server.py"


def _bridge_module():
    spec = importlib.util.spec_from_file_location("studio_tts_server_under_test", BRIDGE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def real_bridge(extra: list[str] | None = None):
    def command(args: list[str]):
        return [sys.executable, str(BRIDGE), *args, *(extra or [])], {}, BRIDGE.parent

    return command


def fake_tool(tmp_path: Path, body: str, name: str = "fake_tool.py"):
    """A fake bridge script: `body` runs after the helpers (emit, args, read loop available)."""
    script = tmp_path / name
    script.write_text(
        textwrap.dedent(
            """\
            import json, math, os, sys, wave
            args = sys.argv[1:]
            device = args[args.index("--device") + 1] if "--device" in args else "cpu"
            def emit(e):
                sys.stdout.write(json.dumps(e) + "\\n"); sys.stdout.flush()
            def write_tone(path, seconds):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with wave.open(path, "wb") as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
                    w.writeframes(b"\\x00\\x01" * int(24000 * seconds))
            """
        )
        + textwrap.dedent(body),
        "utf-8",
    )

    def command(args: list[str]):
        return [sys.executable, str(script), *args], {}, tmp_path

    return command


def settings(models: Path, use_cuda: bool = False) -> SimpleNamespace:
    return SimpleNamespace(use_cuda=use_cuda, models_root=models)


def budget(free_mb: int | None = 5800, use_cuda: bool = True) -> GpuBudget:
    probe = (lambda: VramInfo("RTX 4050", 6141, free_mb, "test")) if free_mb is not None else None
    return GpuBudget(use_cuda=use_cuda, probe=probe or (lambda: None), reserve_mb=800)


@pytest.fixture
def models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.delenv("CHATTERBOX_PYTHON", raising=False)
    return root


def wav_props(path: Path) -> tuple[int, int, float]:
    with wave.open(str(path), "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getnframes() / w.getframerate()


def dominant_hz(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
        rate = w.getframerate()
    spec = np.abs(np.fft.rfft(data))
    return float(np.fft.rfftfreq(len(data), 1 / rate)[int(np.argmax(spec[1:])) + 1])


# ------------------------------------------------------------------------------- chunking


def test_split_text_chunks_at_sentences_and_never_exceeds_300() -> None:
    bridge = _bridge_module()
    text = (
        "Hola, che. ¿Cómo andás? ¡Qué lindo día! "
        + "Esta es una oración bastante larga que sigue y sigue, con comas, pausas y detalles; "
        * 12
        + "Fin."
    )
    chunks = bridge.split_text(text)
    assert len(chunks) > 1
    assert all(0 < len(c) <= 300 for c in chunks)
    assert chunks[0].startswith("Hola, che. ¿Cómo andás? ¡Qué lindo día!")
    assert " ".join(chunks).split() == text.split()  # nothing lost, nothing added
    # one very long "word" (URL) is hard-cut; short text stays one chunk; empty -> no chunks
    assert all(len(c) <= 300 for c in bridge.split_text("x" * 700))
    assert bridge.split_text("Hola.") == ["Hola."]
    assert bridge.split_text("   \n ") == []
    assert len(bridge.split_text("a. " * 400, 300)) >= 4


# ------------------------------------------------------------------------------- protocol


def test_mock_protocol_happy_path_wav_progress_and_cpu_warning(tmp_path: Path, models) -> None:
    client = cb.ChatterboxClient(
        settings(models), budget(), command=real_bridge(["--mock"]), idle_s=0
    )
    seen: list[tuple[int, int]] = []
    out = tmp_path / "renders" / "j1.wav"
    text = "Hola, che. " * 40  # 440 characters -> 2 chunks
    try:
        res = client.synthesize(
            job_id="j1", text=text, out=out, on_progress=lambda c, n: seen.append((c, n))
        )
    finally:
        client.stop()
    rate, channels, seconds = wav_props(out)
    assert (rate, channels) == (24_000, 1)
    assert res.sample_rate == 24_000 and res.device == "cpu" and res.model == "mtl-v3"
    assert res.chunks == 2 and seen[0] == (0, 2) and seen[-1] == (2, 2)
    # 0.06 s per character of each chunk + 120 ms between chunks
    assert seconds == pytest.approx(res.duration_s, abs=0.01)
    assert seconds == pytest.approx(len(text.strip()) * 0.06 + 0.12, abs=0.2)
    assert res.rtf is not None and res.rtf >= 0
    assert res.warnings == [cb.CPU_SLOW]  # CPU by configuration: no gpu_fallback_cpu
    assert dominant_hz(out) == pytest.approx(220, abs=3)
    assert not out.with_name("j1.wav.tmp").exists()


def test_reference_sample_and_errors_keep_the_process(tmp_path: Path, models) -> None:
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"RIFF")
    client = cb.ChatterboxClient(
        settings(models), budget(), command=real_bridge(["--mock"]), idle_s=0
    )
    try:
        res = client.synthesize(
            job_id="r1", text="Probando mi voz.", out=tmp_path / "r1.wav", ref=ref
        )
        assert dominant_hz(res.out) == pytest.approx(330, abs=3)
        pid = client.status()["pid"]
        with pytest.raises(CodedError) as err:
            client.synthesize(job_id="r2", text="x", out=tmp_path / "r2.wav", ref=tmp_path / "no")
        assert err.value.code == "VOICE_SAMPLE_INVALID" and err.value.status == 400
        assert client.status()["pid"] == pid and client.starts == 1  # same bridge, still alive
    finally:
        client.stop()
    assert not client.running


def test_idle_timeout_stops_the_bridge_and_releases_the_budget(tmp_path: Path, models) -> None:
    gpu = budget()
    client = cb.ChatterboxClient(
        settings(models, use_cuda=True), gpu, command=real_bridge(["--mock"]), idle_s=0.4
    )
    try:
        res = client.synthesize(job_id="i1", text="Hola.", out=tmp_path / "i1.wav")
        assert res.device == "cuda" and res.warnings == []  # --device cuda reaches the mock
        assert gpu.resident == "chatterbox" and client.running
        deadline = time.monotonic() + 5
        while client.running and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not client.running
        assert gpu.resident is None
    finally:
        client.stop()


def test_budget_unload_kills_the_child(tmp_path: Path, models) -> None:
    gpu = budget()
    client = cb.ChatterboxClient(
        settings(models, use_cuda=True), gpu, command=real_bridge(["--mock"]), idle_s=0
    )
    try:
        client.synthesize(job_id="u1", text="Hola.", out=tmp_path / "u1.wav")
        proc = client._proc
        assert proc is not None and proc.poll() is None
        # Whisper needs the GPU: the budget unloads Chatterbox -> the subprocess ends
        assert gpu.acquire("whisper", 1500, lambda: None).device == "cuda"
        assert proc.wait(timeout=10) is not None and not client.running
        # the next request starts it again (and evicts Whisper)
        client.synthesize(job_id="u2", text="Otra vez.", out=tmp_path / "u2.wav")
        assert client.starts == 2 and gpu.resident == "chatterbox"
    finally:
        client.stop()


def test_no_vram_falls_back_to_cpu_with_warnings(tmp_path: Path, models) -> None:
    client = cb.ChatterboxClient(
        settings(models, use_cuda=True),
        budget(free_mb=1200),
        command=real_bridge(["--mock"]),
        idle_s=0,
    )
    try:
        res = client.synthesize(job_id="c1", text="Hola.", out=tmp_path / "c1.wav")
    finally:
        client.stop()
    assert res.device == "cpu"
    assert res.warnings == [GPU_FALLBACK_CPU, cb.CPU_SLOW]


# ------------------------------------------------------------------------------- failures


def test_child_crash_restarts_once_then_succeeds(tmp_path: Path, models) -> None:
    marker = tmp_path / "crashed-once"
    command = fake_tool(
        tmp_path,
        f"""
        emit({{"event": "ready", "device": device, "load_s": 0.1, "model": "mtl-v3"}})
        for line in sys.stdin:
            msg = json.loads(line)
            if msg.get("op") != "synthesize":
                continue
            if not os.path.exists({str(marker)!r}):
                open({str(marker)!r}, "w").close()
                print("boom: segfault simulado", file=sys.stderr, flush=True)
                os._exit(3)
            write_tone(msg["out"], 0.5)
            emit({{"event": "done", "id": msg["id"], "out": msg["out"], "duration_s": 0.5,
                  "sample_rate": 24000, "rtf": 0.4}})
        """,
    )
    client = cb.ChatterboxClient(settings(models), None, command=command, idle_s=0)
    try:
        res = client.synthesize(job_id="k1", text="Hola.", out=tmp_path / "k1.wav")
    finally:
        client.stop()
    assert client.starts == 2 and res.duration_s == 0.5 and res.rtf == 0.4


def test_child_crashing_twice_is_tool_failed_with_log_tail(tmp_path: Path, models) -> None:
    command = fake_tool(
        tmp_path,
        """
        emit({"event": "ready", "device": device, "load_s": 0.1, "model": "mtl-v3"})
        for line in sys.stdin:
            print("Traceback: RuntimeError: modelo roto", file=sys.stderr, flush=True)
            os._exit(1)
        """,
    )
    client = cb.ChatterboxClient(settings(models), None, command=command, idle_s=0)
    with pytest.raises(CodedError) as err:
        client.synthesize(job_id="k2", text="Hola.", out=tmp_path / "k2.wav")
    client.stop()
    assert err.value.code == "TOOL_FAILED" and err.value.status == 502
    assert client.starts == 2
    assert "Chatterbox terminó con error" in str(err.value)
    assert any("modelo roto" in ln for ln in err.value.details["logTail"])


def test_ready_timeout_is_tool_failed(tmp_path: Path, models) -> None:
    command = fake_tool(tmp_path, "import time\ntime.sleep(30)\n")
    client = cb.ChatterboxClient(
        settings(models), None, command=command, idle_s=0, ready_timeout_s=0.5
    )
    t0 = time.monotonic()
    with pytest.raises(CodedError) as err:
        client.synthesize(job_id="t1", text="Hola.", out=tmp_path / "t1.wav")
    assert err.value.code == "TOOL_FAILED" and time.monotonic() - t0 < 10
    assert not client.running


def test_missing_model_files_are_pack_required(tmp_path: Path, models) -> None:
    # The real bridge (no --mock) checks the files before importing torch.
    client = cb.ChatterboxClient(settings(models), None, command=real_bridge(), idle_s=0)
    with pytest.raises(PackRequiredError) as err:
        client.synthesize(job_id="m1", text="Hola.", out=tmp_path / "m1.wav")
    assert err.value.pack_id == "tts-chatterbox"
    assert "t3_mtl23ls_v3.safetensors" in str(err.value)


def test_broken_watermark_is_tool_missing_broken(tmp_path: Path, models) -> None:
    command = fake_tool(
        tmp_path,
        'emit({"event": "error", "id": None, "code": "WATERMARK_MISSING", "message": "PerTh"})\n'
        "sys.exit(3)\n",
    )
    client = cb.ChatterboxClient(settings(models), None, command=command, idle_s=0)
    with pytest.raises(CodedError) as err:
        client.synthesize(job_id="w1", text="Hola.", out=tmp_path / "w1.wav")
    assert err.value.code == "TOOL_MISSING" and err.value.status == 409
    assert err.value.details == {
        "tool": "chatterbox",
        "state": "broken",
        "packId": "tts-chatterbox",
    }


def test_cuda_oom_restarts_on_cpu(tmp_path: Path, models) -> None:
    command = fake_tool(
        tmp_path,
        """
        emit({"event": "ready", "device": device, "load_s": 0.1, "model": "mtl-v3"})
        for line in sys.stdin:
            msg = json.loads(line)
            if msg.get("op") != "synthesize":
                continue
            if device == "cuda":
                emit({"event": "error", "id": msg["id"], "code": "CUDA_OOM", "message": "OOM"})
                continue
            write_tone(msg["out"], 0.3)
            emit({"event": "done", "id": msg["id"], "out": msg["out"], "duration_s": 0.3,
                  "sample_rate": 24000, "rtf": 2.0})
        """,
    )
    gpu = budget()
    client = cb.ChatterboxClient(settings(models, use_cuda=True), gpu, command=command, idle_s=0)
    try:
        res = client.synthesize(job_id="o1", text="Hola.", out=tmp_path / "o1.wav")
    finally:
        client.stop()
    assert res.device == "cpu" and client.starts == 2
    assert res.warnings == [GPU_FALLBACK_CPU, cb.CPU_SLOW]
    assert gpu.resident is None and gpu.last_fallback == "chatterbox"


def test_requests_are_ascii_json_lines_with_absolute_paths(tmp_path: Path, models) -> None:
    log = tmp_path / "requests.jsonl"
    command = fake_tool(
        tmp_path,
        f"""
        emit({{"event": "ready", "device": device, "load_s": 0.1, "model": "mtl-v2"}})
        for line in sys.stdin:
            open({str(log)!r}, "a", encoding="ascii").write(line)
            msg = json.loads(line)
            if msg.get("op") == "synthesize":
                write_tone(msg["out"], 0.2)
                emit({{"event": "progress", "id": "other-job", "chunk": 9, "chunks": 9}})
                emit({{"event": "done", "id": msg["id"], "out": msg["out"], "duration_s": 0.2,
                      "sample_rate": 24000, "rtf": 0.5}})
        """,
    )
    client = cb.ChatterboxClient(settings(models), None, command=command, idle_s=0)
    seen: list = []
    out = tmp_path / "renders con espacio" / "señal.wav"
    try:
        res = client.synthesize(
            job_id="a1",
            text="¿Qué onda?",
            out=out,
            language="es",
            exaggeration=0.7,
            cfg=0.3,
            temperature=0.9,
            seed=3,
            on_progress=lambda c, n: seen.append(c),
        )
    finally:
        client.stop()
    line = log.read_text("ascii").splitlines()[0]
    req = json.loads(line)
    assert req == {
        "id": "a1",
        "op": "synthesize",
        "text": "¿Qué onda?",
        "language": "es",
        "ref": None,
        "exaggeration": 0.7,
        "cfg": 0.3,
        "temperature": 0.9,
        "seed": 3,
        "out": str(out),
    }
    assert seen == [] and res.model == "mtl-v2"  # progress of another id is ignored


def test_bridge_argv_is_a_list_with_models_dir_device_and_variant(tmp_path: Path, models) -> None:
    calls: list[list[str]] = []

    def command(args: list[str]):
        calls.append(args)
        return real_bridge(["--mock"])(args)

    (models / "chatterbox").mkdir()
    (models / "chatterbox" / "t3_mtl23ls_v2.safetensors").write_bytes(b"x")
    client = cb.ChatterboxClient(settings(models), None, command=command, idle_s=0)
    try:
        res = client.synthesize(job_id="v2", text="Hola.", out=tmp_path / "v2.wav")
    finally:
        client.stop()
    assert calls == [["--models-dir", str(models / "chatterbox"), "--device", "cpu", "--t3", "v2"]]
    assert res.model == "mtl-v2"


def test_bridge_goes_through_toolvenv_and_has_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Audit fix 9: the bridge always starts via toolvenv.command + tools/launch.py (allowlisted
    environment); without toolvenv it is TOOL_MISSING (broken), never a plain Popen."""
    import builtins

    monkeypatch.setenv("HF_TOKEN", "hf_secret")
    monkeypatch.setenv("CHATTERBOX_PYTHON", sys.executable)
    argv, env, cwd = cb.tool_command(["--mock"])
    assert argv[0] == sys.executable and Path(argv[1]).name == "launch.py"
    assert argv[-2:] == ["studio_tts_server.py", "--mock"]
    assert "HF_TOKEN" not in env and env["HF_HUB_OFFLINE"] == "1" and cwd == BRIDGE.parent
    real_import = builtins.__import__

    def no_toolvenv(name, globals=None, locals=None, fromlist=(), level=0):  # type: ignore[no-untyped-def]
        if fromlist and "toolvenv" in fromlist and level == 2:
            raise ImportError("toolvenv roto")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", no_toolvenv)
    with pytest.raises(CodedError) as err:
        cb.tool_command(["--mock"])
    assert err.value.code == "TOOL_MISSING" and err.value.details["state"] == "broken"
    assert cb.tool_status()["state"] == "broken"


HANGING_BRIDGE = """
emit({"event": "ready", "device": device, "load_s": 0.1, "model": "mtl-v3"})
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "synthesize":
        emit({"event": "progress", "id": req["id"], "chunk": 1, "chunks": 3})
        import time
        time.sleep(120)
"""


def test_cancel_kills_the_running_bridge_and_frees_the_gpu(tmp_path: Path, models) -> None:
    """Audit fix 8: POST /tts/cancel -> ChatterboxClient.cancel(job) kills the bridge tree and
    releases the GPU budget; the request ends CANCELED (no automatic restart)."""
    import threading

    gpu = budget()
    client = cb.ChatterboxClient(
        settings(models, use_cuda=True), gpu, command=fake_tool(tmp_path, HANGING_BRIDGE), idle_s=0
    )
    errors: list[BaseException] = []

    def go() -> None:
        try:
            client.synthesize(job_id="k1", text="Hola.", out=tmp_path / "k1.wav")
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    th = threading.Thread(target=go)
    th.start()
    try:
        deadline = time.monotonic() + 15
        while client._current != "k1" or not client.running:
            assert time.monotonic() < deadline, "the bridge did not start"
            time.sleep(0.05)
        proc = client._proc
        assert gpu.resident == "chatterbox"
        assert client.cancel("other-job") is False  # another job: nothing happens
        assert client.running
        assert client.cancel("k1") is True
        th.join(timeout=20)
        assert not th.is_alive()
        assert errors and isinstance(errors[0], CodedError) and errors[0].code == "CANCELED"
        assert proc is not None and proc.poll() is not None
        assert gpu.resident is None and not client.running and client.starts == 1
        # a job canceled while it waited for the lock never starts the bridge
        assert client.cancel("k2") is False
        with pytest.raises(CodedError) as queued:
            client.synthesize(job_id="k2", text="Hola.", out=tmp_path / "k2.wav")
        assert queued.value.code == "CANCELED" and client.starts == 1
    finally:
        client.stop()


def test_vram_reservation_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit fix 14: CHATTERBOX_VRAM_MB (default 4500) and GPU_RESERVE_MB (default 800)."""
    from studio_workers import services

    monkeypatch.delenv("CHATTERBOX_VRAM_MB", raising=False)
    monkeypatch.delenv("GPU_RESERVE_MB", raising=False)
    assert cb.vram_mb() == 4500 and services.gpu_reserve_mb() == 800
    monkeypatch.setenv("CHATTERBOX_VRAM_MB", "3800")
    monkeypatch.setenv("GPU_RESERVE_MB", "500")
    assert cb.vram_mb() == 3800 and services.gpu_reserve_mb() == 500
    monkeypatch.setenv("CHATTERBOX_VRAM_MB", "mucho")
    monkeypatch.setenv("GPU_RESERVE_MB", "-3")
    assert cb.vram_mb() == 4500 and services.gpu_reserve_mb() == 800
