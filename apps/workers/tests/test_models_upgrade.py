"""Upgrade from sprint 3b (setup.ps1 -Update, «Modelos» step): models/manifest.json written by the
3b code, files already on disk. No network: every request fails the test.

Real failure: rvc_engine pinned rmvpe.pt to an exact size [S] (181 189 687 B) that the user's file
(downloaded + sha256-verified by 3b) did not have -> «corrupto» -> re-download -> exit 1, which
failed the Piper/Whisper step although nothing it asked for was missing.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from studio_workers import models_cli, packs
from studio_workers.downloads import Expected
from studio_workers.models_manifest import Manifest, verify_existing
from studio_workers.rvc_engine import RMVPE_MIN_BYTES
from studio_workers.vision import gpl

VOICE = "es_AR-daniela-high"
PIPER = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
LJ = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main"
RMVPE_REAL = 181_184_272  # any size != the old [S] constant 181 189 687
SHA = "ab" * 32


def _file(models: Path, files: dict, rel: str, size: int, group: str, source: str) -> None:
    path = models / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:  # sparse: 180 MB without writing them
        fh.write(b"\x01" * 64)
        fh.truncate(size)
    st = path.stat()
    files[rel] = {  # exactly the keys the 3b Manifest.record() wrote
        "name": path.name,
        "group": group,
        "path": rel,
        "size": st.st_size,
        "sha256": SHA,
        "source": source,
        "date": "2026-09-20T12:00:00+00:00",
        "mtime_ns": st.st_mtime_ns,
    }


def _install_3b(models: Path, rmvpe_size: int = RMVPE_REAL) -> None:
    files: dict = {}
    for name, size in ((f"{VOICE}.onnx", 2_000_000), (f"{VOICE}.onnx.json", 400)):
        _file(models, files, f"piper/{name}", size, f"piper:{VOICE}", f"{PIPER}/es/{name}")
    (models / "piper" / "voices.json").write_text(json.dumps({VOICE: {"files": {}}}), "utf-8")
    snap = "whisper/models--Systran--faster-whisper-base/snapshots/abc"
    for name in ("model.bin", "config.json"):
        _file(models, files, f"{snap}/{name}", 1000, "whisper:base", "https://huggingface.co/x")
    for rel, size in (
        ("rmvpe.pt", rmvpe_size),
        ("hubert_base/config.json", 2_000),
        ("hubert_base/preprocessor_config.json", 200),  # not in the sprint 4 registry any more
        ("hubert_base/pytorch_model.bin", 189_507_909),
    ):
        _file(models, files, f"rvc/_base/{rel}", size, "rvc:base", f"{LJ}/{rel}")
    _file(models, files, "yunet/face_detection_yunet_2023mar.onnx", packs.YUNET_SIZE,
          "reframe:yunet", packs.YUNET_URL)  # fmt: skip
    pack_ids = ("core", "rvc-base", "reframe", "stems", "matting-hq")
    data = {
        "version": 1,
        "updated": "2026-09-20T12:00:00+00:00",
        "files": files,
        "packs": {
            p: {"date": "2026-09-20T12:00:00+00:00", "files": 2, "pip": []} for p in pack_ids
        },
    }
    (models / "manifest.json").write_text(json.dumps(data, indent=2), "utf-8")


def _no_network(seen: list[str], status: int | None = None):  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if status is None:
            raise AssertionError(f"network used during the upgrade: {request.url}")
        return httpx.Response(status)

    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


SETUP_ARGS = ["--piper", VOICE, "--whisper", "base"]  # setup.ps1 «Modelos» (without -Full)


def test_setup_update_from_3b_needs_no_download(dirs, monkeypatch, tmp_path) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    _install_3b(models)
    seen: list[str] = []
    monkeypatch.setattr(models_cli, "_make_client", _no_network(seen))
    check = tmp_path / "models-check.json"
    assert models_cli.main([*SETUP_ARGS, "--check", "--update", "--report", str(check)]) == 0
    rep = json.loads(check.read_text("utf-8"))
    assert rep["missing"] == 0, [i for i in rep["items"] if i["state"] != "present"]
    assert {i["name"] for i in rep["items"]} >= {"rmvpe.pt", "hubert_base/pytorch_model.bin"}
    upd = tmp_path / "models-update.json"
    assert models_cli.main([*SETUP_ARGS, "--update", "--report", str(upd)]) == 0
    rep = json.loads(upd.read_text("utf-8"))
    assert rep["failed"] == 0 and rep["downloaded"] == 0
    assert seen == []
    # The old entries survive (preprocessor_config.json included) and the manifest stays valid.
    after = Manifest.load(models)
    assert "rvc/_base/hubert_base/preprocessor_config.json" in after.files
    assert after.get("rvc/_base/rmvpe.pt")["size"] == RMVPE_REAL
    assert packs.pack_status(packs.PACKS["rvc-base"], models)["installed"] is True


def test_unrequested_pack_file_failure_does_not_fail_piper_whisper(
    dirs, monkeypatch, tmp_path, capsys
) -> None:  # type: ignore[no-untyped-def]  # noqa: E501
    _, models = dirs
    _install_3b(models, rmvpe_size=1_000)  # really broken (truncated) and the network is down
    seen: list[str] = []
    monkeypatch.setattr(models_cli, "_make_client", _no_network(seen, status=503))
    upd = tmp_path / "models-update.json"
    assert models_cli.main([*SETUP_ARGS, "--update", "--report", str(upd)]) == 0
    rep = json.loads(upd.read_text("utf-8"))
    assert rep["failed"] == 1 and rep["failed_optional"] == 1
    failed = next(i for i in rep["items"] if i["action"] == "failed")
    assert failed["name"] == "rmvpe.pt" and failed["optional"] is True
    assert "models/rvc/_base/rmvpe.pt" in failed["error"]
    assert "AVISO" in capsys.readouterr().err
    # Asked for explicitly (-Full -> --rvc-base): then it IS an error.
    assert models_cli.main([*SETUP_ARGS, "--rvc-base", "--update"]) == 1
    assert "ERROR: rmvpe.pt (models/rvc/_base/rmvpe.pt)" in capsys.readouterr().err


def test_check_table_shows_the_size_on_disk_of_a_corrupt_file(dirs, monkeypatch, capsys) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    _install_3b(models, rmvpe_size=1_000)
    assert models_cli.main([*SETUP_ARGS, "--rvc-base", "--check", "--no-write"]) == 0
    out = capsys.readouterr().out
    assert "rvc/_base/rmvpe.pt: 1000 bytes en disco" in out


def test_rmvpe_is_not_pinned_to_an_unverified_exact_size(dirs) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    rmvpe = next(i for i in packs.PACKS["rvc-base"].build_items(models) if i.name == "rmvpe.pt")
    assert rmvpe.expected.size_bytes is None and rmvpe.expected.min_bytes == RMVPE_MIN_BYTES


def test_size_only_expectation_changed_after_a_verified_download(tmp_path: Path) -> None:
    path = tmp_path / "m.bin"
    path.write_bytes(b"x" * 100)
    st = path.stat()
    entry = {"size": 100, "sha256": SHA, "mtime_ns": st.st_mtime_ns}
    # Verified earlier (sha256 in the manifest) and no published hash: kept.
    assert verify_existing(path, Expected(size_bytes=120), entry)[0] == "present"
    # No manifest entry, or a published hash: the exact size still decides.
    assert verify_existing(path, Expected(size_bytes=120), None)[0] == "corrupt"
    assert verify_existing(path, Expected(size_bytes=120, sha256="cd" * 32), entry)[0] == "corrupt"
    # The file changed since it was verified: corrupt.
    assert verify_existing(path, Expected(size_bytes=120), {**entry, "size": 99})[0] == "corrupt"


def test_faceswap_never_downloaded_is_missing_not_partial(dirs) -> None:  # type: ignore[no-untyped-def]
    """YuNet (+ OpenCV) of the reframe pack are also in faceswap: they do not make it «parcial»."""
    _, models = dirs
    _install_3b(models)
    for pid in ("faceswap", "faceswap-extra", "tts-chatterbox"):
        st = packs.pack_status(packs.PACKS[pid], models)
        assert st["installed"] is False and st["partial"] is False, pid
    assert packs.pack_status(packs.PACKS["reframe"], models)["partial"] is False
    # A file of its own on disk still makes it partial.
    own = next(
        i for i in packs.PACKS["faceswap"].build_items(models) if i.rel.endswith(".onnx")
        and "yunet" not in i.rel
    )  # fmt: skip
    (models / own.rel).parent.mkdir(parents=True, exist_ok=True)
    (models / own.rel).write_bytes(b"x" * 10)
    assert packs.pack_status(packs.PACKS["faceswap"], models)["partial"] is True


def test_gpl_venv_ready_but_torch_broken_is_repaired(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """setup.ps1 said «.venv-gpl [omitido] ready» while doctor said «import torch fallo»."""
    venv = tmp_path / ".venv-gpl"
    py = gpl.venv_python(venv)
    py.parent.mkdir(parents=True)
    py.write_text("")
    (venv / gpl.STAMP).write_text(gpl._stamp_line(False) + "\n", "utf-8")
    site = tmp_path / "site"
    site.mkdir()
    (site / gpl.SHARE_PTH).write_text("C:\\old\\folder\\.venv\\Lib\\site-packages\n", "utf-8")
    monkeypatch.setattr(gpl, "_site_packages", lambda _py: site)
    calls: list[list[str]] = []
    broken = {"torch": True}

    def runner(cmd: list[str], on_line) -> int:  # type: ignore[no-untyped-def]
        calls.append(cmd)
        if cmd[1] == "-c":
            if broken["torch"]:
                on_line("ModuleNotFoundError: No module named 'torch'")
                return 1
            return 0
        broken["torch"] = False  # pip + fresh .pth repaired it
        return 0

    assert gpl.status(venv)["state"] == "ready"
    lines: list[str] = []
    assert gpl.ensure_venv(venv, use_cuda=False, on_line=lines.append, runner=runner,
                           share_torch=True) == "ejecutado"  # fmt: skip
    assert any("No module named 'torch'" in ln for ln in lines)
    assert "old" not in (site / gpl.SHARE_PTH).read_text("utf-8")  # .pth rewritten
    assert any(c[1:3] == ["-m", "pip"] for c in calls)
    calls.clear()
    assert gpl.ensure_venv(venv, use_cuda=False, runner=runner) == "omitido"
    assert len(calls) == 1  # only the import check


@pytest.mark.parametrize("voice", [VOICE])
def test_setup_defaults_match_the_registry(voice: str) -> None:
    """setup.ps1's default Piper voice / Whisper size are still valid registry names."""
    from studio_workers.stt.engine import WHISPER_MODELS
    from studio_workers.tts.piper_catalog import CATALOG

    setup = (Path(__file__).resolve().parents[3] / "scripts/windows/setup.ps1").read_text("utf-8")
    assert f"'PIPER_DEFAULT_VOICE' '{voice}'" in setup and voice in CATALOG
    assert "[string]$WhisperModel = 'base'" in setup and "base" in WHISPER_MODELS


def test_packs_list_tolerates_a_voices_json_without_a_voice(dirs, caplog) -> None:  # type: ignore[no-untyped-def]
    """A cached voices.json that lacks a voice of voces-es must not crash --packs list."""
    _, models = dirs
    _install_3b(models)  # its voices.json only has es_AR-daniela-high
    with caplog.at_level("WARNING", logger="studio_workers"):
        rows = {r["id"]: r for r in packs.list_packs(models)}
    assert rows["voces-es"]["installed"] is False and rows["core"]["installed"] is True
    assert "voices.json has no voice" in caplog.text
    assert models_cli.main(["--packs", "list"]) == 0
